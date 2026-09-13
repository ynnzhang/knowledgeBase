use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
};

pub struct Compat {
    project: PathBuf,
    root: PathBuf,
    child: Option<(
        Child,
        ChildStdin,
        std::sync::mpsc::Receiver<std::io::Result<String>>,
    )>,
    pub busy: bool,
}
impl Compat {
    pub fn new(project: PathBuf, root: PathBuf) -> Self {
        Self {
            project,
            root,
            child: None,
            busy: false,
        }
    }
    pub fn running(&self) -> bool {
        self.child.is_some()
    }
    pub fn call(&mut self, input: Value) -> Result<Value> {
        if self.child.is_none() {
            let mut child = Command::new(std::env::var("ZHIXU_NODE").unwrap_or("node".into()))
                .arg(self.project.join("scripts/native-compat-worker.mjs"))
                .current_dir(&self.project)
                .env("ZHIXU_NATIVE_VAULT", &self.root)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .context("飞书兼容组件未启动，请安装 Node.js 和项目依赖")?;
            let stdin = child.stdin.take().unwrap();
            let stdout = BufReader::new(child.stdout.take().unwrap());
            let (tx, rx) = std::sync::mpsc::sync_channel(1);
            std::thread::spawn(move || {
                for line in stdout.lines() {
                    if tx.send(line).is_err() {
                        break;
                    }
                }
            });
            self.child = Some((child, stdin, rx));
        }
        let exchange = (|| -> Result<String> {
            let (_, stdin, output) = self.child.as_mut().unwrap();
            writeln!(stdin, "{}", input)?;
            stdin.flush()?;
            Ok(output
                .recv_timeout(std::time::Duration::from_secs(300))
                .context("兼容任务无响应或进程退出；请检查本地备份和飞书操作状态后重试")??)
        })();
        let line = match exchange {
            Ok(line) => line,
            Err(error) => {
                self.stop();
                self.busy = false;
                return Err(error);
            }
        };
        let response: Value = serde_json::from_str(&line)?;
        if response["ok"] != true {
            bail!("{}", response["error"].as_str().unwrap_or("兼容任务失败"))
        }
        let result = response["result"].clone();
        if let Some(busy) = result["busy"].as_bool() {
            self.busy = busy;
        }
        if input["method"] == "start" {
            self.busy = true;
        }
        Ok(result)
    }
    fn stop(&mut self) {
        if let Some((mut child, _, _)) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    pub fn switch(&mut self, root: &Path) -> Result<()> {
        if self.running() {
            self.call(json!({"method":"workspace","path":root}))?;
        }
        self.root = root.into();
        Ok(())
    }
}
impl Drop for Compat {
    fn drop(&mut self) {
        self.stop();
    }
}
