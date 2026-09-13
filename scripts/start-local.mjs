import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Check before importing any project modules: a static import of a missing
// local-config.mjs would otherwise abort before we could explain the problem.
try {
  const { assertProjectFiles } = await import('./check-project.mjs');
  assertProjectFiles(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
} catch (error) {
  console.error(`[错误] ${error.code === 'ERR_MODULE_NOT_FOUND'
    ? '项目文件不完整，缺少 scripts/check-project.mjs。请完整解压最新版项目包后重试，npm install 无法补回项目源码。'
    : error.message}`);
  process.exit(1);
}
if (process.argv.includes('--check')) {
  console.log('项目源码完整。');
  process.exit(0);
}

const { localApiPort, notesRoot, projectRoot } = await import('./local-config.mjs');
const { browserCommand, npmCommand, sameLocalPath, stopProcessTree } = await import('./local-platform.mjs');
const { ensureDependencies } = await import('./check-dependencies.mjs');

const siteUrl = 'http://localhost:3000/';
const apiUrl = `http://127.0.0.1:${localApiPort}/health`;
let child;
let stopping = false;

function stop() {
  if (stopping) return;
  stopping = true;
  stopProcessTree(child?.pid);
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop);

function runNpm(args) {
  const [command, parameters] = npmCommand(args);
  child = spawn(command, parameters, { cwd: projectRoot, stdio: 'inherit', detached: process.platform !== 'win32' });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(signal && stopping ? 0 : code ?? 1));
  });
}

async function health(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return response.ok ? await response.json() : null;
  } catch { return null; }
}

function matchesProject(value) {
  return value?.ok && value.service === 'zhixu-notes'
    && sameLocalPath(value.projectRoot, projectRoot) && sameLocalPath(value.notesRoot, notesRoot);
}

function openBrowser() {
  if (process.env.ZHIXU_NO_BROWSER) return;
  const [command, args] = browserCommand(siteUrl);
  const browser = spawn(command, args, { stdio: 'ignore', windowsHide: true });
  const fallback = () => console.warn(`请在浏览器中打开 ${siteUrl}`);
  browser.on('error', fallback);
  browser.on('exit', (code) => { if (code) fallback(); });
}

async function start() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) throw new Error('Node.js 版本过低，需要 22.13 或更高版本。');
  await ensureDependencies({ projectRoot, runNpm, isStopping: () => stopping, beforeInstall: async () => {
    const services = await Promise.all([health(apiUrl), health(`${siteUrl}local-api/health`)]);
    if (services.some((service) => service?.service === 'zhixu-notes' && sameLocalPath(service.projectRoot, projectRoot))) {
      throw new Error('当前项目的服务仍在运行，请先在原启动窗口按 Ctrl+C 停止服务，再重新启动以安装更新后的依赖。');
    }
  } });
  if (stopping || process.argv.includes('--prepare')) return;
  if (!process.argv.includes('--legacy')) { await import('./start-native.mjs'); return; }
  const existingApi = await health(apiUrl);
  if (existingApi && !matchesProject(existingApi)) {
    throw new Error(`端口 ${localApiPort} 正被其他服务或知识库使用，请修改 .env.local 中的 KNOWLEDGE_BASE_API_PORT。`);
  }
  if (matchesProject(await health(`${siteUrl}local-api/health`))) {
    console.log(`知序已经在运行：${siteUrl}`);
    openBrowser();
    return;
  }

  if (stopping) return;
  console.log(`知序正在启动\n笔记目录：${notesRoot}\n本地地址：${siteUrl}\n请保留此窗口，按 Ctrl+C（Mac 为 Control+C）停止服务。`);
  let finished = false;
  const completion = runNpm(['run', matchesProject(existingApi) ? 'dev:site' : 'dev'])
    .finally(() => { finished = true; });
  // Await the exit promise immediately too, so spawn failures cannot go unhandled.
  completion.catch(() => {});
  let ready = false;
  for (let attempt = 0; attempt < 120 && !finished && !stopping; attempt += 1) {
    if (matchesProject(await health(`${siteUrl}local-api/health`))) {
      try {
        const response = await fetch(siteUrl, { signal: AbortSignal.timeout(5000) });
        await response.arrayBuffer();
        if (response.ok) { ready = true; break; }
      } catch { /* Wait for the first compilation. */ }
    }
    await delay(1000);
  }
  if (ready && !stopping && !finished) {
    console.log('网站已就绪。');
    openBrowser();
  } else if (!finished && !stopping) {
    console.warn(`服务启动较慢，请查看上方日志，就绪后手动打开 ${siteUrl}`);
  }
  const code = await completion;
  if (!stopping && code !== 0) {
    stop();
    throw new Error(`本地服务异常退出（${code}），请检查上方日志及端口 3000 是否被占用。`);
  }
}

try {
  await start();
} catch (error) {
  stop();
  console.error(`[错误] ${error.message}`);
  process.exitCode = 1;
}
