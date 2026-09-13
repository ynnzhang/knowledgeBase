import { spawn } from 'node:child_process';
import { projectRoot, notesRoot, usesDefaultNotesRoot } from './local-config.mjs';
import { nativeBinary, needsNativeBuild, run } from './native-runtime.mjs';
import { browserCommand, sameLocalPath } from './local-platform.mjs';
import { supervise } from './production-supervisor.mjs';
import { setTimeout as delay } from 'node:timers/promises';
const shouldOpen = process.argv.includes('--open') || !process.argv.includes('--no-open') && process.argv[1]?.endsWith('start-local.mjs');
function openBrowser() {
  if (!shouldOpen || process.env.ZHIXU_NO_BROWSER) return;
  const [command, args] = browserCommand('http://localhost:3000/');
  spawn(command, args, { stdio: 'ignore', windowsHide: true }).on('error', () => console.log('请打开 http://localhost:3000/'));
}
async function health() {
  try { const response = await fetch('http://127.0.0.1:3000/local-api/health', { signal: AbortSignal.timeout(1500) }); return response.ok ? await response.json() : null; }
  catch { return null; }
}
async function start() {
  const existing = await health();
  if (existing) {
    if (existing.engine === 'rust' && sameLocalPath(existing.projectRoot, projectRoot) && sameLocalPath(existing.notesRoot, notesRoot)) { console.log('知序已经运行：http://localhost:3000/'); openBrowser(); return; }
    throw new Error('端口 3000 已有其他服务，请在原启动窗口按 Ctrl+C 停止后，再启动 Rust 版本。');
  }
  if (await needsNativeBuild()) {
    console.log('正在构建 Rust 版本，首次构建需要下载依赖；以后仅在程序更新后重建。');
    await run(process.execPath, ['scripts/build-native.mjs']);
  }
  const runtime = supervise([{ name: 'rust', stdinShutdown: true, command: nativeBinary, args: ['--supervised', '--project', projectRoot, '--notes', notesRoot, ...(usesDefaultNotesRoot ? ['--create'] : [])], healthUrl: 'http://127.0.0.1:3000/local-api/health', healthService: 'zhixu-notes' }], { cwd: projectRoot, env: { ...process.env, ZHIXU_NODE: process.execPath }, probeGraceMs: 120_000 });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => void runtime.stop());
  let done = false; runtime.completion.then(() => { done = true; });
  for (let i = 0; i < 600 && !done; i++) {
    const status = await health();
    if (status?.engine === 'rust' && sameLocalPath(status.projectRoot, projectRoot)) { openBrowser(); break; }
    await delay(200);
  }
  process.exitCode = await runtime.completion;
}
try { await start(); } catch (error) { console.error(`[Rust 启动失败] ${error.message}`); process.exitCode = 1; }
