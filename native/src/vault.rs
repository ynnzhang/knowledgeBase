use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
};
use uuid::Uuid;
use walkdir::WalkDir;

pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn hidden(name: &str) -> bool {
    name.starts_with('.') || name == "node_modules" || name.ends_with(".assets")
}
pub fn markdown(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|x| x.to_str())
            .unwrap_or("")
            .to_lowercase()
            .as_str(),
        "md" | "mdown"
    )
}
pub fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
#[derive(Debug)]
pub struct Conflict;
impl std::fmt::Display for Conflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "笔记已被其他窗口或程序修改，已保留当前输入，请重新打开原文核对后再保存。"
        )
    }
}
impl std::error::Error for Conflict {}

pub fn atomic_write(file: &Path, bytes: &[u8]) -> Result<()> {
    let parent = file.parent().context("文件没有父目录")?;
    let temp = parent.join(format!(".zhixu-{}.tmp", Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut handle = options.open(&temp)?;
        handle.write_all(bytes)?;
        handle.sync_all()?;
        drop(handle);
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::Storage::FileSystem::{
                MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
            };
            let src: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
            let dst: Vec<u16> = file.as_os_str().encode_wide().chain(Some(0)).collect();
            if unsafe {
                MoveFileExW(
                    src.as_ptr(),
                    dst.as_ptr(),
                    MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
                )
            } == 0
            {
                return Err(std::io::Error::last_os_error().into());
            }
        }
        #[cfg(not(windows))]
        {
            fs::rename(&temp, file)?;
            File::open(parent)?.sync_all()?;
        }
        Ok(())
    })();
    let _ = fs::remove_file(temp);
    result
}

// Verify every component. Canonicalization alone would allow symlinks back into
// the vault and create a different behavior from file/sync operations.
pub fn safe_path(
    root: &Path,
    relative: &str,
    allow_missing: bool,
    assets: bool,
) -> Result<PathBuf> {
    if relative.contains('\\') || relative.contains('\0') || Path::new(relative).is_absolute() {
        bail!("路径必须在知识库内")
    }
    let mut result = root.to_path_buf();
    let parts: Vec<_> = Path::new(relative).components().collect();
    for (i, part) in parts.iter().enumerate() {
        let Component::Normal(name) = part else {
            bail!("路径必须在知识库内")
        };
        let name = name.to_string_lossy();
        if name.starts_with('.') || name == "node_modules" || (!assets && name.ends_with(".assets"))
        {
            bail!("不能访问私有目录")
        }
        result.push(name.as_ref());
        match fs::symlink_metadata(&result) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    bail!("不允许符号链接")
                };
                if i + 1 < parts.len() && !meta.is_dir() {
                    bail!("路径不是文件夹")
                }
            }
            Err(e)
                if e.kind() == std::io::ErrorKind::NotFound
                    && allow_missing
                    && i + 1 == parts.len() => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(result)
}

// The same exclusive lock is used by the existing Feishu transaction worker.
// Keep it short-lived for native writes, so two runtimes cannot write concurrently.
pub struct SyncLease {
    path: PathBuf,
    file: Option<File>,
}
impl SyncLease {
    pub fn acquire(root: &Path) -> Result<Self> {
        let private = root.join(".zhixu-feishu");
        if fs::symlink_metadata(&private).is_ok_and(|m| m.file_type().is_symlink()) {
            bail!("同步状态目录不能是符号链接")
        }
        fs::create_dir_all(&private)?;
        let path = private.join("sync.lock");
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&path).context(
            "知识库正在同步或移动；若上次异常退出，请确认任务结束后处理 .zhixu-feishu/sync.lock",
        )?;
        if let Err(error) = write!(file, "{}", std::process::id()) {
            drop(file);
            let _ = fs::remove_file(&path);
            return Err(error.into());
        }
        Ok(Self {
            path,
            file: Some(file),
        })
    }
}
impl Drop for SyncLease {
    fn drop(&mut self) {
        drop(self.file.take());
        let _ = fs::remove_file(&self.path);
    }
}

