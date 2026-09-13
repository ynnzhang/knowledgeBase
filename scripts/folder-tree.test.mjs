import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFolderTree } from '../app/folder-tree.ts';
const note = (path) => ({ id: `local-${path}`, path, name: path.split(/[\\/]/).at(-1) });
function entries(folder) {
  return [...folder.notes, ...(folder.document ? [folder.document] : []), ...[...folder.folders.values()].flatMap(entries)];
}

test('Feishu parent documents share folder rows at every level without changing note identity', () => {
  const notes = ['飞书/技术提升.md', '飞书/技术提升/算法.md', '飞书/技术提升/算法/回溯.md'].map(note);
  const root = buildFolderTree(notes, ['飞书', '飞书/技术提升', '飞书/技术提升/算法']);
  const wiki = root.folders.get('飞书');
  const tech = wiki.folders.get('技术提升');
  const algorithms = tech.folders.get('算法');
  assert.deepEqual(wiki.notes, []);
  assert.deepEqual(tech.notes, []);
  assert.equal(tech.document, notes[0]);
  assert.equal(algorithms.document, notes[1]);
  assert.deepEqual(algorithms.notes, [notes[2]]);
  assert.deepEqual(entries(root).map((n) => n.id).sort(), notes.map((n) => n.id).sort());
});

test('standalone notes, empty folders and documents with similar titles stay reachable', () => {
  const notes = ['算法.md', '其他/算法.md', '普通.md'].map(note);
  const root = buildFolderTree(notes, ['算法', '空文件夹', '其他']);
  assert.equal(root.folders.get('算法').document, notes[0]);
  assert.equal(root.folders.get('其他').document, undefined);
  assert.deepEqual(root.folders.get('其他').notes, [notes[1]]);
  assert.deepEqual(root.notes, [notes[2]]);
  assert.ok(root.folders.has('空文件夹'));
});

test('search matching only a parent document returns a folder, never a duplicate Markdown row', () => {
  const parent = note('算法.md'), child = note('算法/回溯.md');
  const root = buildFolderTree([parent, child], ['算法'], new Set([parent.id]));
  assert.deepEqual(root.notes, []);
  assert.equal(root.folders.get('算法').document, parent);
  assert.deepEqual(root.folders.get('算法').notes, []);
});

test('child search or tag matches retain the parent document context-menu entry', () => {
  const parent = note('算法.md'), child = note('算法/回溯.md');
  const notes = Object.freeze([Object.freeze(parent), Object.freeze(child)]);
  const root = buildFolderTree(notes, ['算法', '其他'], new Set([child.id]));
  assert.equal(root.folders.get('算法').document, parent);
  assert.deepEqual(root.folders.get('算法').notes, [child]);
  assert.ok(!root.folders.has('其他'));
  assert.equal(buildFolderTree(notes, ['算法'], new Set()).folders.size, 0);
});

test('Windows separators and Markdown extensions are normalized for display only', () => {
  const parent = note('飞书\\算法.MDOWN'), child = note('飞书\\算法\\回溯.md');
  const folder = buildFolderTree([parent, child], ['飞书\\算法']).folders.get('飞书').folders.get('算法');
  assert.equal(folder.document, parent);
  assert.equal(folder.document.path, '飞书\\算法.MDOWN');
  assert.deepEqual(folder.notes, [child]);
});

test('ambiguous sibling documents remain visible rather than hiding one arbitrarily', () => {
  const notes = ['算法.md', '算法.mdown', '算法/回溯.md'].map(note);
  const root = buildFolderTree(notes, ['算法']);
  assert.equal(root.folders.get('算法').document, undefined);
  assert.deepEqual(root.notes, notes.slice(0, 2));
  assert.equal(entries(root).length, 3);
});
