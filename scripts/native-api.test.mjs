import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { projectRoot } from './local-config.mjs';
import { nativeBinary } from './native-runtime.mjs';

async function until(fn, message, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await delay(80); }
  assert.fail(message);
}
test('Rust release: isolated catalog, reads, writes, search, compatibility, watcher and restart', { timeout: 60000 }, async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'zhixu-rust-'));
  let child;
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); child.stdin.end('shutdown\n'); const timer = setTimeout(() => child.kill('SIGKILL'), 8000); const [code] = await exited; clearTimeout(timer); assert.equal(code, 0, 'control pipe must shut down gracefully on every platform');
  }
  t.after(async () => { await stop(); await rm(fixture, { recursive: true, force: true }); });
  await cp(path.join(projectRoot, 'scripts'), path.join(fixture, 'scripts'), { recursive: true });
  await writeFile(path.join(fixture, 'package.json'), '{"type":"module"}');
  await symlink(path.join(projectRoot, 'node_modules'), path.join(fixture, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const vault = path.join(fixture, 'vault'); const second = path.join(fixture, '另一个目录');
  await mkdir(vault); await mkdir(second);
  await writeFile(path.join(vault, '测试.md'), '---\ntags: [Java]\n---\n# 标题\n\n独有正文回溯算法\n' + '正文示例 '.repeat(10000));
  await writeFile(path.join(second, '测试.md'), '# 另一个知识库\n不能覆盖');
  async function start() {
    let log = '';
    // No local credentials or environment secrets are passed to the fixture worker.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('FEISHU_') && !key.startsWith('KNOWLEDGE_BASE_')));
    child = spawn(nativeBinary, ['--supervised', '--project', fixture, '--notes', vault, '--port', '0'], { env: { ...env, ZHIXU_NODE: process.execPath }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => {});
    child.stdout.on('data', (v) => { log += v; }); child.stderr.on('data', (v) => { log += v; });
    const port = await until(() => { if (child.exitCode !== null) assert.fail(log); return log.match(/localhost:(\d+)/)?.[1]; }, 'Rust must start: ' + log);
    return `http://127.0.0.1:${port}`;
  }
  let base = await start();
  const get = async (url) => { const r = await fetch(base + '/local-api' + url); assert.equal(r.status, 200, await r.clone().text()); return r.json(); };
  const post = (url, body, headers = {}) => fetch(base + '/local-api' + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await get('/health')).engine, 'rust');
  const home = await fetch(base); assert.equal(home.status, 200); const html = await home.text(); assert.match(html, /知序/);
  const script = html.match(/src="([^" ]+\.js)"/); assert.ok(script);
  const js = await fetch(base + script[1]); assert.equal(js.status, 200); assert.match(js.headers.get('cache-control'), /immutable/); await js.arrayBuffer();
  assert.equal((await fetch(base + '/notes-index.json')).status, 404, 'personal legacy index must not be embedded');
  const indexResponse = await fetch(base + '/local-api/index'); const etag = indexResponse.headers.get('etag'); const first = await indexResponse.json();
  assert.ok(JSON.stringify(first).length < 2000); assert.equal(first.notes[0].bodyLoaded, false); assert.ok(!first.notes[0].raw.includes('独有正文'));
  const cached = await Promise.all(Array.from({ length: 20 }, () => fetch(base + '/local-api/index', { headers: { 'If-None-Match': etag } })));
  assert.ok(cached.every((r) => r.status === 304));
  assert.deepEqual((await get('/search?q=' + encodeURIComponent('回溯算法'))).paths, ['测试.md']);
  const note = await get('/notes/read?path=' + encodeURIComponent('测试.md'));
  const saves = await Promise.all(['第一个保存', '第二个保存'].map((body) => post('/notes/content', { path: '测试.md', body, version: note.version })));
  assert.deepEqual(saves.map((r) => r.status).sort(), [200, 409]);
  const saved = await saves.find((r) => r.ok).json();
  assert.ok((await readFile(path.join(vault, '测试.md'), 'utf8')).includes(saved.raw));
  const delta = await get(`/index?epoch=${first.epoch}&since=${first.revision}`); assert.equal(delta.full, false); assert.equal(delta.notes.length, 1);
  assert.equal((await post('/notes/content', { path: '../secret.md', body: 'bad', version: 'x' })).status, 400);
  assert.equal((await post('/notes/content', { path: '测试.md', body: 'bad', version: saved.version }, { Origin: 'https://example.com' })).status, 403);
  assert.equal((await get('/feishu/status')).busy, false);
  const tagged = await post('/notes/tags', { path: '测试.md', tags: ['Rust'], version: saved.version }); assert.equal(tagged.status, 200); assert.deepEqual((await tagged.json()).tags, ['Rust']);
  const createdFolder = await post('/files', { action: 'create-folder', name: '子目录' }); assert.equal(createdFolder.status, 200, await createdFolder.clone().text());
  const moved = await post('/files', { action: 'move-note', path: '测试.md', folder: '子目录' }); assert.equal(moved.status, 200, await moved.clone().text());
  assert.equal((await moved.json()).index.notes[0].path, '子目录/测试.md');
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
  const uploaded = await fetch(base + '/local-api/notes/images?notePath=' + encodeURIComponent('子目录/测试.md'), { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: bytes });
  assert.equal(uploaded.status, 200); const image = await uploaded.json();
  const readImage = await fetch(base + '/local-api/assets?' + new URLSearchParams({ notePath: '子目录/测试.md', src: image.url })); assert.equal(readImage.status, 200); assert.deepEqual(Buffer.from(await readImage.arrayBuffer()), bytes);
  await writeFile(path.join(vault, '外部.md'), '# 编辑器写入\nexternal unique');
  await until(async () => (await get('/search?q=external%20unique')).paths.length === 1, 'filesystem events must update search');
  const deleted = await post('/files', { action: 'delete-note', path: '外部.md', confirmed: true }); assert.equal(deleted.status, 200); assert.equal((await get('/search?q=external%20unique')).paths.length, 0);
  const switched = await post('/workspace/open', { path: second }); assert.equal(switched.status, 200, await switched.clone().text());
  assert.equal((await post('/notes/content', { path: '测试.md', body: 'wrong vault', version: saved.version }, { 'X-Zhixu-Workspace': encodeURIComponent(vault) })).status, 409);
  await delay(700); await writeFile(path.join(second, '新增.md'), '# 新目录监听');
  await until(async () => (await get('/index')).notes.length === 2, 'watcher must follow switched directory', 6000);
  await stop(); base = await start();
  assert.ok((await get('/index')).notes.some((n) => n.path === '子目录/测试.md'));
  assert.deepEqual((await get('/search?q=' + encodeURIComponent('第'))).paths, ['子目录/测试.md']);
  t.diagnostic('Rust 发布产物、并发保存冲突、缓存、摘要/增量索引、搜索、图片、飞书状态、标签/目录兼容、目录切换监听和重启读取均通过；没有访问实际笔记或飞书服务。');
});

