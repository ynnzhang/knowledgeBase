import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { projectRoot, notesRoot, localApiPort, usesDefaultNotesRoot } from './local-config.mjs';
import { createFeishuSync, allowFeishuRequest } from './feishu-sync.mjs';

const outputFile = path.join(projectRoot, 'public', 'notes-index.json');
const outputAssetsRoot = path.join(projectRoot, 'public', 'note-assets');
const watchMode = process.argv.includes('--watch');
const ignoredFolders = new Set(['.git', '.obsidian', '.trash', '.zhixu-feishu', 'node_modules']);
const feishu = createFeishuSync({ projectRoot, notesRoot });
const imageTypes = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
  ['image/avif', '.avif'],
  ['image/bmp', '.bmp'],
]);
const imageMimeByExtension = new Map([...imageTypes].map(([mime, extension]) => [extension, mime]));
imageMimeByExtension.set('.jpeg', 'image/jpeg');
imageMimeByExtension.set('.svg', 'image/svg+xml');

function toWebPath(value) {
  return value.split(path.sep).join('/');
}

async function collectDirectory(directory, folders, notes) {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory() && (ignoredFolders.has(entry.name) || entry.name.endsWith('.assets'))) continue;
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

async function copyAssetDirectories(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || ignoredFolders.has(entry.name)) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.name.endsWith('.assets')) {
      const relativePath = path.relative(notesRoot, absolutePath);
      await cp(absolutePath, path.join(outputAssetsRoot, relativePath), { recursive: true });
    } else {
      await copyAssetDirectories(absolutePath);
    }
  }
}

async function syncNotes() {
  let notes = [];
  let folders = [];
  let error = null;

  try {
    if (usesDefaultNotesRoot && process.platform !== 'win32') await mkdir(notesRoot, { recursive: true });
    await collectDirectory(notesRoot, folders, notes);
    const generatedAssetsPath = path.relative(projectRoot, outputAssetsRoot);
    if (generatedAssetsPath !== path.join('public', 'note-assets')) {
      throw new Error('生成的图片目录无效。');
    }
    await rm(outputAssetsRoot, { recursive: true, force: true });
    await mkdir(outputAssetsRoot, { recursive: true });
    await copyAssetDirectories(notesRoot);
  } catch (syncError) {
    console.error(`无法读取知识库目录：${syncError.message}`);
    error = `无法读取知识库目录：${notesRoot}。请确认目录存在且可访问，或在 .env.local 中设置 KNOWLEDGE_BASE_PATH。`;
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    error,
    folders,
    notes,
  };

  await writeFile(outputFile, JSON.stringify(payload), 'utf8');
  if (error) console.warn(`[notes] ${error}`);
  else console.log(`[notes] 已从 ${notesRoot} 同步 ${folders.length} 个文件夹、${notes.length} 篇 Markdown 笔记`);
  return !error;
}

function resolveNotePath(relativePath) {
  if (typeof relativePath !== 'string' || !/\.md(?:own)?$/i.test(relativePath)) {
    throw new Error('笔记路径无效。');
  }

  const normalized = relativePath.replaceAll('\\', '/');
  const absolutePath = path.resolve(notesRoot, normalized);
  const relative = path.relative(notesRoot, absolutePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('笔记路径超出知识库范围。');
  }
  return absolutePath;
}

