import { lstat, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function atomicWrite(file, content) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close(); handle = null;
    await rename(temporary, file);
  } finally {
    await handle?.close();
    await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

export function createNoteScanner({ read = (file) => readFile(file, 'utf8') } = {}) {
  let cache = new Map();
  const ignored = (name) => name.startsWith('.') || name === 'node_modules' || name.endsWith('.assets');
  const stamp = (info) => `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  return async function scan(root) {
    const folders = [], files = [], nextCache = new Map();
    async function walk(directory) {
      for (const item of await readdir(directory, { withFileTypes: true })) {
        if (ignored(item.name) || item.isSymbolicLink()) continue;
        const absolute = path.join(directory, item.name);
        if (item.isDirectory()) { folders.push(path.relative(root, absolute).split(path.sep).join('/')); await walk(absolute); }
        else if (item.isFile() && /\.md(?:own)?$/i.test(item.name)) files.push(absolute);
      }
    }
    await walk(root);
    files.sort(); folders.sort();
    const notes = new Array(files.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(8, files.length) }, async () => {
      while (cursor < files.length) {
        const index = cursor++, file = files[index], before = await lstat(file);
        if (!before.isFile() || before.isSymbolicLink()) throw new Error('笔记文件类型发生变化，请稍后重试。');
        const key = stamp(before), previous = cache.get(file);
        let note;
        if (previous?.key === key) note = previous.note;
        else {
          const raw = await read(file), after = await lstat(file);
          if (stamp(after) !== key) throw new Error('笔记正在被其他程序写入，请稍后重试。');
          const relative = path.relative(root, file).split(path.sep).join('/');
          note = { id: `local-${relative}`, name: path.basename(file), path: relative, raw, modified: after.mtime.toISOString(), source: 'local' };
        }
        nextCache.set(file, { key, note }); notes[index] = note;
      }
    });
    const completed = await Promise.allSettled(workers);
    const failed = completed.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
    cache = nextCache;
    return { folders, notes };
  };
}
