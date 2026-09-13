use serde_json::json;
use std::{fs, time::Instant};
use zhixu_core::vault::Vault;
fn main() -> anyhow::Result<()> {
    let count: usize = std::env::args().nth(1).unwrap_or("10000".into()).parse()?;
    let root = tempfile::tempdir()?;
    let body = "# Performance note\n\nRust local knowledge base performance. 中文回溯算法学习。\n"
        .repeat(100);
    for i in 0..count {
        fs::write(
            root.path().join(format!("note-{i:05}.md")),
            format!("{body}\nunique-{i:05}"),
        )?;
    }
    let t = Instant::now();
    let mut v = Vault::open(root.path().into())?;
    let cold = t.elapsed().as_secs_f64() * 1000.;
    let t = Instant::now();
    let full = v.index(None, None);
    let bytes = serde_json::to_vec(&full)?.len();
    let catalog = t.elapsed().as_secs_f64() * 1000.;
    let t = Instant::now();
    v.reconcile()?;
    let scan = t.elapsed().as_secs_f64() * 1000.;
    let note = v.note("note-00000.md")?;
    let rev = v.revision;
    let epoch = v.epoch.clone();
    let t = Instant::now();
    v.save(
        "note-00000.md",
        "# Changed\nunique-saved",
        note["version"].as_str().unwrap(),
    )?;
    let save = t.elapsed().as_secs_f64() * 1000.;
    let delta = serde_json::to_vec(&v.index(Some(rev), Some(&epoch)))?.len();
    let t = Instant::now();
    assert_eq!(v.search("unique-saved")?.len(), 1);
    let search = t.elapsed().as_secs_f64() * 1000.;
    let t = Instant::now();
    v.search("回溯")?;
    let short_search = t.elapsed().as_secs_f64() * 1000.;
    drop(v);
    let t = Instant::now();
    let v = Vault::open(root.path().into())?;
    let restart = t.elapsed().as_secs_f64() * 1000.;
    println!(
        "{}",
        json!({"notes":count,"noteBytes":body.len(),"initialIndexMs":cold,"unchangedScanMs":scan,"catalogSerializeMs":catalog,"catalogBytes":bytes,"singleSaveMs":save,"deltaBytes":delta,"indexedSearchMs":search,"twoCharacterSearchMs":short_search,"cachedRestartMs":restart,"restartBodyReads":v.reads})
    );
    Ok(())
}
