import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const notesRoot = path.resolve(process.env.KNOWLEDGE_BASE_PATH || 'E:\\Note');
const outputFile = path.join(projectRoot, 'public', 'notes-index.json');
const watchMode = process.argv.includes('--watch');
const ignoredFolders = new Set(['.git', '.obsidian', '.trash', 'node_modules']);

function toWebPath(value) {
  return value.split(path.sep).join('/');
}

async function collectDirectory(directory, folders, notes) {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory() && ignoredFolders.has(entry.name)) continue;
    const absolutePath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      folders.push(toWebPath(path.relative(notesRoot, absolutePath)));
      await collectDirectory(absolutePath, folders, notes);
      continue;
    }

    if (!entry.isFile() || !/\.md(?:own)?$/i.test(entry.name)) continue;

    try {
      const [raw, fileInfo] = await Promise.all([
        readFile(absolutePath, 'utf8'),
        stat(absolutePath),
      ]);
      const relativePath = toWebPath(path.relative(notesRoot, absolutePath));
      notes.push({
        id: `local-${relativePath}`,
        name: entry.name,
        path: relativePath,
        raw,
        modified: fileInfo.mtime.toISOString(),
        source: 'local',
      });
    } catch (error) {
      console.warn(`[notes] 跳过无法读取的文件：${absolutePath}`, error.message);
    }
  }
}

async function syncNotes() {
  let notes = [];
  let folders = [];
  let error = null;

  try {
    await collectDirectory(notesRoot, folders, notes);
  } catch (syncError) {
    error = `无法读取 ${notesRoot}：${syncError.message}`;
  }

  const payload = {
    root: notesRoot,
    rootName: path.basename(notesRoot),
    generatedAt: new Date().toISOString(),
    error,
    folders,
    notes,
  };

  await writeFile(outputFile, JSON.stringify(payload), 'utf8');
  if (error) console.warn(`[notes] ${error}`);
  else console.log(`[notes] 已从 ${notesRoot} 同步 ${folders.length} 个文件夹、${notes.length} 篇 Markdown 笔记`);
}

await syncNotes();

if (watchMode) {
  let timer;
  const watcher = watch(notesRoot, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => void syncNotes(), 350);
  });

  console.log(`[notes] 正在监视 ${notesRoot}`);
  process.on('SIGINT', () => watcher.close());
  process.on('SIGTERM', () => watcher.close());
}