function staysInsideKnowledgeBase(absolutePath) {
  const relative = path.relative(notesRoot, absolutePath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function resolveImagePath(notePath, imageSource) {
  const noteAbsolutePath = resolveNotePath(notePath);
  if (typeof imageSource !== 'string' || !imageSource.trim()) throw new Error('图片路径无效。');
  let source = imageSource.trim().replace(/^<|>$/g, '');
  try { source = decodeURIComponent(source); } catch { /* 保留原始路径。 */ }
  source = source.replaceAll('\\', '/');
  const sourceWithoutSuffix = source.split(/[?#]/, 1)[0];
  const absolutePath = sourceWithoutSuffix.startsWith('/')
    ? path.resolve(notesRoot, `.${sourceWithoutSuffix}`)
    : path.resolve(path.dirname(noteAbsolutePath), sourceWithoutSuffix);
  if (!staysInsideKnowledgeBase(absolutePath)) throw new Error('图片路径超出知识库范围。');
  const extension = path.extname(absolutePath).toLowerCase();
  if (!imageMimeByExtension.has(extension)) throw new Error('不支持的图片格式。');
  return { absolutePath, contentType: imageMimeByExtension.get(extension) };
}

function normalizeTags(value) {
  if (!Array.isArray(value)) throw new Error('标签格式无效。');
  return [...new Set(value
    .map((tag) => String(tag).trim().replace(/^#+/, ''))
    .filter(Boolean))]
    .slice(0, 20)
    .map((tag) => tag.slice(0, 32));
}

function updateFrontmatterTags(raw, tags, fallbackUpdated) {
  const match = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  const document = parseDocument(match?.[1] || '');
  if (document.errors.length) throw new Error('笔记的 YAML 元数据格式有误，无法安全更新标签。');
  if (!document.contents) document.contents = document.createNode({});

  document.set('tags', tags);
  const dateKeys = ['updated', 'last_updated', 'modified', 'date'];
  if (!dateKeys.some((key) => document.has(key))) {
    document.set('updated', fallbackUpdated.toISOString().slice(0, 10));
  }

  const body = match ? raw.slice(match[0].length) : raw;
  return `---\n${document.toString().trimEnd()}\n---\n\n${body.replace(/^\r?\n/, '')}`;
}

function updateFrontmatterContent(raw, nextBody) {
  if (typeof nextBody !== 'string') throw new Error('笔记正文格式无效。');
  if (nextBody.length > 5_000_000) throw new Error('笔记正文过大，无法保存。');

  const match = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  const document = parseDocument(match?.[1] || '');
  if (document.errors.length) throw new Error('笔记的 YAML 元数据格式有误，无法安全保存正文。');
  if (!document.contents) document.contents = document.createNode({});
  document.set('updated', new Date().toISOString().slice(0, 10));

  return `---\n${document.toString().trimEnd()}\n---\n\n${nextBody.replace(/^\r?\n/, '')}`;
}

async function readJsonBody(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 6_000_000) throw new Error('请求内容过大。');
  }
  return JSON.parse(body || '{}');
}

async function readBinaryBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 20_000_000) throw new Error('图片不能超过 20 MB。');
    chunks.push(chunk);
  }
  if (!length) throw new Error('没有收到图片内容。');
  return Buffer.concat(chunks);
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

function startLocalApi() {
  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');

    if (requestUrl.pathname.startsWith('/feishu/')) {
      if (!allowFeishuRequest(request, localApiPort)) {
        sendJson(response, 403, { error: '飞书同步只允许从本机知识库访问。' });
        return;
      }
      try {
        if (request.method === 'GET' && requestUrl.pathname === '/feishu/status') {
          sendJson(response, 200, await feishu.status(requestUrl.searchParams.get('path')));
        } else if (request.method === 'POST' && requestUrl.pathname === '/feishu/config') {
          sendJson(response, 200, await feishu.saveConfig(await readJsonBody(request)));
        } else if (request.method === 'POST' && requestUrl.pathname === '/feishu/jobs') {
          const input = await readJsonBody(request);
          sendJson(response, 202, await feishu.start(input.action, input.path, input.copy === true));
        } else sendJson(response, 404, { error: '未找到飞书接口。' });
      } catch (error) {
        sendJson(response, 400, { error: error.message || '飞书操作失败。' });
      }
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/health') {
      sendJson(response, 200, { ok: true, service: 'zhixu-notes', projectRoot, notesRoot });
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/assets') {
      try {
        const image = resolveImagePath(
          requestUrl.searchParams.get('notePath'),
          requestUrl.searchParams.get('src'),
        );
        const content = await readFile(image.absolutePath);
        response.writeHead(200, {
          'Content-Type': image.contentType,
          'Content-Length': content.length,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        response.end(content);
      } catch (error) {
        sendJson(response, 404, { error: error.message || '图片读取失败。' });
      }
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/notes/images') {
      try {
        const notePath = requestUrl.searchParams.get('notePath');
        const noteAbsolutePath = resolveNotePath(notePath);
        const contentType = String(request.headers['content-type'] || '').split(';', 1)[0].toLowerCase();
        const extension = imageTypes.get(contentType);
        if (!extension) throw new Error('只支持 PNG、JPEG、GIF、WebP、AVIF 和 BMP 图片。');
        const content = await readBinaryBody(request);
        const noteBaseName = path.basename(noteAbsolutePath, path.extname(noteAbsolutePath));
        const assetsFolderName = `${noteBaseName}.assets`;
        const assetsDirectory = path.resolve(path.dirname(noteAbsolutePath), assetsFolderName);
        if (!staysInsideKnowledgeBase(assetsDirectory)) throw new Error('图片目录超出知识库范围。');
        await mkdir(assetsDirectory, { recursive: true });
        const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
        const fileName = `image-${timestamp}-${randomUUID().slice(0, 8)}${extension}`;
        await writeFile(path.join(assetsDirectory, fileName), content);
        sendJson(response, 200, { url: `./${assetsFolderName}/${fileName}` });
      } catch (error) {
        sendJson(response, 400, { error: error.message || '图片保存失败。' });
      }
      return;
    }

    if (request.method !== 'POST' || !['/notes/tags', '/notes/content'].includes(requestUrl.pathname)) {
      sendJson(response, 404, { error: '未找到本地接口。' });
      return;
    }

    try {
      const input = await readJsonBody(request);
      if (feishu.busy) throw new Error('飞书同步正在进行，请完成后保存笔记。');
      const absolutePath = resolveNotePath(input.path);
      const [raw, fileInfo] = await Promise.all([readFile(absolutePath, 'utf8'), stat(absolutePath)]);
      const isTagRequest = requestUrl.pathname === '/notes/tags';
      const tags = isTagRequest ? normalizeTags(input.tags) : undefined;
      const nextRaw = isTagRequest
        ? updateFrontmatterTags(raw, tags, fileInfo.mtime)
        : updateFrontmatterContent(raw, input.body);
      await writeFile(absolutePath, nextRaw, 'utf8');
      await syncNotes();
      sendJson(response, 200, {
        ok: true,
        raw: nextRaw,
        modified: new Date().toISOString(),
        ...(tags ? { tags } : {}),
      });
    } catch (error) {
      sendJson(response, 400, { error: error.message || '标签保存失败。' });
    }
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') console.warn(`[notes] 编辑服务端口 ${localApiPort} 已被占用`);
    else console.error('[notes] 编辑服务启动失败', error);
    process.exit(1);
  });
  server.listen(localApiPort, '127.0.0.1', () => {
    console.log(`[notes] 本地编辑服务已启动：http://127.0.0.1:${localApiPort}`);
  });
  return server;
}

const initialSyncSucceeded = await syncNotes();

if (watchMode && !initialSyncSucceeded) process.exitCode = 1;

if (watchMode && initialSyncSucceeded) {
  const apiServer = startLocalApi();
  let timer;
  const watcher = watch(notesRoot, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => void syncNotes(), 350);
  });

  console.log(`[notes] 正在监视 ${notesRoot}`);
  process.on('SIGINT', () => { watcher.close(); apiServer.close(); });
  process.on('SIGTERM', () => { watcher.close(); apiServer.close(); });
}
