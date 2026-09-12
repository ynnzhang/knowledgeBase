import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { projectRoot, resolveNotesRoot, validSavedRoot } from './local-config.mjs';

test('platform defaults and portable custom paths', () => {
  assert.equal(resolveNotesRoot({}, 'darwin', '/Users/test'), '/Users/test/Note');
  assert.equal(resolveNotesRoot({}, 'win32', 'C:\\Users\\test', () => true), 'E:\\Note');
  assert.equal(resolveNotesRoot({ KNOWLEDGE_BASE_PATH: '~/我的 笔记' }, 'darwin', '/Users/test'), '/Users/test/我的 笔记');
  assert.equal(resolveNotesRoot({ KNOWLEDGE_BASE_PATH: './notes' }), path.join(projectRoot, 'notes'));
  assert.equal(resolveNotesRoot({}, 'win32', 'C:\\Users\\test', () => false), 'C:\\Users\\test\\Note');
  for (const input of ['~/我的 笔记', '~\\我的 笔记']) {
    assert.equal(resolveNotesRoot({ KNOWLEDGE_BASE_PATH: input }, 'win32', 'C:\\Users\\test'), 'C:\\Users\\test\\我的 笔记');
  }
  for (const input of ['D:/中文 笔记', 'D:\\中文 笔记']) {
    assert.equal(resolveNotesRoot({ KNOWLEDGE_BASE_PATH: input }, 'win32'), 'D:\\中文 笔记');
  }
  assert.equal(resolveNotesRoot({ KNOWLEDGE_BASE_PATH: './notes' }, 'win32', 'C:\\Users\\test', () => false, 'D:\\项目 目录'), 'D:\\项目 目录\\notes');
  assert.equal(resolveNotesRoot({ KNOWLEDGE_BASE_PATH: '\\\\server\\share\\笔记' }, 'win32'), '\\\\server\\share\\笔记');
  assert.ok(!validSavedRoot('/Users/test/Note', 'win32'));
  assert.ok(!validSavedRoot('E:\\Note', 'darwin'));
  assert.ok(!validSavedRoot('E:Note', 'win32'));
  assert.ok(validSavedRoot('E:\\Note', 'win32'));
  assert.ok(validSavedRoot('\\\\server\\share\\笔记', 'win32'));
});

