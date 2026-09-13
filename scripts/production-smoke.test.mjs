import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { projectRoot } from './local-config.mjs';
import { requiredProjectFiles } from './check-project.mjs';
import { supervise } from './production-supervisor.mjs';

async function port() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const number = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return number;
}

test('production artifact serves pages, assets and local API through Next, with isolated notes', { timeout: 90_000 }, async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'zhixu-production-'));
  let runtime;
  t.after(async () => { await runtime?.stop(); await rm(fixture, { recursive: true, force: true }); });
  for (const file of requiredProjectFiles) {
    await mkdir(path.dirname(path.join(fixture, file)), { recursive: true });
    await cp(path.join(projectRoot, file), path.join(fixture, file));
  }
  await cp(path.join(projectRoot, '.next'), path.join(fixture, '.next'), { recursive: true, filter: (source) => !source.includes(`${path.sep}.next${path.sep}cache`) });
  await symlink(path.join(projectRoot, 'node_modules'), path.join(fixture, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await mkdir(path.join(fixture, 'vault'));
  await mkdir(path.join(fixture, 'public'));
  await writeFile(path.join(fixture, 'vault', '测试.md'), '# 正式服务测试\n\n```java\nclass Example {}\n```\n');
  const apiPort = await port(), sitePort = await port();
  await writeFile(path.join(fixture, '.env.local'), `KNOWLEDGE_BASE_PATH=./vault\nKNOWLEDGE_BASE_API_PORT=${apiPort}\n`);
  // The release embeds the configured local API port in its rewrite manifest.
  // Adapt only that environment-specific value in our isolated build copy.
  const manifestPath = path.join(fixture, '.next', 'routes-manifest.json');
  const manifest = await readFile(manifestPath, 'utf8');
  await writeFile(manifestPath, manifest.replace(/http:\/\/127\.0\.0\.1:\d+\/:path\*/g, `http://127.0.0.1:${apiPort}/:path*`));
  const env = { ...process.env, NODE_ENV: 'production', KNOWLEDGE_BASE_PATH: path.join(fixture, 'vault'), KNOWLEDGE_BASE_API_PORT: String(apiPort) };
  const events = [];
  runtime = supervise([
    { name: 'notes', ipc: true, args: ['scripts/sync-notes.mjs', '--watch'] },
    { name: 'site', args: ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(sitePort)] },
  ], { cwd: fixture, env, maxRestarts: 1, baseDelay: 25, log: (line) => events.push(JSON.parse(line)) });
  const base = `http://127.0.0.1:${sitePort}`;
  let ready = false;
  for (let i = 0; i < 300; i++) {
    try { const r = await fetch(`${base}/local-api/ready`, { signal: AbortSignal.timeout(1000) }); await r.text(); if (r.ok) { ready = true; break; } } catch { /* Starting. */ }
    await delay(100);
  }
  assert.ok(ready, 'production proxy must become ready');
  assert.equal((await (await fetch(`${base}/api/health`)).json()).service, 'zhixu-site');
  const home = await fetch(base);
  assert.equal(home.status, 200);
  assert.equal(home.headers.get('x-powered-by'), null);
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
  const html = await home.text();
  assert.match(html, /知序/);
  const script = html.match(/src="([^" ]*\/_next\/static\/[^" ]+\.js)"/);
  assert.ok(script, 'production JavaScript must be linked');
  const asset = await fetch(`${base}${script[1]}`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('cache-control'), /immutable/);
  await asset.arrayBuffer();
  const indexResponse = await fetch(`${base}/local-api/index`);
  const etag = indexResponse.headers.get('etag');
  assert.equal((await indexResponse.json()).notes.length, 1);
  const cached = await Promise.all(Array.from({ length: 20 }, () => fetch(`${base}/local-api/index`, { headers: { 'If-None-Match': etag } })));
  assert.ok(cached.every((response) => response.status === 304));
  const body = '# 已保存\n\n```java\nclass Saved {}\n```';
  const saved = await fetch(`${base}/local-api/notes/content`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '测试.md', body }) });
  assert.equal(saved.status, 200); await saved.json();
  assert.match(await readFile(path.join(fixture, 'vault', '测试.md'), 'utf8'), /class Saved/);
  assert.equal((await fetch(`${base}/api/note-overrides`)).status, 503);
  const worker = events.find((event) => event.service === 'notes' && event.event === 'started');
  process.kill(worker.pid, 'SIGKILL');
  let recovered = false;
  for (let i = 0; i < 100; i++) {
    if (events.filter((event) => event.service === 'notes' && event.event === 'started').length === 2) {
      try { const response = await fetch(`${base}/local-api/index`); const data = await response.json(); if (response.ok && data.notes[0].raw.includes('class Saved')) { recovered = true; break; } } catch { /* Restarting. */ }
    }
    await delay(50);
  }
  assert.ok(recovered, 'crashed notes worker must restart with saved data');
  assert.equal(events.filter((event) => event.service === 'site' && event.event === 'started').length, 1);
  t.diagnostic('正式页面、不可变静态资源、健康与就绪检查、20 个并发缓存请求、隔离笔记保存、强制结束笔记进程后自动恢复均通过。');
});
