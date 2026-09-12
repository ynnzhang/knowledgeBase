// Remove legacy token suffixes only from files identified by the sync manifest.
// Dry run by default; --apply renames files/directories and updates associations.
import { lstat, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export async function renameFeishuNotes(notesRoot, apply = false) {
  async function checked(relative) {
    const parts = relative.split('/');
    if (path.isAbsolute(relative) || parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) throw new Error('同步记录中的文件路径无效。');
    let absolute = notesRoot;
    for (const part of parts) {
      absolute = path.join(absolute, part);
      try { if ((await lstat(absolute)).isSymbolicLink()) throw new Error('不能重命名包含符号链接的路径。'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return absolute;
  }
  async function exists(relative) {
    try { await lstat(await checked(relative)); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  const stateFile = await checked('.zhixu-feishu/state.json');
  const lockFile = await checked('.zhixu-feishu/sync.lock');
  let lock;
  if (apply) {
    lock = await open(lockFile, 'wx', 0o600);
    await lock.writeFile(String(process.pid));
  } else if (await exists('.zhixu-feishu/sync.lock')) throw new Error('同步任务正在运行，请完成后再重命名。');
  try {
    const original = await readFile(stateFile, 'utf8');
    const state = JSON.parse(original);
    if (state.version !== 1 || !Array.isArray(state.entries)) throw new Error('同步记录无效。');
    if (state.entries.some((entry) => entry.pending)) throw new Error('存在未完成同步，请先处理后重命名。');
    const changes = [], planned = new Set();
    const entries = [...state.entries].sort((a, b) => b.path.split('/').length - a.path.split('/').length);
    for (const entry of entries) {
      if (!entry.path.startsWith('飞书/')) continue;
      const extension = entry.path.match(/\.md(?:own)?$/i)?.[0];
      if (!extension) continue;
      const stem = entry.path.slice(0, -extension.length);
      const suffix = `-${entry.nodeToken}`;
      if (!path.posix.basename(stem).endsWith(suffix) || planned.has(stem)) continue;
      const clean = stem.slice(0, -suffix.length);
      if (!path.posix.basename(clean)) continue;
      if (!await exists(entry.path)) throw new Error(`找不到已关联文件：${entry.path}`);
      let targetStem = clean;
      for (let number = 2; await exists(`${targetStem}${extension}`) || await exists(targetStem) || planned.has(targetStem.toLowerCase()); number++) targetStem = `${clean}（${number}）`;
      const directory = await exists(stem);
      if (directory && !(await lstat(await checked(stem))).isDirectory()) throw new Error(`预期目录却找到文件：${stem}`);
      changes.push({ from: entry.path, to: `${targetStem}${extension}`, fromDirectory: directory ? stem : null, toDirectory: directory ? targetStem : null });
      planned.add(stem); planned.add(targetStem.toLowerCase());
    }
    if (!apply || !changes.length) return { applied: false, changes };
    const backup = `.zhixu-feishu/rename-${randomUUID()}.json`;
    await writeFile(await checked(backup), JSON.stringify({ originalState: JSON.parse(original), changes }, null, 2), { flag: 'wx', mode: 0o600 });
    for (const change of changes) {
      // Recheck each destination immediately before rename; never overwrite.
      if (await exists(change.to) || (change.toDirectory && await exists(change.toDirectory))) throw new Error(`目标路径已被占用，停止重命名。恢复记录：${backup}`);
      await rename(await checked(change.from), await checked(change.to));
      if (change.fromDirectory) await rename(await checked(change.fromDirectory), await checked(change.toDirectory));
      for (const entry of state.entries) {
        if (entry.path === change.from) entry.path = change.to;
        else if (change.fromDirectory && entry.path.startsWith(`${change.fromDirectory}/`)) entry.path = change.toDirectory + entry.path.slice(change.fromDirectory.length);
      }
      const temporary = `${stateFile}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(state, null, 2), { flag: 'wx', mode: 0o600 });
      await rename(temporary, stateFile);
    }
    return { applied: true, changes, backup, paths: state.entries.map((entry) => entry.path) };
  } finally {
    if (lock) { await lock.close(); await unlink(lockFile); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { notesRoot } = await import('./local-config.mjs');
  console.log(JSON.stringify(await renameFeishuNotes(notesRoot, process.argv.includes('--apply')), null, 2));
}
