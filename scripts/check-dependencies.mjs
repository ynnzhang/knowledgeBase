import { readFile, access } from 'node:fs/promises';
import path from 'node:path';

// This module must work before npm dependencies have been installed.
export async function dependencyIssues(projectRoot, platform = process.platform) {
  const readJson = async (file) => JSON.parse(await readFile(path.join(projectRoot, file), 'utf8'));
  const [manifest, lock] = await Promise.all([readJson('package.json'), readJson('package-lock.json')]);
  const declared = { ...manifest.dependencies, ...manifest.devDependencies };
  const locked = { ...lock.packages?.['']?.dependencies, ...lock.packages?.['']?.devDependencies };
  const issues = [];
  for (const [name, spec] of Object.entries(declared)) {
    const expected = lock.packages?.[`node_modules/${name}`]?.version;
    if (!expected || locked[name] !== spec) throw new Error(`依赖清单与锁文件不一致（${name}），请拉取完整项目版本后重试。`);
    try {
      const installed = await readJson(`node_modules/${name}/package.json`);
      if (installed.version !== expected) issues.push(`${name}（版本需要更新）`);
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      issues.push(`${name}（未安装或安装不完整）`);
    }
  }
  for (const name of ['next', 'vinext', 'concurrently']) {
    if (!declared[name]) continue;
    try { await access(path.join(projectRoot, 'node_modules', '.bin', `${name}${platform === 'win32' ? '.cmd' : ''}`)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; issues.push(`${name}（启动命令缺失）`); }
  }
  return issues;
}

export async function ensureDependencies({ projectRoot, runNpm, beforeInstall = async () => {}, isStopping = () => false, log = console.log, platform = process.platform }) {
  const issues = await dependencyIssues(projectRoot, platform);
  if (!issues.length || isStopping()) return;
  log(`检测到项目依赖缺失或需要更新：\n${issues.map((name) => `  - ${name}`).join('\n')}\n正在执行 npm ci，请稍候……`);
  await beforeInstall();
  const code = await runNpm(['ci']);
  if (isStopping()) return;
  if (code !== 0) throw new Error('依赖安装失败，已停止启动。请检查上方网络或 npm 错误，关闭其他知识库进程后执行 npm ci，再重新启动。');
  const remaining = await dependencyIssues(projectRoot, platform);
  if (remaining.length) throw new Error(`安装后仍缺少所需依赖，已停止启动：${remaining.join('、')}。请检查 npm 安装配置后重新执行 npm ci。`);
  log('项目依赖已就绪。');
}
