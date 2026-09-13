use crate::vault::*;
use serde_json::json;
use std::fs;
fn fixture() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}
#[test]
fn catalog_is_body_free_and_updates_are_incremental() {
    let root = fixture();
    fs::write(
        root.path().join("测试.md"),
        format!(
            "---\ntags: [Java]\n---\n# 测试\n{}",
            "long body ".repeat(5000)
        ),
    )
    .unwrap();
    let mut vault = Vault::open(root.path().into()).unwrap();
    let first = vault.index(None, None);
    assert!(first.to_string().len() < 1500);
    assert_eq!(first["notes"][0]["bodyLoaded"], false);
    let revision = vault.revision;
    let epoch = vault.epoch.clone();
    let note = vault.note("测试.md").unwrap();
    vault.reads = 0;
    let saved = vault
        .save(
            "测试.md",
            "# 新标题\n正文",
            note["version"].as_str().unwrap(),
        )
        .unwrap();
    assert_eq!(vault.reads, 1);
    let delta = vault.index(Some(revision), Some(&epoch));
    assert_eq!(delta["full"], false);
    assert_eq!(delta["notes"].as_array().unwrap().len(), 1);
    assert!(saved["raw"].as_str().unwrap().contains("正文"));
    assert!(vault
        .save("测试.md", "stale", note["version"].as_str().unwrap())
        .unwrap_err()
        .is::<Conflict>());
    vault.reconcile().unwrap();
    assert_eq!(vault.reads, 1);
}
#[test]
fn search_handles_chinese_short_queries_literals_and_updates() {
    let root = fixture();
    fs::write(
        root.path().join("算法.md"),
        "# 学习\n回溯算法解决排列问题\n百分比100% 下划线_ 标记\"quotes\"",
    )
    .unwrap();
    let mut vault = Vault::open(root.path().into()).unwrap();
    for query in ["回", "回溯", "回溯算法", "100%", "quotes", "_"] {
        assert_eq!(vault.search(query).unwrap(), vec!["算法.md"]);
    }
    assert!(vault.search("不存在的内容").unwrap().is_empty());
    let version = vault.note("算法.md").unwrap()["version"]
        .as_str()
        .unwrap()
        .to_string();
    vault.save("算法.md", "new content", &version).unwrap();
    assert!(vault.search("回溯").unwrap().is_empty());
}
#[test]
fn deletion_rename_and_epoch_reset() {
    let root = fixture();
    fs::write(root.path().join("a.md"), "hello").unwrap();
    let mut v = Vault::open(root.path().into()).unwrap();
    let r = v.revision;
    let e = v.epoch.clone();
    fs::rename(root.path().join("a.md"), root.path().join("b.md")).unwrap();
    v.reconcile().unwrap();
    let d = v.index(Some(r), Some(&e));
    assert_eq!(d["removed"], json!(["a.md"]));
    assert_eq!(d["notes"][0]["path"], "b.md");
    assert_eq!(v.index(Some(r), Some("other"))["full"], true);
}
#[test]
fn safe_paths_and_atomic_replacement() {
    let root = fixture();
    fs::write(root.path().join("a.md"), "old").unwrap();
    for p in ["../outside.md", "/outside.md", ".secret/file.md", "a\\b.md"] {
        assert!(safe_path(root.path(), p, false, false).is_err());
    }
    atomic_write(&root.path().join("a.md"), b"new").unwrap();
    assert_eq!(fs::read_to_string(root.path().join("a.md")).unwrap(), "new");
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
}
#[test]
fn body_save_preserves_yaml_comments_and_rejects_invalid_yaml() {
    let next = updated_body(
        "---\n# comment\ntags: [Java]\nupdated: 2025-01-01\n---\nold",
        "new",
    )
    .unwrap();
    assert!(next.contains("# comment\ntags: [Java]"));
    assert!(next.ends_with("\nnew"));
    assert!(updated_body("---\ntags: [broken\n---\nold", "new").is_err());
}
#[test]
fn cached_catalog_survives_failed_scan() {
    let root = fixture();
    let p = root.path().join("x.md");
    fs::write(&p, "okay").unwrap();
    let mut v = Vault::open(root.path().into()).unwrap();
    fs::write(&p, [0xff, 0xfe]).unwrap();
    assert!(v.reconcile().is_err());
    assert_eq!(v.len(), 1);
    assert_eq!(v.search("okay").unwrap(), vec!["x.md"]);
}
#[cfg(unix)]
#[test]
fn symlinks_are_never_followed() {
    let root = fixture();
    let outside = fixture();
    fs::write(outside.path().join("x.md"), "private").unwrap();
    std::os::unix::fs::symlink(outside.path(), root.path().join("link")).unwrap();
    let v = Vault::open(root.path().into()).unwrap();
    assert_eq!(v.len(), 0);
    assert!(safe_path(root.path(), "link/x.md", false, false).is_err());
}
#[test]
fn restart_reuses_cache_and_a_vault_has_only_one_writer() {
    let root = fixture();
    let file = root.path().join("a.md");
    fs::write(&file, "cached restart search").unwrap();
    let v = Vault::open(root.path().into()).unwrap();
    assert!(Vault::open(root.path().into()).is_err());
    drop(v);
    let v = Vault::open(root.path().into()).unwrap();
    assert_eq!(v.reads, 0);
    assert_eq!(v.search("restart").unwrap(), vec!["a.md"]);
    drop(v);
    fs::write(file, "updated externally").unwrap();
    let v = Vault::open(root.path().into()).unwrap();
    assert_eq!(v.reads, 1);
    assert!(v.search("restart").unwrap().is_empty());
    assert_eq!(v.search("externally").unwrap(), vec!["a.md"]);
}
#[test]
fn restart_keeps_last_catalog_when_a_note_becomes_unreadable() {
    let root = fixture();
    let file = root.path().join("a.md");
    fs::write(&file, "cached valid").unwrap();
    let v = Vault::open(root.path().into()).unwrap();
    drop(v);
    fs::write(file, [0xff]).unwrap();
    let v = Vault::open(root.path().into()).unwrap();
    assert!(v.error.is_some());
    assert_eq!(v.search("valid").unwrap(), vec!["a.md"]);
}

#[test]
fn native_save_respects_shared_sync_lock_and_releases_its_own() {
    let root = fixture();
    fs::write(root.path().join("a.md"), "old").unwrap();
    let mut v = Vault::open(root.path().into()).unwrap();
    let version = v.note("a.md").unwrap()["version"]
        .as_str()
        .unwrap()
        .to_string();
    let lease = SyncLease::acquire(root.path()).unwrap();
    assert!(v.save("a.md", "should fail", &version).is_err());
    assert_eq!(fs::read_to_string(root.path().join("a.md")).unwrap(), "old");
    drop(lease);
    v.save("a.md", "saved", &version).unwrap();
    assert!(!root.path().join(".zhixu-feishu/sync.lock").exists());
}
