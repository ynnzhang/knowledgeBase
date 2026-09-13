import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { homedir } from 'node:os';
import { projectRoot } from './local-config.mjs';
export const nativeBinary = path.join(projectRoot, 'native', 'target', 'release', `zhixu${process.platform === 'win32' ? '.exe' : ''}`);
export function cargoCommand() {
  const installed = path.join(homedir(), '.cargo', 'bin', `cargo${process.platform === 'win32' ? '.exe' : ''}`);
  return existsSync(installed) ? installed : 'cargo';
}
export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: projectRoot, stdio: 'inherit', ...options });
    child.once('error', (error) => reject(new Error(error.code === 'ENOENT' ? '缺少 Rust 工具链，请从 https://rustup.rs 安装 Rust；Windows 构建还需要 Visual Studio C++ Build Tools。也可使用 CI 构建的可执行文件。' : error.message)));
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`命令执行失败（${code}）：${command}`)));
  });
}
export async function sourceFingerprint() {
  const hash = createHash('sha256');
  async function scan(directory) {
    for (const entry of (await readdir(path.join(projectRoot, directory), { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await scan(file);
      else if (entry.isFile()) hash.update(file.replaceAll('\\', '/')).update((await readFile(path.join(projectRoot, file), 'utf8')).replaceAll('\r\n', '\n'));
    }
  }
  for (const dir of ['app', 'native/src']) await scan(dir);
  for (const file of ['package-lock.json', 'index.html', 'vite.native.config.ts', 'postcss.config.mjs', 'native/Cargo.toml', 'native/Cargo.lock']) hash.update(file.replaceAll('\\', '/')).update((await readFile(path.join(projectRoot, file), 'utf8')).replaceAll('\r\n', '\n'));
  return hash.digest('hex');
}
export async function needsNativeBuild() {
  try { await access(nativeBinary); return await readFile(path.join(projectRoot, 'native/target/source.sha256'), 'utf8') !== await sourceFingerprint(); }
  catch { return true; }
}
