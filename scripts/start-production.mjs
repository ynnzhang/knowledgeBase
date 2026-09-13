import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:net';
import { projectRoot, localApiPort } from './local-config.mjs';
import { assertProjectFiles } from './check-project.mjs';
import { dependencyIssues } from './check-dependencies.mjs';
import { supervise } from './production-supervisor.mjs';

async function available(port) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', () => reject(new Error(`端口 ${port} 已被占用，请先停止已有知识库服务。`)));
    server.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve) => server.close(resolve));
}
try {
  assertProjectFiles(projectRoot);
  const missing = await dependencyIssues(projectRoot);
  if (missing.length) throw new Error('依赖需要更新，请先执行 npm ci 和 npm run build。');
  try { await readFile(path.join(projectRoot, '.next', 'BUILD_ID'), 'utf8'); }
  catch { throw new Error('没有正式构建，请先执行 npm run build，再运行 npm start。'); }
  const routes = JSON.parse(await readFile(path.join(projectRoot, '.next', 'routes-manifest.json'), 'utf8'));
  if (!JSON.stringify(routes.rewrites).includes(`http://127.0.0.1:${localApiPort}/:path*`)) {
    throw new Error('本地 API 端口与构建配置不一致，请重新执行 npm run build。');
  }
  await Promise.all([available(3000), available(localApiPort)]);
  const runtime = supervise([
    { name: 'notes', args: ['scripts/sync-notes.mjs', '--watch'], ipc: true, healthUrl: `http://127.0.0.1:${localApiPort}/health`, healthService: 'zhixu-notes' },
    { name: 'site', args: ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3000'], healthUrl: 'http://127.0.0.1:3000/api/health', healthService: 'zhixu-site' },
  ], { cwd: projectRoot, env: { ...process.env, NODE_ENV: 'production' } });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { void runtime.stop(); });
  console.log('正在启动正式服务：http://localhost:3000/（Ctrl+C 停止）。就绪检查：http://localhost:3000/local-api/ready');
  process.exitCode = await runtime.completion;
} catch (error) {
  console.error(`[启动失败] ${error.message}`);
  process.exitCode = 1;
}
