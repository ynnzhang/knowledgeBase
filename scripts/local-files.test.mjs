import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createLocalFiles, relocateLinks } from './local-files.mjs';
import { hashBody } from './feishu-markdown.mjs';
import { prepareImageMarkdown } from './feishu-media.mjs';
const digest = (raw) => createHash('sha256').update(hashBody(raw)).digest('hex');
const png = Buffer.from('89504e470d0a1a0a', 'hex');
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'zhixu-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = createLocalFiles({ notesRoot: root });
  const read = (file) => readFile(path.join(root, file), 'utf8');
  const write = async (file, raw) => { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), raw); };
  return { root, manager, read, write };
}

test('delete preserves recoverable content and assets, detaching only matching Feishu entries', async (t) => {
  const { root, manager, write, read } = await fixture(t);
  const raw = '---\r\ntitle: 笔记\r\n---\r\n![图](./笔记.assets/a.png)';
  await write('算法/笔记.md', raw);
  await write('算法/笔记.assets/a.png', png);
  await write('其他.md', '[笔记](算法/笔记.md)');
  const entry = { path: '算法/笔记.md', nodeToken: 'remote', scope: 'scope' };
  const other = { path: '其他.md', nodeToken: 'other' };
  const directories = [{ path: '算法', nodeToken: 'parent' }];
  await write('.zhixu-feishu/state.json', JSON.stringify({ version: 1, entries: [entry, other], directories }));
  const result = await manager.execute({ action: 'delete-note', path: entry.path, confirmed: true });
  await assert.rejects(lstat(path.join(root, entry.path)), { code: 'ENOENT' });
  assert.equal(await read(result.trashPath), raw);
  const manifest = JSON.parse(await read(`${result.backup}/manifest.json`));
  assert.equal(manifest.path, entry.path);
  assert.deepEqual(manifest.entries, [entry]);
  const state = JSON.parse(await read('.zhixu-feishu/state.json'));
  assert.deepEqual(state.entries, [other]);
  assert.deepEqual(state.directories, directories);
  assert.deepEqual(await readFile(path.join(root, '算法/笔记.assets/a.png')), png);
  assert.equal(await read('其他.md'), '[笔记](算法/笔记.md)');
  await write(entry.path, '新版');
  const second = await manager.execute({ action: 'delete-note', path: entry.path, confirmed: true });
  assert.notEqual(second.trashPath, result.trashPath);
  assert.equal(await read(result.trashPath), raw);
  assert.equal(await read(second.trashPath), '新版');
});

test('delete requires confirmation and rejects invalid paths and pending sync', async (t) => {
  const { root, manager, write, read } = await fixture(t);
  await write('note.md', '保留');
  await mkdir(path.join(root, 'folder.md'));
  await assert.rejects(manager.execute({ action: 'delete-note', path: 'note.md' }), /确认/);
  for (const source of ['', 'folder.md', '../note.md', '.trash/note.md', 'a/../note.md', 'a\\note.md', 'missing.md']) {
    await assert.rejects(manager.execute({ action: 'delete-note', path: source, confirmed: true }));
  }
  for (const pending of [{ pending: {} }, { pendingMove: {} }]) {
    await write('.zhixu-feishu/state.json', JSON.stringify({ version: 1, entries: [{ path: 'note.md', ...pending }] }));
    await assert.rejects(manager.execute({ action: 'delete-note', path: 'note.md', confirmed: true }), /未完成/);
  }
  await write('.zhixu-feishu/sync.lock', 'occupied');
  await assert.rejects(manager.execute({ action: 'delete-note', path: 'note.md', confirmed: true }), /同步或移动/);
  assert.equal(await read('note.md'), '保留');
  assert.equal(manager.busy, false);
});

