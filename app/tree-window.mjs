// Share the arithmetic with tests; the UI only mounts this window of rows.
export function treeWindow(length, top, height, rowHeight = 38, overscan = 8) {
  const size = Math.ceil(height / rowHeight) + overscan * 2;
  const start = Math.min(Math.max(0, length - size), Math.max(0, Math.floor(top / rowHeight) - overscan));
  return { start, end: Math.min(length, start + size), offset: start * rowHeight, total: length * rowHeight };
}
