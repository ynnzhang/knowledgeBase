import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { projectRoot, notesRoot as initialNotesRoot, localApiPort, usesDefaultNotesRoot } from './local-config.mjs';
import { createFeishuSync, allowFeishuRequest } from './feishu-sync.mjs';
import { normalizeTags, updateNoteTags } from './note-tags.mjs';
import { createLocalFiles } from './local-files.mjs';
import { atomicWrite, createNoteScanner } from './note-index.mjs';
import { chooseLocalFolder, validateLocalFolder, saveLocalFolder } from './local-workspace.mjs';

const outputFile = path.join(projectRoot, 'public', 'notes-index.json');
const outputAssetsRoot = path.join(projectRoot, 'public', 'note-assets');
const watchMode = process.argv.includes('--watch');
const ignoredFolders = new Set(['.git', '.obsidian', '.trash', '.zhixu-feishu', 'node_modules']);
let notesRoot = initialNotesRoot;
let workspaceBusy = false;
let watcher;
let watchTimer;
let feishu = createFeishuSync({ projectRoot, notesRoot });
let localFiles = createLocalFiles({ notesRoot });
let localWrites = 0;
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

const scanNotes = createNoteScanner();
let indexBody = '';
let indexEtag = '';
let indexPayload = null;

async function copyAssetDirectories(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || ignoredFolders.has(entry.name) || entry.name.startsWith('.')) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.name.endsWith('.assets')) {
      const relativePath = path.relative(notesRoot, absolutePath);
      await cp(absolutePath, path.join(outputAssetsRoot, relativePath), { recursive: true });
    } else {
      await copyAssetDirectories(absolutePath);
    }
  }
}

let syncQueue = Promise.resolve();
let queuedSync = null;
function syncNotes() {
  if (!queuedSync) {
    queuedSync = syncQueue.then(() => { queuedSync = null; return writeNotesIndex(); });
    syncQueue = queuedSync.catch(() => {});
  }
  return queuedSync;
}