pub fn frontmatter(raw: &str) -> (&str, &str) {
    let Some(first) = raw.find('\n') else {
        return ("", raw);
    };
    if raw[..first].trim() != "---" {
        return ("", raw);
    }
    let mut pos = first + 1;
    for line in raw[pos..].split_inclusive('\n') {
        if line.trim() == "---" {
            let end = pos + line.len();
            return (&raw[..end], &raw[end..]);
        }
        pos += line.len();
    }
    ("", raw)
}
pub fn updated_body(raw: &str, body: &str) -> Result<String> {
    if body.len() > 5_000_000 {
        bail!("笔记正文过大，无法保存")
    }
    let (prefix, _) = frontmatter(raw);
    if prefix.is_empty() {
        return Ok(format!(
            "---\nupdated: {}\n---\n\n{}",
            Utc::now().format("%Y-%m-%d"),
            body.trim_start_matches('\n')
        ));
    }
    let first = prefix.find('\n').unwrap() + 1;
    let close = prefix.rfind("---").unwrap();
    let yaml = &prefix[first..close];
    let value: serde_yaml::Value =
        serde_yaml::from_str(yaml).context("YAML 元数据格式有误，无法安全保存")?;
    if !value.is_mapping() && !value.is_null() {
        bail!("YAML 元数据必须为对象")
    }
    let re = regex::Regex::new(r"(?m)^updated:[^\r\n]*").unwrap();
    let date = format!("updated: {}", Utc::now().format("%Y-%m-%d"));
    let next = if re.is_match(yaml) {
        re.replace(yaml, date.as_str()).to_string()
    } else {
        format!("{}{}\n", yaml, date)
    };
    Ok(format!(
        "---\n{}---\n\n{}",
        next,
        body.trim_start_matches('\n')
    ))
}

fn short_term(chars: &[char]) -> String {
    chars
        .iter()
        .map(|c| format!("{:x}", *c as u32))
        .collect::<Vec<_>>()
        .join("x")
}
fn short_tokens(content: &str) -> String {
    let chars: Vec<_> = content.to_lowercase().chars().collect();
    let singles: std::collections::HashSet<_> = chars.iter().copied().collect();
    let pairs: std::collections::HashSet<_> = chars.windows(2).map(|p| (p[0], p[1])).collect();
    singles
        .into_iter()
        .map(|c| short_term(&[c]))
        .chain(pairs.into_iter().map(|(a, b)| short_term(&[a, b])))
        .collect::<Vec<_>>()
        .join(" ")
}

