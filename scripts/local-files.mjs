import { stat, lstat, mkdir, readFile, readdir, rename, open, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { readNoteTags, normalizeTags, updateNoteTags } from './note-tags.mjs';
import { hashBody, splitFrontmatter } from './feishu-markdown.mjs';
import { prepareImageMarkdown } from './feishu-media.mjs';

const digest = (raw) => createHash('sha256').update(hashBody(raw)).digest('hex');
const hidden = (name) => name.startsWith('.') || name === 'node_modules' || name.endsWith('.assets');
const exists = async (file) => { try { return await lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const assetPath = (file) => file.replace(/\.md(?:own)?$/i, '.assets');

function checkedName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || hidden(name) || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error('名称不能为空，也不能包含路径分隔符或特殊字符。');
  return name;
}

// Rewrite only parsed destinations, leaving code examples and link labels intact.
export function relocateLinks(raw, oldFile, newFile, source, destination, moveAssets, moveFolder = false) {
  const edits = [];
  function target(url) {
    if (!url || /^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(url)) return url;
    const [, pathname, suffix] = url.match(/^([^?#]*)(.*)$/s);
    let decoded;
    try { decoded = decodeURIComponent(pathname).replaceAll('\\', '/'); } catch { return url; }
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(oldFile), decoded));
    let moved = resolved;
    if (resolved === source) moved = destination;
    if (moveFolder && resolved.startsWith(`${source}/`)) moved = destination + resolved.slice(source.length);
    if (moveAssets && resolved.startsWith(`${assetPath(source)}/`)) moved = assetPath(destination) + resolved.slice(assetPath(source).length);
    if (oldFile === newFile && moved === resolved) return url;
    if (resolved.startsWith('../')) return url;
    const relative = path.posix.relative(path.posix.dirname(newFile), moved);
    return (relative.startsWith('.') ? '' : './') + relative.split('/').map(encodeURIComponent).join('/') + suffix;
  }
  function destinationSpan(text, start) {
    while (/\s/.test(text[start] || '') && start < text.length) start++;
    if (text[start] === '<') return [start + 1, text.indexOf('>', start + 1)];
    let end = start, depth = 0;
    for (; end < text.length; end++) {
      if (text[end] === '\\') { end++; continue; }
      if (text[end] === '(') depth++;
      else if (text[end] === ')') { if (!depth) break; depth--; }
      else if (/\s/.test(text[end]) && !depth) break;
    }
    return [start, end];
  }
  function walk(node) {
    const offset = node.position?.start.offset;
    if (['image', 'link', 'definition'].includes(node.type)) {
      const next = target(node.url);
      if (next !== node.url && offset !== undefined) {
        const text = raw.slice(offset, node.position.end.offset);
        const start = node.type === 'definition' ? text.indexOf(']:') + 2 : text.lastIndexOf('](') + 2;
        const [a, b] = destinationSpan(text, start);
        if (start > 1 && b >= a) edits.push({ start: offset + a, end: offset + b, value: next });
      }
    } else if (node.type === 'html' && offset !== undefined) {
      for (const tag of node.value.matchAll(/<(?:img|a)\b[^>]*>/gi)) {
        for (const attribute of tag[0].matchAll(/\b(?:src|href)\s*=\s*(["'])(.*?)\1/gi)) {
          const next = target(attribute[2]);
          if (next !== attribute[2]) {
            const start = offset + tag.index + attribute.index + attribute[0].indexOf(attribute[1]) + 1;
            edits.push({ start, end: start + attribute[2].length, value: next });
          }
        }
      }
    }
    node.children?.forEach(walk);
  }
  // Frontmatter contains metadata, not Markdown destinations.
  const front = raw.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0] || '';
  const parsed = fromMarkdown(front.replace(/[^\r\n]/g, ' ') + raw.slice(front.length));
  walk(parsed);
  for (const edit of edits.sort((a, b) => b.start - a.start)) raw = raw.slice(0, edit.start) + edit.value + raw.slice(edit.end);
  return raw;
}

export function createLocalFiles({ notesRoot }) {
  let busy = false;
  async function safe(relative, { missing = false, privatePath = false } = {}) {
    if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some((part) => part === '..' || part === '.' || (part && !privatePath && hidden(part)))) throw new Error('请选择知识库内的有效路径。');
    let current = notesRoot;
    const parts = relative.split('/').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      const info = await exists(current);
      if (!info && missing && i === parts.length - 1) break;
      if (!info) throw new Error('目标文件夹或笔记不存在，请刷新后重试。');
      if (info.isSymbolicLink()) throw new Error('不支持操作符号链接，请选择知识库内的实际文件夹。');
      if (i < parts.length - 1 && !info.isDirectory()) throw new Error('路径中包含非文件夹项目。');
    }
    return current;
  }
  async function listNotes(directory = '') {
    const result = [];
    for (const item of await readdir(path.join(notesRoot, directory), { withFileTypes: true })) {
      if (item.isSymbolicLink() || hidden(item.name)) continue;
      const relative = path.posix.join(directory, item.name);
      if (item.isDirectory()) result.push(...await listNotes(relative));
      else if (item.isFile() && /\.md(?:own)?$/i.test(item.name)) result.push(relative);
    }
    return result;
  }
  async function imageHash(file, raw) {
    try {
      return (await prepareImageMarkdown(splitFrontmatter(raw).body, async (src) => {
        const relative = path.posix.normalize(path.posix.join(path.posix.dirname(file), decodeURIComponent(src).replaceAll('\\', '/')));
        return readFile(await safe(relative, { privatePath: true }));
      })).assetHash;
    } catch { return null; }
  }
  async function manageTags(input) {
    const tag = typeof input.tag === 'string' ? input.tag.trim() : '';
    const replacement = normalizeTags([input.name || ''])[0];
    if (!tag || (input.action === 'rename-tag' && !replacement)) throw new Error('标签名称不能为空。');
    if (input.action === 'rename-tag' && tag === replacement) return { changed: 0 };
    const changes = [];
    for (const file of await listNotes()) {
      const absolute = await safe(file);
      const raw = await readFile(absolute, 'utf8');
      const tags = readNoteTags(raw);
      if (!tags.includes(tag)) continue;
      const nextTags = [...new Set(tags.flatMap((item) => item !== tag ? [item] : input.action === 'delete-tag' ? [] : [replacement]))];
      const next = updateNoteTags(raw, nextTags, (await stat(absolute)).mtime);
      changes.push({ path: file, raw, next });
    }
    if (!changes.length) return { changed: 0 };
    const backup = `.zhixu-feishu/tags-${randomUUID()}.json`;
    await writeFile(path.join(notesRoot, backup), JSON.stringify({ action: input.action, tag, changes }, null, 2), { flag: 'wx', mode: 0o600 });
    const written = [];
    try {
      for (const change of changes) {
        const file = await safe(change.path);
        if (await readFile(file, 'utf8') !== change.raw) throw new Error('笔记已被其他程序修改，请刷新后重试。');
        written.push(change);
        const temp = `${file}.${randomUUID()}.tmp`;
        await writeFile(temp, change.next, { flag: 'wx' });
        await rename(temp, file);
      }
    } catch (error) {
      try { for (const change of written.reverse()) await writeFile(path.join(notesRoot, change.path), change.raw); }
      catch { throw new Error(`标签操作中断，请使用备份恢复：${backup}`); }
      throw error;
    }
    return { changed: changes.length, backup };
  }

  async function checkDirectory(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (item.isSymbolicLink()) throw new Error('文件夹包含符号链接，请先移除链接再移动。');
      if (item.isDirectory()) await checkDirectory(path.join(directory, item.name));
    }
  }
  async function changeCase(source, destination) {
    const temporary = path.join(path.dirname(source), `.rename-${randomUUID()}`);
    await rename(source, temporary);
    try { await rename(temporary, destination); }
    catch (error) { await rename(temporary, source); throw error; }
  }
  async function sameCaseInsensitiveEntry(source, destination) {
    if (source.toLowerCase() !== destination.toLowerCase() || source === destination) return false;
    const [left, right] = await Promise.all([exists(source), exists(destination)]);
    return Boolean(left && right && left.ino === right.ino && left.dev === right.dev
      && !(await readdir(path.dirname(destination))).includes(path.basename(destination)));
  }
  async function move(input, folder) {
    const source = input.path;
    const moveFolder = input.action.endsWith('-folder');
    const renaming = input.action.startsWith('rename-');
    if (typeof source !== 'string' || !source || (!moveFolder && !/\.md(?:own)?$/i.test(source))) throw new Error('请选择要移动的 Markdown 笔记。');
    const sourceFile = await safe(source);
    const sourceInfo = await lstat(sourceFile);
    if (moveFolder ? !sourceInfo.isDirectory() : !sourceInfo.isFile()) throw new Error('文件类型已变化，请刷新后重试。');
    if (moveFolder && (folder === source || folder.startsWith(`${source}/`))) throw new Error('不能将文件夹移动到自身或它的子文件夹中。');
    if (moveFolder) await checkDirectory(sourceFile);
    let name = path.posix.basename(source);
    if (renaming) {
      folder = path.posix.dirname(source) === '.' ? '' : path.posix.dirname(source);
      name = checkedName(input.name);
      if (!moveFolder && !/\.md(?:own)?$/i.test(name)) name += path.posix.extname(source);
    }
    const destination = path.posix.join(folder, name);
    if (destination === source) throw new Error(renaming ? '名称没有变化。' : '笔记已经在这个文件夹中。');
    const destinationFile = await safe(destination, { missing: true });
    const caseOnly = renaming && await sameCaseInsensitiveEntry(sourceFile, destinationFile);
    if (await exists(destinationFile) && !caseOnly) throw new Error('这个位置已存在同名文件或文件夹。');
    const sourceAssets = moveFolder ? null : await safe(assetPath(source), { missing: true, privatePath: true });
    const destinationAssets = moveFolder ? null : await safe(assetPath(destination), { missing: true, privatePath: true });
    const moveAssets = !moveFolder && sourceAssets !== destinationAssets && Boolean(await exists(sourceAssets));
    const assetsCaseOnly = moveAssets && await sameCaseInsensitiveEntry(sourceAssets, destinationAssets);
    const relocated = (value) => value === source || (moveFolder && value.startsWith(`${source}/`)) ? destination + value.slice(source.length) : value;
    if (moveAssets && await exists(destinationAssets) && !assetsCaseOnly) throw new Error('目标文件夹中存在同名图片目录，请选择其他文件夹。');
    const stateFile = await safe('.zhixu-feishu/state.json', { missing: true, privatePath: true });
    const stateRaw = await exists(stateFile) ? await readFile(stateFile, 'utf8') : null;
    const state = stateRaw ? JSON.parse(stateRaw) : null;
    if (state && (state.version !== 1 || !Array.isArray(state.entries))) throw new Error('飞书同步记录格式异常，已停止移动。');
    if (state?.entries.some((entry) => entry.path === destination || (moveFolder && entry.path.startsWith(`${destination}/`)))) throw new Error('目标位置已有飞书关联记录，请选择其他文件夹。');
    if (state?.entries.some((entry) => entry.pending)) throw new Error('有未完成的飞书同步，请先恢复同步后再移动笔记。');
    const changes = [];
    for (const oldPath of await listNotes()) {
      const raw = await readFile(path.join(notesRoot, oldPath), 'utf8');
      const newPath = relocated(oldPath);
      const next = relocateLinks(raw, oldPath, newPath, source, destination, moveAssets, moveFolder);
      if (next !== raw || newPath !== oldPath) changes.push({ oldPath, newPath, raw, next });
    }
    const baselines = new Map();
    for (const change of changes) {
      if (state?.entries.some((entry) => entry.path === change.oldPath && entry.assetHash)) baselines.set(change.oldPath, await imageHash(change.oldPath, change.raw));
    }
    const backup = `.zhixu-feishu/move-${randomUUID()}.json`;
    await writeFile(path.join(notesRoot, backup), JSON.stringify({ source, destination, moveAssets, moveFolder, stateRaw, changes }, null, 2), { flag: 'wx', mode: 0o600 });
    let moved = false, assetsMoved = false;
    const written = [];
    try {
      for (const change of changes) {
        if (await readFile(path.join(notesRoot, change.oldPath), 'utf8') !== change.raw) throw new Error('笔记在移动前发生了变化，请重试。');
      }
      if (moveAssets) { await (assetsCaseOnly ? changeCase(sourceAssets, destinationAssets) : rename(sourceAssets, destinationAssets)); assetsMoved = true; }
      if (caseOnly) { await changeCase(sourceFile, destinationFile); }
      else if (moveFolder) {
        if (await exists(destinationFile)) throw new Error('目标位置已存在同名文件夹。');
        await rename(sourceFile, destinationFile);
      } else {
        // Exclusive creation ensures an existing note can never be overwritten.
        const sourceRaw = changes.find((change) => change.oldPath === source).raw;
        await writeFile(destinationFile, sourceRaw, { flag: 'wx' });
        try { await unlink(sourceFile); } catch (error) { await unlink(destinationFile); throw error; }
      }
      moved = true;
      for (const change of changes) {
        if (change.next !== change.raw) {
          written.push(change);
          await writeFile(path.join(notesRoot, change.newPath), change.next);
        }
        for (const entry of state?.entries.filter((item) => item.path === change.oldPath) || []) {
          entry.path = change.newPath;
          if (entry.localHash === digest(change.raw)) entry.localHash = digest(change.next);
          if (entry.assetHash && baselines.get(change.oldPath) === entry.assetHash) {
            const nextHash = await imageHash(change.newPath, change.next);
            if (nextHash) entry.assetHash = nextHash;
          }
        }
      }
      if (state) {
        // Include associations for missing notes and reserved wiki directories.
        for (const entry of state.entries) entry.path = relocated(entry.path);
        if (moveFolder) for (const directory of state.directories || []) directory.path = relocated(directory.path);
        const temp = `${stateFile}.${randomUUID()}.tmp`;
        await writeFile(temp, JSON.stringify(state, null, 2), { flag: 'wx', mode: 0o600 });
        await rename(temp, stateFile);
      }
      return { path: destination, previousPath: source, backup };
    } catch (error) {
      try {
        for (const change of written.reverse()) await writeFile(path.join(notesRoot, change.newPath), change.raw);
        if (moved) await (caseOnly ? changeCase(destinationFile, sourceFile) : rename(destinationFile, sourceFile));
        if (assetsMoved) await (assetsCaseOnly ? changeCase(destinationAssets, sourceAssets) : rename(destinationAssets, sourceAssets));
      } catch { throw new Error(`移动中断，请使用备份恢复：${backup}`); }
      throw error;
    }
  }
  return {
    get busy() { return busy; },
    async execute(input) {
      if (busy) throw new Error('文件操作正在进行，请稍后重试。');
      busy = true;
      let lock;
      let lockPath;
      try {
        const meta = await safe('.zhixu-feishu', { missing: true, privatePath: true });
        await mkdir(meta, { recursive: true });
        lockPath = await safe('.zhixu-feishu/sync.lock', { missing: true, privatePath: true });
        try { lock = await open(lockPath, 'wx', 0o600); }
        catch (error) { if (error.code === 'EEXIST') throw new Error('知识库正在同步或移动，请完成后重试。'); throw error; }
        if (['rename-tag', 'delete-tag'].includes(input.action)) return await manageTags(input);
        const folder = input.folder || '';
        const folderFile = await safe(folder);
        if (!(await lstat(folderFile)).isDirectory()) throw new Error('请选择目标文件夹。');
        if (['move-note', 'move-folder', 'rename-note', 'rename-folder'].includes(input.action)) return await move(input, folder);
        if (!['create-note', 'create-folder'].includes(input.action)) throw new Error('不支持的文件操作。');
        const name = checkedName(input.name);
        const filename = input.action === 'create-note' && !/\.md(?:own)?$/i.test(name) ? `${name}.md` : name;
        const relative = path.posix.join(folder, filename);
        const file = await safe(relative, { missing: true });
        try {
          if (input.action === 'create-folder') await mkdir(file);
          else await writeFile(file, `---\ntitle: ${JSON.stringify(filename.replace(/\.md(?:own)?$/i, ''))}\n---\n\n`, { flag: 'wx' });
        } catch (error) { if (error.code === 'EEXIST') throw new Error('这个位置已存在同名文件或文件夹。'); throw error; }
        return { path: relative };
      } finally {
        try { if (lock) { await lock.close(); await unlink(lockPath); } } finally { busy = false; }
      }
    },
  };
}
