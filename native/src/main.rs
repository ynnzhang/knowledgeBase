use anyhow::{Context, Result};
use clap::Parser;
use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use zhixu_core::{
    compat::Compat,
    server::{self, AppState},
    vault::Vault,
};
#[derive(Parser)]
struct Args {
    #[arg(long, default_value = ".")]
    project: PathBuf,
    #[arg(long)]
    notes: Option<PathBuf>,
    #[arg(long)]
    create: bool,
    #[arg(long)]
    supervised: bool,
    #[arg(long, default_value_t = 3000)]
    port: u16,
}
#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let (shutdown_tx, mut shutdown_rx) = tokio::sync::mpsc::channel::<()>(1);
    let _keep_sender = if args.supervised {
        std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::stdin().lock().lines() {
                match line {
                    Ok(line) if line.trim() != "shutdown" => continue,
                    _ => break,
                }
            }
            let _ = shutdown_tx.blocking_send(());
        });
        None
    } else {
        // Direct CLI runs need not have stdin.
        Some(shutdown_tx)
    };

    let project = dunce::canonicalize(args.project)?;
    let selected = fs::read(project.join(".knowledge-base.local.json"))
        .ok()
        .and_then(|raw| serde_json::from_slice::<serde_json::Value>(&raw).ok())
        .and_then(|v| v["notesRoot"].as_str().map(PathBuf::from));
    let root = args
        .notes
        .or(selected)
        .or_else(|| std::env::var("KNOWLEDGE_BASE_PATH").ok().map(PathBuf::from))
        .unwrap_or_else(|| {
            if cfg!(windows) && PathBuf::from("E:/Note").is_dir() {
                PathBuf::from("E:/Note")
            } else {
                PathBuf::from(
                    std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                        .unwrap_or(".".into()),
                )
                .join("Note")
            }
        });
    let root = if root.is_absolute() {
        root
    } else {
        project.join(root)
    };
    if args.create {
        fs::create_dir_all(&root)?;
    }
    let root = dunce::canonicalize(root).context("笔记目录不存在，请检查本机目录配置")?;
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, args.port))
        .await
        .context("端口已被占用，请先停止已有服务")?;
    let port = listener.local_addr()?.port();
    let state = AppState {
        vault: Arc::new(Mutex::new(Vault::open(root.clone())?)),
        compat: Arc::new(Mutex::new(Compat::new(project.clone(), root))),
        mutation: Arc::new(tokio::sync::Mutex::new(())),
        project,
        port,
        requests: Arc::new(tokio::sync::Semaphore::new(64)),
    };
    let _watcher = server::watcher(state.clone())?;
    println!("知序 Rust 核心已启动：http://localhost:{port}/");
    axum::serve(listener, server::app(state.clone()))
        .with_graceful_shutdown(async move {
            #[cfg(unix)]
            {
                let mut terminate =
                    tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                        .expect("SIGTERM handler");
                tokio::select! {_=tokio::signal::ctrl_c()=>{},_=terminate.recv()=>{},_=shutdown_rx.recv()=>{}}
            }
            #[cfg(not(unix))]
            {
                tokio::select! {_=tokio::signal::ctrl_c()=>{},_=shutdown_rx.recv()=>{}}
            }
        })
        .await?;
    for _ in 0..50 {
        let compat = state.compat.clone();
        let busy =
            tokio::task::spawn_blocking(move || compat.lock().map(|c| c.busy).unwrap_or(false))
                .await?;
        if !busy {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    Ok(())
}