fn stamp(meta: &fs::Metadata) -> Result<String> {
    let base = format!(
        "{}:{:?}:{:?}",
        meta.len(),
        meta.modified()?,
        meta.created().ok()
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(format!(
            "{base}:{}:{}:{}:{}",
            meta.dev(),
            meta.ino(),
            meta.ctime(),
            meta.ctime_nsec()
        ))
    }
    #[cfg(not(unix))]
    {
        Ok(base)
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub id: String,
    pub name: String,
    pub path: String,
    pub raw: String,
    pub modified: String,
    pub source: String,
    pub version: String,
    pub body_loaded: bool,
    pub word_count: usize,
}
#[derive(Clone, Serialize, Deserialize)]
struct Cached {
    stamp: String,
    summary: Summary,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Change {
    revision: u64,
    notes: Vec<Summary>,
    removed: Vec<String>,
}
pub struct Vault {
    pub root: PathBuf,
    cache: BTreeMap<String, Cached>,
    pub folders: BTreeSet<String>,
    pub revision: u64,
    pub epoch: String,
    pub generated_at: String,
    pub error: Option<String>,
    changes: VecDeque<Change>,
    db: Connection,
    pub reads: usize,
    _lock: File,
}
impl Vault {
    pub fn open(root: PathBuf) -> Result<Self> {
        if !root.is_dir() {
            bail!("知识库目录不存在")
        }
        let private = root.join(".zhixu-native");
        if fs::symlink_metadata(&private).is_ok_and(|m| m.file_type().is_symlink()) {
            bail!("索引目录不能是符号链接")
        }
        fs::create_dir_all(&private)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&private, fs::Permissions::from_mode(0o700))?;
        }
        for name in [
            "vault.lock",
            "index.sqlite",
            "index.sqlite-wal",
            "index.sqlite-shm",
        ] {
            if fs::symlink_metadata(private.join(name)).is_ok_and(|m| m.file_type().is_symlink()) {
                bail!("索引文件不能是符号链接")
            }
        }
        let lease = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(private.join("vault.lock"))?;
        fs2::FileExt::try_lock_exclusive(&lease)
            .context("该知识库已被另一个 Rust 服务打开，请先关闭原服务")?;
        let db = Connection::open(private.join("index.sqlite"))?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; CREATE TABLE IF NOT EXISTS catalog(path TEXT PRIMARY KEY, cached TEXT NOT NULL); CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(path UNINDEXED, content, tokenize='trigram'); CREATE VIRTUAL TABLE IF NOT EXISTS short_search USING fts5(tokens);")?;
        if db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))? != 1 {
            db.execute_batch("BEGIN;DELETE FROM catalog;DELETE FROM search;DELETE FROM short_search;PRAGMA user_version=1;COMMIT;")?;
        }
        let mut cache = BTreeMap::new();
        {
            let mut statement = db.prepare("SELECT path,cached FROM catalog")?;
            let rows = statement
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            for row in rows {
                let (path, cached) = row?;
                cache.insert(path,serde_json::from_str(&cached).context("索引缓存损坏；停止服务后可删除 .zhixu-native/index.sqlite* 重建，原笔记不受影响")?);
            }
        }
        let mut vault = Self {
            root,
            cache,
            folders: BTreeSet::new(),
            revision: 0,
            epoch: Uuid::new_v4().to_string(),
            generated_at: now(),
            error: None,
            changes: VecDeque::new(),
            db,
            reads: 0,
            _lock: lease,
        };
        if let Err(error) = vault.reconcile() {
            if vault.cache.is_empty() {
                return Err(error);
            }
            vault.error = Some(error.to_string());
        }
        Ok(vault)
    }
    fn read_summary(&mut self, relative: &str) -> Result<(Cached, String)> {
        let file = safe_path(&self.root, relative, false, false)?;
        let before = fs::metadata(&file)?;
        let raw = fs::read_to_string(&file)?;
        self.reads += 1;
        let after = fs::metadata(&file)?;
        if stamp(&before)? != stamp(&after)? {
            bail!("笔记正在被其他程序写入")
        }
        let (prefix, body) = frontmatter(&raw);
        let heading = body
            .lines()
            .find(|line| line.starts_with("# "))
            .unwrap_or("");
        let summary = Summary {
            id: format!("local-{relative}"),
            name: file.file_name().unwrap().to_string_lossy().to_string(),
            path: relative.to_string(),
            raw: format!("{prefix}\n{heading}"),
            modified: DateTime::<Utc>::from(after.modified()?)
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            source: "local".into(),
            version: hash(raw.as_bytes()),
            body_loaded: false,
            word_count: body.chars().filter(|c| !c.is_whitespace()).count(),
        };
        let search = format!("{relative}\n{raw}");
        Ok((
            Cached {
                stamp: stamp(&after)?,
                summary,
            },
            search,
        ))
    }
    fn record(&mut self, notes: Vec<Summary>, removed: Vec<String>) {
        self.revision += 1;
        self.generated_at = now();
        self.changes.push_back(Change {
            revision: self.revision,
            notes,
            removed,
        });
        if self.changes.len() > 256 {
            self.changes.pop_front();
        }
    }
    pub fn reconcile(&mut self) -> Result<()> {
        // Stage all reads before changing the published catalog/search index.
        let mut files = BTreeSet::new();
        let mut folders = BTreeSet::new();
        let mut staged = Vec::new();
        for entry in WalkDir::new(&self.root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| e.depth() == 0 || !hidden(&e.file_name().to_string_lossy()))
        {
            let entry = entry?;
            if entry.depth() == 0 || entry.file_type().is_symlink() {
                continue;
            }
            let relative = entry
                .path()
                .strip_prefix(&self.root)?
                .to_string_lossy()
                .replace('\\', "/");
            if entry.file_type().is_dir() {
                folders.insert(relative);
                continue;
            }
            if !markdown(entry.path()) {
                continue;
            }
            let meta = entry.metadata()?;
            files.insert(relative.clone());
            let stamp = stamp(&meta)?;
            if self
                .cache
                .get(&relative)
                .is_none_or(|old| old.stamp != stamp)
            {
                let (cached, search) = self.read_summary(&relative)?;
                staged.push((relative, cached, search));
            }
        }
        let removed: Vec<_> = self
            .cache
            .keys()
            .filter(|p| !files.contains(*p))
            .cloned()
            .collect();
        if staged.is_empty()
            && removed.is_empty()
            && folders == self.folders
            && self.error.is_none()
        {
            return Ok(());
        }
        let tx = self.db.transaction()?;
        for (relative, cached, search) in &staged {
            Self::index_row(&tx, relative, cached, search)?;
        }
        for relative in &removed {
            tx.execute(
                "DELETE FROM search WHERE rowid=(SELECT rowid FROM catalog WHERE path=?1)",
                [relative],
            )?;
            tx.execute(
                "DELETE FROM short_search WHERE rowid=(SELECT rowid FROM catalog WHERE path=?1)",
                [relative],
            )?;
            tx.execute("DELETE FROM catalog WHERE path=?1", [relative])?;
        }
        tx.commit()?;
        let mut notes = Vec::new();
        for (relative, cached, _) in staged {
            notes.push(cached.summary.clone());
            self.cache.insert(relative, cached);
        }
        for path in &removed {
            self.cache.remove(path);
        }
        self.folders = folders;
        self.error = None;
        self.record(notes, removed);
        Ok(())
    }
    fn index_row(
        tx: &rusqlite::Transaction<'_>,
        relative: &str,
        cached: &Cached,
        search: &str,
    ) -> Result<()> {
        tx.execute(
            "DELETE FROM search WHERE rowid=(SELECT rowid FROM catalog WHERE path=?1)",
            [relative],
        )?;
        tx.execute(
            "DELETE FROM short_search WHERE rowid=(SELECT rowid FROM catalog WHERE path=?1)",
            [relative],
        )?;
        tx.execute("INSERT INTO catalog(path,cached) VALUES (?1,?2) ON CONFLICT(path) DO UPDATE SET cached=excluded.cached",params![relative,serde_json::to_string(cached)?])?;
        tx.execute("INSERT INTO search(rowid,path,content) SELECT rowid,path,?2 FROM catalog WHERE path=?1",params![relative,search])?;
        tx.execute(
            "INSERT INTO short_search(rowid,tokens) SELECT rowid,?2 FROM catalog WHERE path=?1",
            params![relative, short_tokens(search)],
        )?;
        Ok(())
    }
    pub fn refresh(&mut self, relative: &str) -> Result<Summary> {
        let (cached, search) = self.read_summary(relative)?;
        let tx = self.db.transaction()?;
        Self::index_row(&tx, relative, &cached, &search)?;
        tx.commit()?;
        let summary = cached.summary.clone();
        self.cache.insert(relative.into(), cached);
        self.record(vec![summary.clone()], vec![]);
        Ok(summary)
    }
    pub fn index(&self, since: Option<u64>, epoch: Option<&str>) -> Value {
        let full = epoch != Some(self.epoch.as_str())
            || since.is_none()
            || since.unwrap_or(0) > self.revision
            || self
                .changes
                .front()
                .is_some_and(|c| since.unwrap_or(0) + 1 < c.revision);
        let (notes, removed) = if full {
            (
                self.cache
                    .values()
                    .map(|c| c.summary.clone())
                    .collect::<Vec<_>>(),
                vec![],
            )
        } else {
            let mut changed = BTreeMap::new();
            let mut removed = BTreeSet::new();
            for c in self
                .changes
                .iter()
                .filter(|c| c.revision > since.unwrap_or(0))
            {
                for p in &c.removed {
                    changed.remove(p);
                    removed.insert(p.clone());
                }
                for n in &c.notes {
                    removed.remove(&n.path);
                    changed.insert(n.path.clone(), n.clone());
                }
            }
            (
                changed.into_values().collect(),
                removed.into_iter().collect(),
            )
        };
        json!({"workspace":self.root,"generatedAt":self.generated_at,"epoch":self.epoch,"revision":self.revision,"full":full,"notes":notes,"removed":removed,"folders":self.folders,"error":self.error,"engine":"rust"})
    }
    pub fn note(&self, relative: &str) -> Result<Value> {
        let file = safe_path(&self.root, relative, false, false)?;
        if !markdown(&file) {
            bail!("请选择 Markdown 笔记")
        }
        let raw = fs::read_to_string(&file)?;
        let modified: DateTime<Utc> = fs::metadata(file)?.modified()?.into();
        Ok(
            json!({"raw":raw,"version":hash(raw.as_bytes()),"modified":modified.to_rfc3339_opts(chrono::SecondsFormat::Millis,true)}),
        )
    }
    pub fn save(&mut self, relative: &str, body: &str, version: &str) -> Result<Value> {
        let _lease = SyncLease::acquire(&self.root)?;
        let file = safe_path(&self.root, relative, false, false)?;
        if !markdown(&file) {
            bail!("请选择 Markdown 笔记")
        }
        let raw = fs::read_to_string(&file)?;
        if version.is_empty() || hash(raw.as_bytes()) != version {
            return Err(Conflict.into());
        }
        let next = updated_body(&raw, body)?;
        // Detect edits made by external editors while preparing frontmatter.
        if fs::read_to_string(&file)? != raw {
            return Err(Conflict.into());
        }
        atomic_write(&file, next.as_bytes())?;
        let summary = self.refresh(relative)?;
        Ok(
            json!({"ok":true,"raw":next,"version":summary.version,"modified":summary.modified,"summary":summary}),
        )
    }
    pub fn search(&self, query: &str) -> Result<Vec<String>> {
        if query.trim().is_empty() {
            return Ok(self.cache.keys().cloned().collect());
        }
        let escaped = query.replace('"', "\"\"");
        let (sql, term) = if query.chars().count() >= 3 {
            (
                "SELECT path FROM search WHERE content MATCH ?1",
                format!("\"{escaped}\""),
            )
        } else {
            (
                "SELECT path FROM catalog WHERE rowid IN (SELECT rowid FROM short_search WHERE short_search MATCH ?1)",
                short_term(&query.to_lowercase().chars().collect::<Vec<_>>()),
            )
        };
        let mut statement = self.db.prepare(sql)?;
        let rows = statement.query_map([term], |row| row.get::<_, String>(0))?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }
    pub fn is_empty(&self) -> bool {
        self.cache.is_empty()
    }
    pub fn len(&self) -> usize {
        self.cache.len()
    }
}