test('supervisor restarts the Rust executable after a crash and drains it through stdin', { timeout: 20000 }, async (t) => {
  const { supervise } = await import('./production-supervisor.mjs');
  const { createServer } = await import('node:net');
  const listener = createServer(); await new Promise((r) => listener.listen(0, '127.0.0.1', r)); const port = listener.address().port; await new Promise((r) => listener.close(r));
  const fixture = await mkdtemp(path.join(tmpdir(), 'zhixu-rust-recovery-'));
  await writeFile(path.join(fixture, 'a.md'), '# 持久笔记\n保留正文');
  const events = [];
  const runtime = supervise([{ name: 'rust', command: nativeBinary, stdinShutdown: true, args: ['--supervised', '--project', fixture, '--notes', fixture, '--port', String(port)] }], { maxRestarts: 1, baseDelay: 50, log: (line) => events.push(JSON.parse(line)) });
  t.after(async () => { await runtime.stop(); await rm(fixture, { recursive: true, force: true }); });
  const ready = async () => { try { const r = await fetch(`http://127.0.0.1:${port}/local-api/ready`, { signal: AbortSignal.timeout(500) }); return r.ok; } catch { return false; } };
  await until(ready, 'Rust should start');
  process.kill(events.find((e) => e.event === 'started').pid, 'SIGKILL');
  await until(async () => events.filter((e) => e.event === 'started').length === 2 && await ready(), 'Rust must restart with the same vault');
  const note = await (await fetch(`http://127.0.0.1:${port}/local-api/notes/read?path=a.md`)).json(); assert.match(note.raw, /保留正文/);
  assert.equal(events.filter((e) => e.event === 'restarting').length, 1);
  assert.equal(await runtime.stop(), 0);
});