test('delete refuses symlinked source and trash directories', async (t) => {
  const { root, manager, write, read } = await fixture(t);
  const outside = await mkdtemp(path.join(tmpdir(), 'zhixu-trash-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await write('note.md', '保留');
  await writeFile(path.join(outside, 'note.md'), '外部');
  await symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(manager.execute({ action: 'delete-note', path: 'linked/note.md', confirmed: true }), /符号链接/);
  await symlink(outside, path.join(root, '.trash'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(manager.execute({ action: 'delete-note', path: 'note.md', confirmed: true }), /符号链接/);
  assert.equal(await read('note.md'), '保留');
  assert.equal(await readFile(path.join(outside, 'note.md'), 'utf8'), '外部');
});

test('delete unassociated Markdown notes without creating sync state', async (t) => {
  const { manager, write, read } = await fixture(t);
  await write('学习.MDOWN', '内容');
  const result = await manager.execute({ action: 'delete-note', path: '学习.MDOWN', confirmed: true });
  assert.equal(await read(result.trashPath), '内容');
  await assert.rejects(read('.zhixu-feishu/state.json'), { code: 'ENOENT' });
});

test('create folders and notes in a selected directory without overwriting', async (t) => {
  const { manager, read } = await fixture(t);
  assert.equal((await manager.execute({ action: 'create-folder', name: '技术提升' })).path, '技术提升');
  const note = await manager.execute({ action: 'create-note', name: 'MyBatis', folder: '技术提升' });
  assert.equal(note.path, '技术提升/MyBatis.md');
  assert.match(await read(note.path), /title: "MyBatis"/);
  await assert.rejects(manager.execute({ action: 'create-note', name: 'MyBatis.md', folder: '技术提升' }), /同名/);
  await assert.rejects(manager.execute({ action: 'create-folder', name: '技术提升' }), /同名/);
  await assert.rejects(manager.execute({ action: 'create-note', name: '测试', folder: 'missing' }), /不存在/);
});

test('reject path traversal, hidden folders, symlinks, and concurrent sync locks', async (t) => {
  const { root, manager, write } = await fixture(t);
  for (const name of ['../bad', '.zhixu-feishu', 'x/y', 'CON', 'bad?', 'img.assets']) {
    await assert.rejects(manager.execute({ action: 'create-folder', name }));
  }
  for (const folder of ['../', '/tmp', '.zhixu-feishu', 'a/../']) {
    await assert.rejects(manager.execute({ action: 'create-note', name: 'note', folder }));
  }
  await symlink(tmpdir(), path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(manager.execute({ action: 'create-note', name: 'note', folder: 'linked' }), /符号链接/);
  await write('.zhixu-feishu/sync.lock', 'occupied');
  await assert.rejects(manager.execute({ action: 'create-note', name: 'note' }), /同步或移动/);
  assert.equal(manager.busy, false);
});

test('moving a note preserves assets, metadata and inbound and outbound references', async (t) => {
  const { root, manager, write, read } = await fixture(t);
  const raw = '---\ntitle: MyBatis\ntags: [Java]\n---\n\n![图](./MyBatis.assets/a.png)\n\n[其他](./Other.md?x=1#part)\n\n<img src="../shared.png" width="100" />\n';
  await write('old/MyBatis.md', raw);
  await write('old/MyBatis.assets/a.png', png);
  await write('old/Other.md', '[MyBatis](./MyBatis.md)\n\n![图片](./MyBatis.assets/a.png)');
  await write('shared.png', png);
  await manager.execute({ action: 'create-folder', name: 'new' });
  const assetHash = (await prepareImageMarkdown('![图](./MyBatis.assets/a.png)', async () => png)).assetHash;
  await write('.zhixu-feishu/state.json', JSON.stringify({ version: 1, entries: [{ path: 'old/MyBatis.md', scope: 'scope', nodeToken: 'same-node', wikiPath: ['old', 'MyBatis'], localHash: digest(raw), assetHash }], directories: [{ path: 'old', nodeToken: 'parent' }] }));
  const result = await manager.execute({ action: 'move-note', path: 'old/MyBatis.md', folder: 'new' });
  assert.equal(result.path, 'new/MyBatis.md');
  await assert.rejects(lstat(path.join(root, 'old/MyBatis.md')), { code: 'ENOENT' });
  await assert.rejects(lstat(path.join(root, 'old/MyBatis.assets')), { code: 'ENOENT' });
  assert.deepEqual(await readFile(path.join(root, 'new/MyBatis.assets/a.png')), png);
  const moved = await read(result.path);
  assert.match(moved, /tags: \[Java\]/);
  assert.match(moved, /\.\/MyBatis.assets\/a.png/);
  assert.match(moved, /\.\.\/old\/Other.md\?x=1#part/);
  assert.match(moved, /src="\.\.\/shared.png" width="100"/);
  assert.match(await read('old/Other.md'), /\.\.\/new\/MyBatis.md/);
  assert.match(await read('old/Other.md'), /\.\.\/new\/MyBatis.assets\/a.png/);
  const state = JSON.parse(await read('.zhixu-feishu/state.json'));
  assert.equal(state.entries[0].path, result.path);
  assert.equal(state.entries[0].nodeToken, 'same-node');
  assert.equal(state.entries[0].localHash, digest(moved));
  assert.deepEqual(state.entries[0].wikiPath, ['old', 'MyBatis']);
  assert.equal(state.directories[0].path, 'old');
  assert.equal(JSON.parse(await read(result.backup)).changes.find((change) => change.oldPath === 'old/MyBatis.md').raw, raw);
});

test('moved notes update image fingerprints only for unchanged images and preserve unsynced edits', async (t) => {
  const { manager, write, read } = await fixture(t);
  const raw = '![图](./a.png)';
  await write('source/note.md', raw);
  await write('source/a.png', png);
  await manager.execute({ action: 'create-folder', name: 'target' });
  const assetHash = (await prepareImageMarkdown(raw, async () => png)).assetHash;
  await write('.zhixu-feishu/state.json', JSON.stringify({ version: 1, entries: [
    { path: 'source/note.md', scope: 'one', localHash: 'unsynced-body', assetHash },
    { path: 'source/note.md', scope: 'two', localHash: digest(raw), assetHash: 'unsynced-image' },
  ] }));
  await manager.execute({ action: 'move-note', path: 'source/note.md', folder: 'target' });
  const moved = await read('target/note.md');
  const state = JSON.parse(await read('.zhixu-feishu/state.json'));
  assert.equal(state.entries[0].localHash, 'unsynced-body');
  assert.equal(state.entries[0].assetHash, (await prepareImageMarkdown(moved, async () => png)).assetHash);
  assert.equal(state.entries[1].path, 'target/note.md');
  assert.equal(state.entries[1].assetHash, 'unsynced-image');
  assert.equal(state.entries[1].localHash, digest(moved));
});

test('destination collisions and pending sync stop a move without changing files', async (t) => {
  const { manager, write, read, root } = await fixture(t);
  await write('source/note.md', '# source');
  await write('target/note.md', '# target');
  await assert.rejects(manager.execute({ action: 'move-note', path: 'source/note.md', folder: 'target' }), /同名/);
  assert.equal(await read('target/note.md'), '# target');
  await rm(path.join(root, 'target/note.md'));
  await write('source/note.assets/a.png', png);
  await write('target/note.assets/other.png', png);
  await assert.rejects(manager.execute({ action: 'move-note', path: 'source/note.md', folder: 'target' }), /图片目录/);
  await rm(path.join(root, 'target/note.assets'), { recursive: true });
  await write('.zhixu-feishu/state.json', JSON.stringify({ version: 1, entries: [{ path: 'source/note.md', pending: 'backup.json' }] }));
  await assert.rejects(manager.execute({ action: 'move-note', path: 'source/note.md', folder: 'target' }), /未完成/);
  await write('.zhixu-feishu/state.json', JSON.stringify({ version: 1, entries: [{ path: 'target/note.md' }] }));
  await assert.rejects(manager.execute({ action: 'move-note', path: 'source/note.md', folder: 'target' }), /关联记录/);
  assert.equal(await read('source/note.md'), '# source');
});

test('Markdown relocation excludes code and metadata and handles definitions, nested links and HTML', () => {
  const raw = '---\ntitle: "[test](note.md)"\n---\n\n[![图](./note.assets/a.png)](./note.md#heading)\n\n![ref][pic]\n\n[pic]: <./note.assets/a%20b.png> "title"\n\n`[test](note.md)`\n\n```md\n![test](note.assets/a.png)\n```\n\n<a href="./note.md">笔记</a>\n\n<img src="./note.assets/a.png" />\n\n[web](https://example.com/note.md)\n';
  const next = relocateLinks(raw, 'old/other.md', 'old/other.md', 'old/note.md', 'new/note.md', true);
  assert.match(next, /title: "\[test\]\(note.md\)"/);
  assert.match(next, /\[!\[图\]\(\.\.\/new\/note.assets\/a.png\)\]\(\.\.\/new\/note.md#heading\)/);
  assert.match(next, /\[pic\]: <\.\.\/new\/note.assets\/a%20b.png> "title"/);
  assert.match(next, /`\[test\]\(note.md\)`/);
  assert.match(next, /```md\n!\[test\]\(note.assets\/a.png\)\n```/);
  assert.match(next, /href="\.\.\/new\/note.md"/);
  assert.match(next, /src="\.\.\/new\/note.assets\/a.png"/);
  assert.match(next, /https:\/\/example.com\/note.md/);
});

test('folder moves carry nested notes, assets and other files, updating backlinks and sync paths', async (t) => {
  const { root, manager, write, read } = await fixture(t);
  const raw = '# Note\n\n![image](./Note.assets/a.png)\n\n[外部](../../outside.md)';
  await write('old/sub/Note.md', raw);
  await write('old/sub/Note.assets/a.png', png);
  await write('old/attachment.txt', 'keep this file');
  await write('outside.md', '[note](./old/sub/Note.md)\n\n![image](./old/sub/Note.assets/a.png)');
  await manager.execute({ action: 'create-folder', name: 'target' });
  await write('.zhixu-feishu/state.json', JSON.stringify({ version: 1, entries: [{ path: 'old/sub/Note.md', localHash: digest(raw), nodeToken: 'same' }, { path: 'old/missing.md', nodeToken: 'missing' }], directories: [{ path: 'old/sub', nodeToken: 'sub' }] }));
  const result = await manager.execute({ action: 'move-folder', path: 'old', folder: 'target' });
  assert.equal(result.path, 'target/old');
  assert.equal(await read('target/old/attachment.txt'), 'keep this file');
  assert.deepEqual(await readFile(path.join(root, 'target/old/sub/Note.assets/a.png')), png);
  const moved = await read('target/old/sub/Note.md');
  assert.match(moved, /\.\.\/\.\.\/\.\.\/outside.md/);
  assert.match(await read('outside.md'), /target\/old\/sub\/Note.md/);
  assert.match(await read('outside.md'), /target\/old\/sub\/Note.assets\/a.png/);
  const state = JSON.parse(await read('.zhixu-feishu/state.json'));
  assert.equal(state.entries[0].path, 'target/old/sub/Note.md');
  assert.equal(state.entries[0].localHash, digest(moved));
  assert.equal(state.entries[0].nodeToken, 'same');
  assert.equal(state.entries[1].path, 'target/old/missing.md');
  assert.equal(state.directories[0].path, 'target/old/sub');
  await assert.rejects(lstat(path.join(root, 'old')), { code: 'ENOENT' });
  await manager.execute({ action: 'move-folder', path: 'target/old', folder: '' });
  assert.equal(await read('old/attachment.txt'), 'keep this file');
});

test('folder moves reject cycles, collisions and symlinks; empty folders can move', async (t) => {
  const { root, manager, write } = await fixture(t);
  await write('parent/child/a.md', '# a');
  await assert.rejects(manager.execute({ action: 'move-folder', path: 'parent', folder: 'parent' }), /自身/);
  await assert.rejects(manager.execute({ action: 'move-folder', path: 'parent', folder: 'parent/child' }), /自身/);
  await write('target/parent/existing.md', '# keep');
  await assert.rejects(manager.execute({ action: 'move-folder', path: 'parent', folder: 'target' }), /同名/);
  await manager.execute({ action: 'create-folder', name: 'empty' });
  await manager.execute({ action: 'move-folder', path: 'empty', folder: 'target' });
  assert.ok((await lstat(path.join(root, 'target/empty'))).isDirectory());
  await symlink(tmpdir(), path.join(root, 'parent/child/link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(manager.execute({ action: 'move-folder', path: 'parent', folder: 'target/empty' }), /符号链接/);
});

test('global tag rename merges duplicates and delete removes labels while preserving note content and sync state', async (t) => {
  const { manager, write, read } = await fixture(t);
  const first = '---\ntitle: First\ntags: [Java, 后端]\nupdated: 2024-01-01\ncustom: keep\n---\n\n# 内容\n\n![图](./First.assets/a.png)\n';
  const second = '---\ntag: "Java, 数据库"\n---\n\n第二篇正文\n';
  const untouched = '# no tags\n';
  await write('First.md', first);
  await write('nested/Second.md', second);
  await write('untouched.md', untouched);
  const state = JSON.stringify({ version: 1, entries: [{ path: 'First.md', localHash: digest(first), nodeToken: 'same' }] });
  await write('.zhixu-feishu/state.json', state);
  const renamed = await manager.execute({ action: 'rename-tag', tag: 'Java', name: '后端' });
  assert.equal(renamed.changed, 2);
  assert.equal(digest(await read('First.md')), digest(first));
  assert.equal(digest(await read('nested/Second.md')), digest(second));
  assert.match(await read('First.md'), /custom: keep/);
  assert.equal(await read('.zhixu-feishu/state.json'), state);
  assert.equal(await read('untouched.md'), untouched);
  const { readNoteTags } = await import('./note-tags.mjs');
  assert.deepEqual(readNoteTags(await read('First.md')), ['后端']);
  assert.deepEqual(readNoteTags(await read('nested/Second.md')), ['后端', '数据库']);
  assert.equal(JSON.parse(await read(renamed.backup)).changes[0].raw, first);
  assert.equal((await manager.execute({ action: 'delete-tag', tag: '后端' })).changed, 2);
  assert.deepEqual(readNoteTags(await read('First.md')), []);
  assert.deepEqual(readNoteTags(await read('nested/Second.md')), ['数据库']);
  assert.equal(digest(await read('First.md')), digest(first));
});

test('tag management validates every note before writing and respects sync locks', async (t) => {
  const { manager, write, read } = await fixture(t);
  const raw = '---\ntags: [Java]\n---\n\n# keep';
  await write('a.md', raw);
  await write('b.md', '---\ntags: [broken\n---\n\n# bad');
  await assert.rejects(manager.execute({ action: 'delete-tag', tag: 'Java' }), /YAML/);
  assert.equal(await read('a.md'), raw);
  await write('.zhixu-feishu/sync.lock', 'busy');
  await assert.rejects(manager.execute({ action: 'rename-tag', tag: 'Java', name: 'New' }), /同步或移动/);
  assert.equal(await read('a.md'), raw);
});

test('single-note tag edits preserve exact Markdown whitespace and support legacy tag formats', async () => {
  const { readNoteTags, normalizeTags, updateNoteTags } = await import('./note-tags.mjs');
  const raw = '---\nkeywords: "Java，数据库"\ncustom: keep\n---\n\n\n  indented\n';
  assert.deepEqual(readNoteTags(raw), ['Java', '数据库']);
  const next = updateNoteTags(raw, [], new Date('2024-01-01'));
  assert.deepEqual(readNoteTags(next), []);
  assert.ok(next.endsWith('\n\n\n  indented\n'));
  assert.match(next, /custom: keep/);
  assert.deepEqual(normalizeTags(['#Java', 'Java', '', '  数据库 ']), ['Java', '数据库']);
});

test('renaming notes preserves extensions, moves images and repairs references and Feishu associations', async (t) => {
  const { root, manager, read, write } = await fixture(t);
  const raw = '---\ntags: [Java]\n---\n\n![图](./Old.assets/a.png)';
  await write('folder/Old.md', raw);
  await write('folder/Old.assets/a.png', png);
  await write('backlink.md', '[note](./folder/Old.md)');
  await write('.zhixu-feishu/state.json', JSON.stringify({ version: 1, entries: [{ path: 'folder/Old.md', localHash: digest(raw), nodeToken: 'same', wikiPath: ['Remote', 'Old'] }] }));
  const result = await manager.execute({ action: 'rename-note', path: 'folder/Old.md', name: 'New Name' });
  assert.equal(result.path, 'folder/New Name.md');
  assert.match(await read(result.path), /New%20Name.assets\/a.png/);
  assert.match(await read('backlink.md'), /folder\/New%20Name.md/);
  assert.deepEqual(await readFile(path.join(root, 'folder/New Name.assets/a.png')), png);
  const state = JSON.parse(await read('.zhixu-feishu/state.json'));
  assert.equal(state.entries[0].path, result.path);
  assert.equal(state.entries[0].nodeToken, 'same');
  assert.deepEqual(state.entries[0].wikiPath, ['Remote', 'Old']);
  assert.equal(state.entries[0].localHash, digest(await read(result.path)));
});

test('folder renaming preserves descendants, rejects collisions and unsafe names', async (t) => {
  const { manager, write, read } = await fixture(t);
  await write('Old/sub/note.md', '# keep');
  await write('backlink.md', '[note](./Old/sub/note.md)');
  const result = await manager.execute({ action: 'rename-folder', path: 'Old', name: '新的目录' });
  assert.equal(result.path, '新的目录');
  assert.equal(await read('新的目录/sub/note.md'), '# keep');
  assert.match(await read('backlink.md'), new RegExp(encodeURIComponent('新的目录')));
  await write('Existing/keep.md', '# existing');
  await assert.rejects(manager.execute({ action: 'rename-folder', path: '新的目录', name: 'Existing' }), /同名/);
  for (const name of ['../escape', '.zhixu-feishu', 'a/b', '', 'bad?']) await assert.rejects(manager.execute({ action: 'rename-folder', path: '新的目录', name }));
  assert.equal(await read('Existing/keep.md'), '# existing');
});

test('case-only and extension-only renames keep the sidecar images intact', async (t) => {
  const { manager, write, read, root } = await fixture(t);
  await write('Case.md', '![图](./Case.assets/a.png)');
  await write('Case.assets/a.png', png);
  await manager.execute({ action: 'rename-note', path: 'Case.md', name: 'case.md' });
  assert.match(await read('case.md'), /case.assets/);
  assert.deepEqual(await readFile(path.join(root, 'case.assets/a.png')), png);
  await manager.execute({ action: 'rename-note', path: 'case.md', name: 'case.mdown' });
  assert.match(await read('case.mdown'), /case.assets/);
  assert.deepEqual(await readFile(path.join(root, 'case.assets/a.png')), png);
  await manager.execute({ action: 'create-folder', name: 'Dir' });
  await manager.execute({ action: 'rename-folder', path: 'Dir', name: 'dir' });
  const { readdir } = await import('node:fs/promises');
  assert.ok((await readdir(root)).includes('dir'));
  assert.ok(!(await readdir(root)).includes('Dir'));
});
