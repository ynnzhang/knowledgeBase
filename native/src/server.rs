use crate::{
    compat::Compat,
    vault::{self, Conflict, Vault},
};
use anyhow::{bail, Context, Result};
use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Query, Request, State},
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use notify::Watcher;
use rust_embed::RustEmbed;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tower_http::compression::CompressionLayer;
#[derive(RustEmbed)]
#[folder = "../dist/native-ui/"]
struct Assets;
#[derive(Clone)]
pub struct AppState {
    pub vault: Arc<Mutex<Vault>>,
    pub compat: Arc<Mutex<Compat>>,
    pub mutation: Arc<tokio::sync::Mutex<()>>,
    pub project: PathBuf,
    pub port: u16,
    pub requests: Arc<tokio::sync::Semaphore>,
}
#[derive(Debug)]
struct Error(anyhow::Error);
impl<E: Into<anyhow::Error>> From<E> for Error {
    fn from(e: E) -> Self {
        Self(e.into())
    }
}
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let status = if self.0.is::<Conflict>() {
            StatusCode::CONFLICT
        } else {
            StatusCode::BAD_REQUEST
        };
        (status, Json(json!({"error":self.0.to_string()}))).into_response()
    }
}
type Api<T> = std::result::Result<Json<T>, Error>;
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tokio::task::spawn_blocking(f).await?
}
fn lock<T>(v: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>> {
    v.lock()
        .map_err(|_| anyhow::anyhow!("服务状态异常，请重新启动"))
}

async fn guard(State(s): State<AppState>, req: Request, next: Next) -> Response {
    let Ok(_admission) = s.requests.clone().try_acquire_owned() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            [("Retry-After", "1")],
            Json(json!({"error":"本地服务正忙，请稍后重试"})),
        )
            .into_response();
    };
    let _mutation = if req.method() == axum::http::Method::POST {
        Some(s.mutation.clone().lock_owned().await)
    } else {
        None
    };
    let host = req
        .headers()
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let hosts = [
        format!("127.0.0.1:{}", s.port),
        format!("localhost:{}", s.port),
    ];
    let mut allowed = hosts.iter().any(|v| v == host);
    if let Some(origin) = req.headers().get("origin").and_then(|v| v.to_str().ok()) {
        allowed &= [
            format!("http://{host}"),
            "http://localhost:3000".into(),
            "http://127.0.0.1:3000".into(),
        ]
        .contains(&origin.to_string());
    }
    if req
        .headers()
        .get("sec-fetch-site")
        .is_some_and(|v| v == "cross-site")
    {
        allowed = false
    }
    if !allowed {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error":"只允许从本机知识库访问"})),
        )
            .into_response();
    }
    if let Some(token) = req
        .headers()
        .get("x-zhixu-workspace")
        .and_then(|v| v.to_str().ok())
    {
        let expected = percent_encoding::percent_decode_str(token)
            .decode_utf8_lossy()
            .into_owned();
        let vault = s.vault.clone();
        let matches = blocking(move || Ok(lock(&vault)?.root.to_string_lossy() == expected))
            .await
            .unwrap_or(false);
        if !matches {
            return (
                StatusCode::CONFLICT,
                Json(json!({"error":"知识库已切换，请保留输入并刷新页面"})),
            )
                .into_response();
        }
    }
    let mut response = next.run(req).await;
    response
        .headers_mut()
        .insert("X-Content-Type-Options", "nosniff".parse().unwrap());
    response
        .headers_mut()
        .insert("Cache-Control", "no-store".parse().unwrap());
    response
}
#[derive(Deserialize)]
struct IndexQuery {
    since: Option<u64>,
    epoch: Option<String>,
}
async fn index(
    State(s): State<AppState>,
    Query(q): Query<IndexQuery>,
    headers: HeaderMap,
) -> Result<Response, Error> {
    let (etag, payload) = blocking(move || {
        let v = lock(&s.vault)?;
        let etag = format!("\"{}-{}-{}\"", v.epoch, v.revision, v.error.is_some());
        let payload = if headers
            .get("if-none-match")
            .is_some_and(|h| h == etag.as_str())
        {
            None
        } else {
            Some(v.index(q.since, q.epoch.as_deref()))
        };
        Ok((etag, payload))
    })
    .await?;
    let mut response = if let Some(payload) = payload {
        Json(payload).into_response()
    } else {
        StatusCode::NOT_MODIFIED.into_response()
    };
    response.headers_mut().insert("etag", etag.parse()?);
    Ok(response)
}
#[derive(Deserialize)]
struct NoteQuery {
    path: String,
}
async fn note(State(s): State<AppState>, Query(q): Query<NoteQuery>) -> Api<Value> {
    Ok(Json(blocking(move || lock(&s.vault)?.note(&q.path)).await?))
}
#[derive(Deserialize)]
struct SearchQuery {
    q: String,
}
async fn search(State(s): State<AppState>, Query(q): Query<SearchQuery>) -> Api<Value> {
    if q.q.len() > 1024 {
        bail_api("搜索内容过长")?;
    }
    Ok(Json(
        blocking(move || Ok(json!({"paths":lock(&s.vault)?.search(&q.q)?}))).await?,
    ))
}
fn bail_api(msg: &str) -> Result<()> {
    bail!("{msg}")
}
async fn health(State(s): State<AppState>) -> Api<Value> {
    Ok(Json(blocking(move||{let v=lock(&s.vault)?;Ok(json!({"ok":true,"service":"zhixu-notes","engine":"rust","projectRoot":s.project,"notesRoot":v.root,"notes":v.len(),"revision":v.revision}))}).await?))
}
async fn ready(State(s): State<AppState>) -> Result<Response, Error> {
    let ready = blocking(move || Ok(lock(&s.vault)?.error.is_none())).await?;
    Ok((
        if ready {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        Json(json!({"ok":ready,"service":"zhixu-notes","engine":"rust"})),
    )
        .into_response())
}
#[derive(Deserialize)]
struct Save {
    path: String,
    body: String,
    version: Option<String>,
}
async fn save(State(s): State<AppState>, Json(p): Json<Save>) -> Api<Value> {
    Ok(Json(
        blocking(move || {
            if lock(&s.compat)?.busy {
                bail!("飞书同步正在进行，请稍后保存")
            };
            lock(&s.vault)?.save(&p.path, &p.body, p.version.as_deref().unwrap_or(""))
        })
        .await?,
    ))
}
async fn tags(State(s): State<AppState>, Json(p): Json<Value>) -> Api<Value> {
    Ok(Json(
        blocking(move || {
            let path = p["path"].as_str().context("缺少笔记路径")?;
            {
                let v = lock(&s.vault)?;
                vault::safe_path(&v.root, path, false, false)?;
                if let Some(version) = p["version"].as_str() {
                    if v.note(path)?["version"] != version {
                        return Err(Conflict.into());
                    }
                }
            }
            let _lease = vault::SyncLease::acquire(&lock(&s.vault)?.root)?;
            let mut result = lock(&s.compat)?.call(json!({"method":"tags","payload":p}))?;
            let summary = lock(&s.vault)?.refresh(path)?;
            result["modified"] = json!(summary.modified);
            result["version"] = json!(summary.version);
            result["summary"] = json!(summary);
            Ok(result)
        })
        .await?,
    ))
}
async fn files(State(s): State<AppState>, Json(p): Json<Value>) -> Api<Value> {
    Ok(Json(
        blocking(move || {
            let mut result = lock(&s.compat)?.call(json!({"method":"files","payload":p}))?;
            let mut v = lock(&s.vault)?;
            v.reconcile()?;
            result["index"] = v.index(None, None);
            Ok(result)
        })
        .await?,
    ))
}
async fn feishu_status(State(s): State<AppState>, Query(q): Query<Value>) -> Api<Value> {
    Ok(Json(
        blocking(move || {
            let mut c = lock(&s.compat)?;
            let was_busy = c.busy;
            let result = c.call(json!({"method":"status","path":q["path"]}))?;
            if was_busy && !c.busy {
                lock(&s.vault)?.reconcile()?;
            }
            Ok(result)
        })
        .await?,
    ))
}
async fn feishu_config(State(s): State<AppState>, Json(p): Json<Value>) -> Api<Value> {
    Ok(Json(
        blocking(move || lock(&s.compat)?.call(json!({"method":"config","payload":p}))).await?,
    ))
}
async fn feishu_start(State(s): State<AppState>, Json(p): Json<Value>) -> Api<Value> {
    Ok(Json(
        blocking(move || lock(&s.compat)?.call(json!({"method":"start","payload":p}))).await?,
    ))
}
async fn workspace(State(s): State<AppState>, Json(p): Json<Value>) -> Api<Value> {
    switch(
        s,
        PathBuf::from(p["path"].as_str().context("请输入文件夹路径")?),
    )
    .await
}
async fn select_workspace(State(s): State<AppState>) -> Api<Value> {
    let chosen = rfd::AsyncFileDialog::new().pick_folder().await;
    if let Some(file) = chosen {
        switch(s, file.path().into()).await
    } else {
        Ok(Json(json!({"cancelled":true})))
    }
}
async fn switch(s: AppState, root: PathBuf) -> Api<Value> {
    Ok(Json(
        blocking(move || {
            let root = dunce::canonicalize(root)?;
            {
                let v = lock(&s.vault)?;
                if v.root == root {
                    return Ok(json!({"ok":true,"workspace":root,"index":v.index(None,None)}));
                }
            }
            let next = Vault::open(root.clone())?;
            lock(&s.compat)?.switch(&root)?;
            vault::atomic_write(
                &s.project.join(".knowledge-base.local.json"),
                serde_json::to_vec(&json!({"notesRoot":root}))?.as_slice(),
            )?;
            let result = next.index(None, None);
            *lock(&s.vault)? = next;
            Ok(json!({"ok":true,"workspace":root,"index":result}))
        })
        .await?,
    ))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImageQuery {
    note_path: String,
    src: Option<String>,
    workspace: Option<String>,
}
async fn image(State(s): State<AppState>, Query(q): Query<ImageQuery>) -> Result<Response, Error> {
    let (bytes, mime, etag) = blocking(move || {
        let v = lock(&s.vault)?;
        if let Some(token) = q.workspace {
            if percent_encoding::percent_decode_str(&token).decode_utf8_lossy()
                != v.root.to_string_lossy()
            {
                bail!("知识库已切换")
            }
        }
        vault::safe_path(&v.root, &q.note_path, false, false)?;
        let src = q
            .src
            .context("缺少图片地址")?
            .trim_matches(['<', '>'])
            .replace('\\', "/");
        let src = src.split(['?', '#']).next().unwrap();
        let decoded = percent_encoding::percent_decode_str(src).decode_utf8()?;
        let base = url::Url::parse(&format!("http://vault/{}", q.note_path))?;
        let url = base.join(&decoded)?;
        if url.host_str() != Some("vault") || url.scheme() != "http" {
            bail!("图片必须在知识库内")
        }
        let relative = percent_encoding::percent_decode_str(url.path().trim_start_matches('/'))
            .decode_utf8()?;
        let file = vault::safe_path(&v.root, &relative, false, true)?;
        let mime = mime_guess::from_path(&file)
            .first_or_octet_stream()
            .to_string();
        if ![
            "image/png",
            "image/jpeg",
            "image/gif",
            "image/webp",
            "image/avif",
            "image/bmp",
        ]
        .contains(&mime.as_str())
        {
            bail!("不是图片")
        }
        let bytes = fs::read(file)?;
        let etag = vault::hash(&bytes);
        Ok((bytes, mime, etag))
    })
    .await?;
    Ok((
        [("Content-Type", mime), ("ETag", format!("\"{etag}\""))],
        bytes,
    )
        .into_response())
}
async fn upload(
    State(s): State<AppState>,
    Query(q): Query<ImageQuery>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Api<Value> {
    Ok(Json(
        blocking(move || {
            if lock(&s.compat)?.busy {
                bail!("飞书同步正在进行")
            }
            let mime = headers
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .split(';')
                .next()
                .unwrap();
            let ext = match mime {
                "image/png" => "png",
                "image/jpeg" => "jpg",
                "image/gif" => "gif",
                "image/webp" => "webp",
                "image/avif" => "avif",
                "image/bmp" => "bmp",
                _ => bail!("不支持的图片格式"),
            };
            if bytes.is_empty() || bytes.len() > 20_000_000 {
                bail!("图片为空或超过20 MB")
            }
            let v = lock(&s.vault)?;
            let file = vault::safe_path(&v.root, &q.note_path, false, false)?;
            let _lease = vault::SyncLease::acquire(&v.root)?;
            let folder = format!("{}.assets", file.file_stem().unwrap().to_string_lossy());
            let relative = file
                .parent()
                .unwrap()
                .strip_prefix(&v.root)?
                .join(&folder)
                .to_string_lossy()
                .replace('\\', "/");
            let dir = vault::safe_path(&v.root, &relative, true, true)?;
            fs::create_dir_all(&dir)?;
            let name = format!("image-{}.{}", uuid::Uuid::new_v4(), ext);
            vault::atomic_write(&dir.join(&name), &bytes)?;
            Ok(json!({"url":format!("./{folder}/{name}")}))
        })
        .await?,
    ))
}
async fn asset(req: Request) -> Response {
    let name = req.uri().path().trim_start_matches('/');
    let key = if name.is_empty() { "index.html" } else { name };
    match Assets::get(key) {
        Some(file) => {
            let mime = mime_guess::from_path(key)
                .first_or_octet_stream()
                .to_string();
            let cache = if key.starts_with("assets/") {
                "public, max-age=31536000, immutable"
            } else {
                "no-cache"
            };
            (
                [("Content-Type", mime), ("Cache-Control", cache.into())],
                file.data.to_vec(),
            )
                .into_response()
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}
pub fn app(state: AppState) -> Router {
    let api = Router::new()
        .route("/index", get(index))
        .route("/notes/read", get(note))
        .route("/search", get(search))
        .route("/notes/content", post(save))
        .route("/notes/tags", post(tags))
        .route("/notes/images", post(upload))
        .route("/assets", get(image))
        .route("/files", post(files))
        .route("/health", get(health))
        .route("/ready", get(ready))
        .route("/workspace/open", post(workspace))
        .route("/workspace/select", post(select_workspace))
        .route("/feishu/status", get(feishu_status))
        .route("/feishu/config", post(feishu_config))
        .route("/feishu/jobs", post(feishu_start))
        .layer(middleware::from_fn_with_state(state.clone(), guard));
    Router::new()
        .nest("/local-api", api)
        .route(
            "/api/health",
            get(|| async { Json(json!({"ok":true,"service":"zhixu-site","engine":"rust"})) }),
        )
        .fallback(asset)
        .layer(DefaultBodyLimit::max(21_000_000))
        .layer(CompressionLayer::new())
        .with_state(state)
}
pub fn watcher(state: AppState) -> Result<std::thread::JoinHandle<()>> {
    let (tx, rx) = std::sync::mpsc::channel();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let _ = tx.send(event);
    })?;
    let mut root = lock(&state.vault)?.root.clone();
    watcher.watch(&root, notify::RecursiveMode::Recursive)?;
    Ok(std::thread::spawn(move || {
        let mut last_scan = std::time::Instant::now();
        loop {
            let event = rx.recv_timeout(Duration::from_millis(500));
            let mut scan = last_scan.elapsed() >= Duration::from_secs(15);
            if let Ok(v) = state.vault.lock() {
                if v.root != root {
                    let _ = watcher.unwatch(&root);
                    root = v.root.clone();
                    if let Err(error) = watcher.watch(&root, notify::RecursiveMode::Recursive) {
                        eprintln!("文件监听暂不可用，将定期检查：{error}");
                    }
                    scan = true;
                }
            }
            match event {
                Ok(Ok(event)) => {
                    scan |= event.paths.iter().any(|p| {
                        p.strip_prefix(&root).is_ok_and(|p| {
                            !p.components()
                                .any(|c| vault::hidden(&c.as_os_str().to_string_lossy()))
                        })
                    });
                }
                Ok(Err(_)) => scan = true,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(_) => break,
            };
            if let Ok(mut c) = state.compat.try_lock() {
                if c.busy {
                    match c.call(json!({"method":"status"})) {
                        Ok(_) => {
                            if c.busy {
                                continue;
                            }
                            scan = true;
                        }
                        Err(error) => {
                            eprintln!("同步状态检查失败：{error}");
                            continue;
                        }
                    }
                }
            }
            if !scan {
                continue;
            }
            std::thread::sleep(Duration::from_millis(120));
            while rx.try_recv().is_ok() {}
            if let Ok(c) = state.compat.try_lock() {
                if c.busy {
                    continue;
                }
                drop(c);
                if let Ok(mut v) = state.vault.lock() {
                    if let Err(e) = v.reconcile() {
                        v.error = Some(e.to_string());
                    }
                }
            }
            last_scan = std::time::Instant::now();
        }
    }))
}
