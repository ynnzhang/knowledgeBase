import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rename, rm, symlink, utimes } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { atomicWrite, createNoteScanner } from './note-index.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), '知序 索引 '));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('1000 unchanged notes reuse content; one edit reads only one note with bounded concurrency', async (t) => {
  const root = await fixture(t);
  for (let i = 0; i < 1000; i++) await writeFile(path.join(root, `${i}.md`), `# 笔记 ${i}`);
  let reads = 0, active = 0, peak = 0;
  const scan = createNoteScanner({ read: async (file) => {
    reads++; active++; peak = Math.max(peak, active);
    try { return await readFile(file, 'utf8'); } finally { active--; }
  } });
  const initial = await scan(root);
  assert.equal(reads, 1000); assert.ok(peak <= 8);
  reads = 0;
  assert.deepEqual(await scan(root), initial); assert.equal(reads, 0);
  await writeFile(path.join(root, '10.md'), '# 已更新的笔记');
  const changed = await scan(root);
  assert.equal(reads, 1); assert.equal(changed.notes.find((note) => note.path === '10.md').raw, '# 已更新的笔记');
  t.diagnostic('1000 篇笔记：首次读取 1000 次；无变化时读取 0 次；修改一篇后读取 1 次。');
});

test('scanner reflects rename/deletion and skips assets, private directories and symlinks', async (t) => {
  const root = await fixture(t), scan = createNoteScanner();
  await mkdir(path.join(root, '空目录'));
  await symlink(path.join(root, '空目录'), path.join(root, '链接'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const name of ['.trash', '.zhixu-feishu', '图片.assets']) {
    await mkdir(path.join(root, name)); await writeFile(path.join(root, name, '隐藏.md'), '不索引');
  }
  await writeFile(path.join(root, '笔记.md'), '内容');
  assert.deepEqual((await scan(root)).folders, ['空目录']);
  await rename(path.join(root, '笔记.md'), path.join(root, '新名称.md'));
  assert.deepEqual((await scan(root)).notes.map((note) => note.path), ['新名称.md']);
  await rm(path.join(root, '新名称.md'));
  assert.deepEqual((await scan(root)).notes, []);
});

test('a failed read does not poison cached content and a subsequent scan recovers', async (t) => {
  const root = await fixture(t), file = path.join(root, '笔记.md');
  let fail = false;
  const scan = createNoteScanner({ read: (filename) => { if (fail) throw new Error('临时读取失败'); return readFile(filename, 'utf8'); } });
  await writeFile(file, '原文'); await scan(root);
  await writeFile(file, '新内容');
  fail = true; await assert.rejects(scan(root), /临时读取失败/);
  fail = false; assert.equal((await scan(root)).notes[0].raw, '新内容');
  const other = await fixture(t);
  await writeFile(path.join(other, '笔记.md'), '另一知识库');
  assert.equal((await scan(other)).notes[0].raw, '另一知识库');
});

test('concurrent changes during a read are retried instead of publishing mixed content', async (t) => {
  const root = await fixture(t), file = path.join(root, '笔记.md');
  await writeFile(file, '原文');
  let change = true;
  const scan = createNoteScanner({ read: async (filename) => {
    const raw = await readFile(filename, 'utf8');
    if (change) { await writeFile(filename, '新的内容'); await utimes(filename, new Date(), new Date(Date.now() + 2000)); }
    return raw;
  } });
  await assert.rejects(scan(root), /正在被其他程序写入/);
  change = false; assert.equal((await scan(root)).notes[0].raw, '新的内容');
});

test('atomic replacement never exposes partially written JSON and cleans temporary files', async (t) => {
  const root = await fixture(t), file = path.join(root, 'index.json');
  await atomicWrite(file, JSON.stringify({ version: 0, text: '旧内容' }));
  let done = false, reads = 0;
  const reader = (async () => {
    while (!done) {
      const value = JSON.parse(await readFile(file, 'utf8'));
      assert.ok(Number.isInteger(value.version)); reads++;
    }
  })();
  try { for (let i = 1; i <= 8; i++) await atomicWrite(file, JSON.stringify({ version: i, text: '新内容'.repeat(10000) })); }
  finally { done = true; await reader; }
  assert.ok(reads > 0); assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 8);
  assert.deepEqual(await readdir(root), ['index.json']);
  await assert.rejects(atomicWrite(root, 'cannot replace a directory'));
  assert.deepEqual(await readdir(root), ['index.json']);
});

test('Windows replacement retries transient locks with a finite budget, never permanent errors', async () => {
  const { replaceFile } = await import('./note-index.mjs');
  let attempts = 0; const waits = [];
  await replaceFile('temp', 'live', { platform: 'win32', move: async () => { if (++attempts < 4) throw Object.assign(new Error('locked'), { code: 'EPERM' }); }, pause: async (ms) => waits.push(ms) });
  assert.equal(attempts, 4); assert.deepEqual(waits, [5, 10, 20]);
  for (const [platform, code, expected] of [['win32', 'EPERM', 9], ['win32', 'ENOENT', 1], ['darwin', 'EPERM', 1]]) {
    attempts = 0;
    await assert.rejects(replaceFile('temp', 'live', { platform, move: async () => { attempts++; throw Object.assign(new Error(code), { code }); }, pause: async () => {} }), { code });
    assert.equal(attempts, expected);
  }
});