async function writeNotesIndex() {
  let collected;
  let error = null;
  try {
    if (notesRoot === initialNotesRoot && usesDefaultNotesRoot) await mkdir(notesRoot, { recursive: true });
    collected = await scanNotes(notesRoot);
    // The local editor serves images directly from the vault. Copy only when
    // building the standalone site, never on every keystroke or file event.
    if (!watchMode) {
      await rm(outputAssetsRoot, { recursive: true, force: true });
      await mkdir(outputAssetsRoot, { recursive: true });
      await copyAssetDirectories(notesRoot);
    }
  } catch (syncError) {
    console.error(`[notes] 索引更新失败，保留上次可用内容：${syncError.message}`);
    error = `暂时无法读取知识库目录：${notesRoot}。已保留上次内容，将自动重试。`;
    if (!indexPayload) {
      try {
        const saved = JSON.parse(await readFile(outputFile, 'utf8'));
        if (saved.workspace === notesRoot && Array.isArray(saved.notes) && Array.isArray(saved.folders)) indexPayload = saved;
      } catch { /* No previous complete index exists. */ }
    }
    collected = indexPayload?.workspace === notesRoot ? { notes: indexPayload.notes, folders: indexPayload.folders } : { notes: [], folders: [] };
  }
  if (indexBody && indexPayload?.workspace === notesRoot && indexPayload.error === error
    && indexPayload.notes.length === collected.notes.length && indexPayload.folders.length === collected.folders.length
    && collected.notes.every((note, index) => note === indexPayload.notes[index])
    && collected.folders.every((folder, index) => folder === indexPayload.folders[index])) return !error;
  const generatedAt = new Date(Math.max(Date.now(), Date.parse(indexPayload?.generatedAt || '') + 1 || 0)).toISOString();
  const payload = { generatedAt, workspace: notesRoot, error, ...collected };
  const body = JSON.stringify(payload);
  await atomicWrite(outputFile, body);
  indexPayload = payload; indexBody = body;
  indexEtag = `"${createHash('sha256').update(body).digest('hex')}"`;
  if (error) console.warn(`[notes] ${error}`);
  else console.log(`[notes] 已从 ${notesRoot} 同步 ${collected.folders.length} 个文件夹、${collected.notes.length} 篇 Markdown 笔记`);
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

function scheduleSync() {
  clearTimeout(watchTimer);
  watchTimer = setTimeout(() => {
    if (localFiles.busy || workspaceBusy || feishu.busy || localWrites) { scheduleSync(); return; }
    void syncNotes().catch((error) => console.error(`[notes] 索引写入失败，将自动重试：${error.message}`));
  }, 350);
}

function observeFolder(root) {
  const observed = watch(root, { recursive: true }, (_event, filename) => {
    const parts = String(filename || '').replaceAll('\\', '/').split('/');
    if (parts.some((part) => part.startsWith('.') || part === 'node_modules' || part.endsWith('.assets')) || parts.at(-1)?.endsWith('.tmp')) return;
    scheduleSync();
  });
  observed.on('error', (error) => {
    console.warn(`[notes] 文件监视暂时中断，将自动重试：${error.message}`);
    observed.close();
    if (watcher === observed) watcher = null;
  });
  return observed;
}

async function switchWorkspace(value) {
  const next = await validateLocalFolder(value);
  if (next === notesRoot) return;
  // Validate before changing the active vault; failures keep the old one usable.
  await createNoteScanner()(next);
  const nextWatcher = watchMode ? observeFolder(next) : null;
  try {
    await syncQueue;
    await saveLocalFolder(projectRoot, next);
  } catch (error) { nextWatcher?.close(); throw error; }
  watcher?.close();
  clearTimeout(watchTimer);
  watcher = nextWatcher;
  notesRoot = next;
  feishu = createFeishuSync({ projectRoot, notesRoot });
  localFiles = createLocalFiles({ notesRoot });
  await syncNotes();
}

function startLocalApi() {
  const handleRequest = async (request, response) => {
    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');

    const expectedWorkspace = request.headers['x-zhixu-workspace'] || requestUrl.searchParams.get('workspace');
    if (expectedWorkspace && expectedWorkspace !== encodeURIComponent(notesRoot)) {
      sendJson(response, 409, { error: '知识库目录已切换，请刷新页面后重试。未保存的内容请先复制保留。' });
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/index') {
      if (!allowFeishuRequest(request, localApiPort)) { sendJson(response, 403, { error: '索引只允许从本机知识库访问。' }); return; }
      response.setHeader('Cache-Control', 'private, no-cache');
      response.setHeader('ETag', indexEtag);
      if (request.headers['if-none-match'] === indexEtag) { response.writeHead(304); response.end(); return; }
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(indexBody); return;
    }
    if (request.method === 'POST' && requestUrl.pathname.startsWith('/workspace/')) {
      if (!allowFeishuRequest(request, localApiPort)) { sendJson(response, 403, { error: '只允许从本机知识库选择文件夹。' }); return; }
      if (workspaceBusy || localFiles.busy || feishu.busy || localWrites) { sendJson(response, 409, { error: '知识库正在保存或同步，请稍后选择文件夹。' }); return; }
      workspaceBusy = true;
      try {
        if (!['/workspace/select', '/workspace/open'].includes(requestUrl.pathname)) throw new Error('未找到目录选择接口。');
        const input = await readJsonBody(request);
        const selected = requestUrl.pathname === '/workspace/select' ? await chooseLocalFolder() : input.path;
        if (selected === null) sendJson(response, 200, { cancelled: true });
        else {
          await switchWorkspace(selected);
          sendJson(response, 200, { ok: true, workspace: notesRoot, index: JSON.parse(await readFile(outputFile, 'utf8')) });
        }
      } catch (error) { sendJson(response, 400, { error: error.message || '无法打开本地文件夹。' }); }
      finally { workspaceBusy = false; }
      return;
    }
    if (request.method === 'POST' && workspaceBusy) { sendJson(response, 409, { error: '正在切换知识库文件夹，请稍后重试。' }); return; }

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
          if (workspaceBusy || (expectedWorkspace && expectedWorkspace !== encodeURIComponent(notesRoot))) throw new Error('知识库目录正在切换或已变化，请刷新后重试。');
          if (localFiles.busy || localWrites) throw new Error('笔记正在保存或移动，请完成后同步。');
          sendJson(response, 202, await feishu.start(input.action, input.path, input.copy === true, input.nodeTokens, input.folders, input.overwriteSyncedBlocks === true, input.pullConfirmationToken));
        } else sendJson(response, 404, { error: '未找到飞书接口。' });
      } catch (error) {
        sendJson(response, 400, { error: error.message || '飞书操作失败。' });
      }
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/files') {
      if (!allowFeishuRequest(request, localApiPort)) {
        sendJson(response, 403, { error: '文件管理只允许从本机知识库访问。' });
        return;
      }
      let countedWrite = false;
      try {
        const input = await readJsonBody(request);
        if (workspaceBusy || (expectedWorkspace && expectedWorkspace !== encodeURIComponent(notesRoot))) throw new Error('知识库目录正在切换或已变化，请刷新后重试。');
        if (feishu.busy || localWrites) throw new Error('笔记正在同步或保存，请完成后再管理文件。');
        localWrites++; countedWrite = true;
        const result = await localFiles.execute(input);
        await syncNotes();
        sendJson(response, 200, { ok: true, ...result, index: JSON.parse(await readFile(outputFile, 'utf8')) });
      } catch (error) {
        sendJson(response, 400, { error: error.message || '文件操作失败。' });
      } finally { if (countedWrite) localWrites--; }
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
      if (localFiles.busy || feishu.busy) { sendJson(response, 409, { error: '笔记正在同步或移动，请稍后上传图片。' }); return; }
      localWrites++;
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
      } finally { localWrites--; }
      return;
    }

    if (request.method !== 'POST' || !['/notes/tags', '/notes/content'].includes(requestUrl.pathname)) {
      sendJson(response, 404, { error: '未找到本地接口。' });
      return;
    }

    if (localFiles.busy || feishu.busy) { sendJson(response, 409, { error: '笔记正在同步或移动，请稍后保存。' }); return; }
    localWrites++;
    try {
      const input = await readJsonBody(request);
      if (feishu.busy || localFiles.busy) throw new Error('飞书同步正在进行，请完成后保存笔记。');
      const absolutePath = resolveNotePath(input.path);
      const [raw, fileInfo] = await Promise.all([readFile(absolutePath, 'utf8'), stat(absolutePath)]);
      const isTagRequest = requestUrl.pathname === '/notes/tags';
      const tags = isTagRequest ? normalizeTags(input.tags) : undefined;
      const nextRaw = isTagRequest
        ? updateNoteTags(raw, tags, fileInfo.mtime)
        : updateFrontmatterContent(raw, input.body);
      await atomicWrite(absolutePath, nextRaw);
      await syncNotes();
      sendJson(response, 200, {
        ok: true,
        raw: nextRaw,
        modified: new Date().toISOString(),
        ...(tags ? { tags } : {}),
      });
    } catch (error) {
      sendJson(response, 400, { error: error.message || '笔记保存失败。' });
    } finally { localWrites--; }
  };
  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error) => {
      console.error(`[notes] 请求处理失败：${error.message}`);
      if (!response.headersSent) sendJson(response, 500, { error: '本地服务暂时无法完成请求，请稍后重试。' });
      else response.destroy();
    });
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;

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

if (watchMode) {
  const apiServer = startLocalApi();
  function restoreWatcher() {
    if (watcher || workspaceBusy) return;
    try { watcher = observeFolder(notesRoot); }
    catch (error) { console.warn(`[notes] 等待知识库目录恢复：${error.message}`); }
  }
  if (initialSyncSucceeded) restoreWatcher();
  // Reconcile missed OS file events and recover disconnected/renamed folders.
  const recoveryTimer = setInterval(() => { restoreWatcher(); scheduleSync(); }, 15_000);
  console.log(`[notes] 正在监视 ${notesRoot}`);
  const close = () => { clearInterval(recoveryTimer); clearTimeout(watchTimer); watcher?.close(); apiServer.close(); };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
} else if (!initialSyncSucceeded) process.exitCode = 1;