test('cross-platform local workflow: env file, sync, watch, save, and Windows image paths', { timeout: 20000 }, async (t) => {
  const fixture = await realpath(await mkdtemp(path.join(tmpdir(), 'zhixu-local-')));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    await rm(fixture, { recursive: true, force: true });
  });
  await mkdir(path.join(fixture, 'scripts'));
  await mkdir(path.join(fixture, 'public'));
  await symlink(path.join(projectRoot, 'node_modules'), path.join(fixture, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const name of ['sync-notes.mjs', 'local-files.mjs', 'local-workspace.mjs', 'note-tags.mjs', 'local-config.mjs', 'feishu-sync.mjs', 'feishu-markdown.mjs', 'feishu-content.mjs', 'feishu-media.mjs']) {
    await cp(path.join(projectRoot, 'scripts', name), path.join(fixture, 'scripts', name));
  }
  const vault = path.join(fixture, '我的 笔记');
  await mkdir(path.join(vault, '分类', '测试.assets'), { recursive: true });
  const notePath = '分类/测试.md';
  await writeFile(path.join(vault, notePath), '# 本地测试\n\n原始正文\n');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8WQAAAAASUVORK5CYII=', 'base64');
  await writeFile(path.join(vault, '分类', '测试.assets', '图片.png'), png);

  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  await writeFile(path.join(fixture, '.env.local'), `KNOWLEDGE_BASE_PATH="./我的 笔记"\nKNOWLEDGE_BASE_API_PORT=${port}\n`);
  const env = { ...process.env };
  delete env.KNOWLEDGE_BASE_PATH;
  delete env.KNOWLEDGE_BASE_API_PORT;
  child = spawn(process.execPath, [path.join(fixture, 'scripts', 'sync-notes.mjs'), '--watch'], { env, cwd: tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', (data) => { logs += data; });
  child.stderr.on('data', (data) => { logs += data; });
  const base = `http://127.0.0.1:${port}`;
  async function waitFor(check) {
    for (let i = 0; i < 80; i += 1) {
      if (child.exitCode !== null) assert.fail(logs);
      try { if (await check()) return; } catch { /* Retry until ready. */ }
      await delay(100);
    }
    assert.fail(`Timed out: ${logs}`);
  }
  await waitFor(async () => (await fetch(`${base}/health`)).ok);
  const status = await (await fetch(`${base}/health`)).json();
  assert.equal(status.notesRoot, vault);
  assert.equal(status.service, 'zhixu-notes');
  const index = () => readFile(path.join(fixture, 'public', 'notes-index.json'), 'utf8').then(JSON.parse);
  assert.equal((await index()).notes[0].path, notePath);
  const query = new URLSearchParams({ notePath, src: '.\\测试.assets\\图片.png' });
  const image = await fetch(`${base}/assets?${query}`);
  assert.equal(image.status, 200);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  const saved = await fetch(`${base}/notes/content`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: notePath, body: '# 更新\n\n本地保存成功' }),
  });
  assert.equal(saved.status, 200);
  assert.match(await readFile(path.join(vault, notePath), 'utf8'), /本地保存成功/);
  const upload = await fetch(`${base}/notes/images?${new URLSearchParams({ notePath })}`, {
    method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png,
  });
  assert.equal(upload.status, 200);
  const { url } = await upload.json();
  assert.deepEqual(await readFile(path.join(vault, '分类', url)), png);
  const manage = (input, origin) => fetch(`${base}/files`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify(input),
  });
  const tagsSaved = await fetch(`${base}/notes/tags`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: notePath, tags: ['Java'] }) });
  assert.equal(tagsSaved.status, 200);
  const tagsRenamed = await manage({ action: 'rename-tag', tag: 'Java', name: '后端' });
  assert.equal(tagsRenamed.status, 200);
  const renamedIndex = (await tagsRenamed.json()).index;
  assert.match(renamedIndex.notes.find((note) => note.path === notePath).raw, /后端/);
  const tagsDeleted = await manage({ action: 'delete-tag', tag: '后端' });
  assert.equal(tagsDeleted.status, 200);
  assert.match(await readFile(path.join(vault, notePath), 'utf8'), /本地保存成功/);
  assert.equal((await manage({ action: 'create-folder', name: '移动目标' }, 'https://example.com')).status, 403);
  const folderResponse = await manage({ action: 'create-folder', name: '移动目标' });
  assert.equal(folderResponse.status, 200);
  assert.ok((await folderResponse.json()).index.folders.includes('移动目标'));
  const createdResponse = await manage({ action: 'create-note', name: '新笔记', folder: '移动目标' });
  assert.equal(createdResponse.status, 200);
  assert.ok((await createdResponse.json()).index.notes.some((note) => note.path === '移动目标/新笔记.md'));
  const movedResponse = await manage({ action: 'move-note', path: notePath, folder: '移动目标' });
  assert.equal(movedResponse.status, 200);
  const movedResult = await movedResponse.json();
  assert.equal(movedResult.path, '移动目标/测试.md');
  assert.ok(movedResult.index.notes.some((note) => note.path === movedResult.path));
  assert.ok(!movedResult.index.notes.some((note) => note.path === notePath));
  const movedImage = await fetch(`${base}/assets?${new URLSearchParams({ notePath: movedResult.path, src: url })}`);
  assert.equal(movedImage.status, 200);
  assert.deepEqual(Buffer.from(await movedImage.arrayBuffer()), png);
  const renamedNoteResponse = await manage({ action: 'rename-note', path: '移动目标/新笔记.md', name: '整理笔记' });
  assert.equal(renamedNoteResponse.status, 200);
  assert.equal((await renamedNoteResponse.json()).path, '移动目标/整理笔记.md');
  const renamedFolderResponse = await manage({ action: 'rename-folder', path: '移动目标', name: '已整理' });
  assert.equal(renamedFolderResponse.status, 200);
  assert.ok((await renamedFolderResponse.json()).index.notes.some((note) => note.path === '已整理/整理笔记.md'));

  const escape = await fetch(`${base}/assets?${new URLSearchParams({ notePath, src: '../../outside.png' })}`);
  assert.equal(escape.status, 404);
  await writeFile(path.join(vault, '新增.md'), '# 自动同步');
  await waitFor(async () => (await index()).notes.some((note) => note.path === '新增.md'));
  const secondVault = path.join(fixture, '另一处本地目录');
  await mkdir(secondVault);
  await writeFile(path.join(secondVault, '新增.md'), '# 新知识库');
  const openFolder = (folder, headers = {}) => fetch(`${base}/workspace/open`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ path: folder }),
  });
  assert.equal((await openFolder(secondVault, { Origin: 'https://example.com' })).status, 403);
  const switched = await openFolder(secondVault);
  assert.equal(switched.status, 200);
  assert.equal((await switched.json()).workspace, secondVault);
  assert.equal((await index()).notes.length, 1);
  assert.equal((await index()).workspace, secondVault);
  assert.equal((await (await fetch(`${base}/health`)).json()).notesRoot, secondVault);
  const staleSave = await fetch(`${base}/notes/content`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Zhixu-Workspace': encodeURIComponent(vault) }, body: JSON.stringify({ path: '新增.md', body: 'stale tab' }) });
  assert.equal(staleSave.status, 409);
  assert.equal(await readFile(path.join(secondVault, '新增.md'), 'utf8'), '# 新知识库');
  assert.equal(await readFile(path.join(vault, '新增.md'), 'utf8'), '# 自动同步');
  await writeFile(path.join(secondVault, 'watch-new.md'), '# watch new folder');
  await waitFor(async () => (await index()).notes.some((note) => note.path === 'watch-new.md'));
  assert.equal((await openFolder(path.join(fixture, 'does-not-exist'))).status, 400);
  assert.equal((await (await fetch(`${base}/health`)).json()).notesRoot, secondVault);
  const persisted = JSON.parse(await readFile(path.join(fixture, '.knowledge-base.local.json'), 'utf8'));
  assert.equal(persisted.notesRoot, secondVault);
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
  child = spawn(process.execPath, [path.join(fixture, 'scripts', 'sync-notes.mjs'), '--watch'], { env, cwd: tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (data) => { logs += data; });
  child.stderr.on('data', (data) => { logs += data; });
  await waitFor(async () => (await fetch(`${base}/health`)).ok);
  assert.equal((await (await fetch(`${base}/health`)).json()).notesRoot, secondVault);

});
