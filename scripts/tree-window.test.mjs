import assert from 'node:assert/strict';
import test from 'node:test';
import { treeWindow } from '../app/tree-window.mjs';
test('large trees keep the visible area mounted at top, middle and end', () => {
  for (const top of [0, 12345, 379400]) {
    const w = treeWindow(10000, top, 600);
    assert.ok(w.end - w.start <= 32);
    assert.ok(w.offset <= top);
    assert.ok(w.end * 38 >= top + 600);
    assert.equal(w.total, 380000);
  }
});
test('collapse and filtering clamp stale scroll offsets without an empty window', () => {
  assert.deepEqual(treeWindow(3, 379400, 600), { start: 0, end: 3, offset: 0, total: 114 });
  assert.deepEqual(treeWindow(0, 379400, 600), { start: 0, end: 0, offset: 0, total: 0 });
});
