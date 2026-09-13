import { atomicWrite } from './note-index.mjs';
import { mkdir, readFile, writeFile, realpath, lstat, open, unlink, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { blocksToMarkdown, hashBody, splitFrontmatter, prepareConverted } from './feishu-markdown.mjs';
import { expandSyncedBlocks } from './feishu-content.mjs';
import { bytesHash, imageResponse, imageType, MAX_IMAGE_BYTES, prepareImageMarkdown } from './feishu-media.mjs';

const API = 'https://open.feishu.cn/open-apis';
const digest = (raw) => createHash('sha256').update(hashBody(raw)).digest('hex');
const segment = (value) => encodeURIComponent(value);
const safeName = (title) => {
  const name = (title || '未命名').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 70).replace(/^[. ]+|[. ]+$/g, '') || '未命名';
  // These device names remain reserved even with a file extension on Windows.
  return /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name) ? `_${name}` : name;
};
export const DEFAULT_FEISHU = { appId: 'cli_aa03f00d80b89be9', wikiUrl: 'https://my.feishu.cn/wiki/FPAkw5QFhibTVlkU7G3c1JrInob' };

export function parseWikiUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('请输入完整的飞书知识库页面链接。'); }
  const match = url.pathname.match(/^\/wiki\/([a-zA-Z0-9]+)\/?$/);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.feishu.cn') || url.port || url.username || url.password || !match) throw new Error('只支持 https://…feishu.cn/wiki/… 格式的知识库链接。');
  return { token: match[1], url: `${url.origin}/wiki/${match[1]}`, origin: url.origin };
}

export class FeishuClient {
  constructor(config, fetchImpl = fetch, pause = delay, now = Date.now) {
    this.config = config;
    this.fetch = fetchImpl;
    this.pause = pause;
    this.now = now;
    this.requestQueues = new Map();
    this.tokenRequest = null;
    this.token = '';
    this.expires = 0;
  }
  async accessToken() {
    if (this.token && this.now() < this.expires) return this.token;
    if (this.tokenRequest) return this.tokenRequest;
    this.tokenRequest = this.fetchToken();
    try { return await this.tokenRequest; }
    finally { this.tokenRequest = null; }
  }
  async fetchToken() {
    const response = await this.fetch(`${API}/auth/v3/tenant_access_token/internal`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.config.appId, app_secret: this.config.appSecret }), signal: AbortSignal.timeout(20000), redirect: 'error',
    });
    const data = await response.json();
    if (!response.ok || data.code !== 0 || !data.tenant_access_token) throw new Error(`飞书身份验证失败（${data.code ?? response.status}），请检查 App ID、App Secret 及应用发布状态。`);
    this.token = data.tenant_access_token;
    this.expires = this.now() + Math.max(0, (data.expire - 120) * 1000);
    return this.token;
  }
  async waitForRequest(endpoint, method) {
    // Official limits: wiki 100/min, document reads and media downloads 5/sec.
    // Share each bucket across documents; concurrent downloads must not multiply
    // the allowed rate. Preserve the existing conservative pace for all writes.
    const bucketName = endpoint.startsWith('/wiki/') ? 'wiki'
      : method === 'GET' && endpoint.startsWith('/docx/') ? 'document-read'
      : method === 'GET' && /^\/drive\/v1\/medias\/[^/]+\/download$/.test(endpoint) ? 'media-read' : 'other';
    const interval = ['document-read', 'media-read'].includes(bucketName) ? 220 : 650;
    if (!this.requestQueues.has(bucketName)) this.requestQueues.set(bucketName, { tail: Promise.resolve(), last: null });
    const bucket = this.requestQueues.get(bucketName);
    const admission = bucket.tail.then(async () => {
      const wait = bucket.last === null ? 0 : Math.max(0, interval - (this.now() - bucket.last));
      if (wait) await this.pause(wait);
      bucket.last = this.now();
    });
    bucket.tail = admission.catch(() => {});
    await admission;
  }
  async request(endpoint, { method = 'GET', body, query = {}, binary = false, form } = {}) {
    const url = `${API}${endpoint}?${new URLSearchParams(query)}`;
    for (let attempt = 0; attempt < 4; attempt++) {
      const token = await this.accessToken();
      await this.waitForRequest(endpoint, method);
      const response = await this.fetch(url, { method, headers: { Authorization: `Bearer ${token}`, ...(form ? {} : { 'Content-Type': 'application/json' }) }, body: form || (body === undefined ? undefined : JSON.stringify(body)), signal: AbortSignal.timeout(binary || form ? 60000 : 25000), redirect: 'error' });
      if (binary && response.ok && !response.headers.get('content-type')?.includes('application/json')) return imageResponse(response);
      const result = await response.json();
      if ((response.status === 429 || result.code === 99991400) && attempt < 3) {
        await this.pause(Math.min(10000, Math.max(Number(response.headers.get('retry-after') || 0) * 1000, 1000 * 2 ** attempt)));
        continue;
      }
      if ([99991663, 99991668].includes(result.code) && attempt < 1) { if (this.token === token) this.token = ''; continue; }
      if (!response.ok || result.code !== 0) {
        const hint = [131006, 1770032, 99991672].includes(result.code) || response.status === 403
          ? '请检查应用 API 权限是否已发布，并给应用添加目标知识库/文档的阅读和编辑权限。'
          : [131005, 1770002, 1770003].includes(result.code) ? '目标文档不存在、已删除或应用无法访问，请检查链接及授权。' : '请检查飞书权限与参数，稍后重试。';
        // Never return upstream payloads that could echo credentials or note content.
        const permissionDetail = String(result.msg || '').includes('no source parent node permission') ? '缺少原父节点的容器编辑权限。'
          : String(result.msg || '').includes('no destination parent node permission') ? '缺少目标父节点的容器编辑权限。' : '';
        throw Object.assign(new Error(`飞书接口失败（${result.code ?? response.status}）。${permissionDetail}${hint}`), { feishuCode: result.code });
      }
      if (binary) throw new Error('飞书素材接口未返回图片文件，请检查素材权限。');
      return result.data;
    }
  }
  async list(endpoint, query = {}) {
    const items = [], seen = new Set();
    let token = '';
    do {
      const data = await this.request(endpoint, { query: { ...query, ...(token ? { page_token: token } : {}) } });
      if (!Array.isArray(data.items)) throw new Error('飞书列表响应不完整。');
      items.push(...data.items);
      if (!data.has_more) break;
      if (!data.page_token || seen.has(data.page_token)) throw new Error('飞书分页异常，请重试。');
      token = data.page_token;
      seen.add(token);
    } while (true);
    return items;
  }
  async node(token) { return (await this.request('/wiki/v2/spaces/get_node', { query: { token } })).node; }
  async downloadImage(token) { return this.request(`/drive/v1/medias/${segment(token)}/download`, { binary: true }); }
  async uploadImage(blockId, asset) {
    const form = new FormData();
    form.set('file_name', asset.name); form.set('parent_type', 'docx_image'); form.set('parent_node', blockId);
    form.set('size', String(asset.bytes.length)); form.set('file', new Blob([asset.bytes], { type: asset.mime }), asset.name);
    const data = await this.request('/drive/v1/medias/upload_all', { method: 'POST', form });
    if (!data?.file_token) throw new Error('飞书未返回图片素材标识，已停止推送。');
    return data.file_token;
  }
  async snapshot(id) {
    const endpoint = `/docx/v1/documents/${segment(id)}`;
    const before = (await this.request(endpoint)).document;
    // Explicit revision IDs can require history/edit permission even when the
    // revision is current. Read latest, then reject changes during pagination.
    const blocks = await this.list(`${endpoint}/blocks`, { page_size: '500', document_revision_id: '-1' });
    const expanded = blocks.some((block) => block.reference_synced) ? await expandSyncedBlocks(this, blocks, id) : { renderBlocks: blocks, incomplete: false };
    const after = (await this.request(endpoint)).document;
    if (after.revision_id !== before.revision_id) throw new Error('飞书文档正在被编辑，请停止编辑后重试同步。');
    return { ...blocksToMarkdown(expanded.renderBlocks, id), ...expanded, blocks, revision: before.revision_id, title: before.title, renderVersion: 2 };
  }
}

export function createFeishuSync({ projectRoot, notesRoot, env = process.env, clientFactory = (config) => new FeishuClient(config) }) {
  const configFile = path.join(projectRoot, '.feishu-local.json');
  const privateRoot = path.join(notesRoot, '.zhixu-feishu');
  let busy = false;
  let job = null;
  const pullConfirmations = new Map();

  async function safePath(relative, createParents = false) {
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('同步文件路径无效。');
    const root = await realpath(notesRoot);
    const parts = relative.split('/');
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink() || (i < parts.length - 1 && !info.isDirectory())) throw new Error('同步路径不能包含符号链接或非目录文件。');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (i < parts.length - 1 && createParents) await mkdir(current);
        else if (i < parts.length - 1) throw error;
      }
    }
    return current;
  }
  async function atomic(file, value) {
    await atomicWrite(file, value);
  }
  async function config() {
    let saved = {};
    try { saved = JSON.parse(await readFile(configFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw new Error('本机飞书配置损坏，请检查 .feishu-local.json。'); }
    return { appId: env.FEISHU_APP_ID || saved.appId || DEFAULT_FEISHU.appId, appSecret: env.FEISHU_APP_SECRET || saved.appSecret || '', wikiUrl: env.FEISHU_WIKI_URL || saved.wikiUrl || DEFAULT_FEISHU.wikiUrl };
  }
  async function status(notePath) {
    const value = await config();
    let entry, recovery;
    try {
      entry = (await state(value)).entries.find((item) => item.path === notePath);
      if (entry?.pending) {
        const saved = JSON.parse(await readFile(await safePath(entry.pending), 'utf8'));
        if (canRestoreOriginal(saved, entry)) recovery = { canRestoreOriginal: true, originalUrl: `${parseWikiUrl(value.wikiUrl).origin}/wiki/${segment(saved.previousEntry.nodeToken)}` };
      }
    } catch (error) { return { ...publicConfig(value), busy, job, error: error.message }; }
    return { ...publicConfig(value), busy, job, entry, recovery };
  }
  function canRestoreOriginal(saved, entry) {
    return saved.kind === 'push' && !saved.remote && saved.previousEntry?.documentId && saved.previousEntry?.nodeToken &&
      saved.previousEntry.scope === entry.scope && !saved.previousEntry.pending &&
      typeof saved.previousEntry.localHash === 'string' && Number.isInteger(saved.previousEntry.revision);
  }
  function publicConfig(value) { return { appId: value.appId, wikiUrl: value.wikiUrl, configured: Boolean(value.appSecret), environmentManaged: Boolean(env.FEISHU_APP_ID || env.FEISHU_APP_SECRET || env.FEISHU_WIKI_URL) }; }
  async function saveConfig(input) {
    if (busy) throw new Error('同步正在进行，请稍后修改配置。');
    if (env.FEISHU_APP_ID || env.FEISHU_APP_SECRET || env.FEISHU_WIKI_URL) throw new Error('当前配置由环境变量或 .env.local 管理，请在对应文件中修改并重启。');
    const previous = await config();
    const appId = String(input.appId || '').trim();
    if (!/^cli_[a-zA-Z0-9]+$/.test(appId)) throw new Error('App ID 格式无效。');
    const appSecret = typeof input.appSecret === 'string' && input.appSecret.trim() ? input.appSecret.trim() : appId === previous.appId ? previous.appSecret : '';
    if (!appSecret || appSecret.length > 512) throw new Error('请填写该应用的 App Secret。');
    const value = { appId, appSecret, wikiUrl: parseWikiUrl(input.wikiUrl).url };
    await atomic(configFile, JSON.stringify(value, null, 2));
    return publicConfig(value);
  }
  async function state(value) {
    const file = await safePath('.zhixu-feishu/state.json', true);
    let data = { version: 1, entries: [] };
    try { data = JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw new Error('同步记录损坏，已停止操作。请保留 .zhixu-feishu 目录以便恢复。'); }
    if (data.version !== 1 || !Array.isArray(data.entries)) throw new Error('无法读取同步记录。');
    const scope = `${value.appId}:${parseWikiUrl(value.wikiUrl).token}`;
    return { data, entries: data.entries.filter((item) => item.scope === scope), scope, file };
  }
  async function saveState(current) { await atomic(current.file, JSON.stringify(current.data, null, 2)); }
  async function backup(value) {
    const file = await safePath(`.zhixu-feishu/backups/${Date.now()}-${randomUUID()}.json`, true);
    await atomic(file, JSON.stringify(value, null, 2));
    return path.relative(await realpath(notesRoot), file).split(path.sep).join('/');
  }
  async function readNote(notePath) {
    if (!/\.md(?:own)?$/i.test(notePath) || notePath.startsWith('.zhixu-feishu/')) throw new Error('请选择 Markdown 笔记。');
    return readFile(await safePath(notePath), 'utf8');
  }
  async function readImage(notePath, source) {
    if (/^data:/i.test(source)) {
      const match = source.match(/^data:image\/(?:png|jpeg|gif|webp|bmp);base64,([a-zA-Z0-9+/=\s]+)$/);
      if (!match || match[1].length > MAX_IMAGE_BYTES * 1.4) throw new Error('内嵌图片无效或超过 20 MB。');
      return Buffer.from(match[1], 'base64');
    }
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(source)) throw new Error('推送图片请使用知识库内的本地图片；外链图片请先保存到本地。');
    let decoded = source;
    try { decoded = decodeURIComponent(source); } catch { /* Keep literal path. */ }
    decoded = decoded.replaceAll('\\', '/');
    const relative = path.posix.normalize(decoded.startsWith('/') ? decoded.slice(1) : path.posix.join(path.posix.dirname(notePath), decoded));
    if (relative.startsWith('.zhixu-feishu/')) throw new Error('同步备份不能作为图片上传。');
    const file = await safePath(relative);
    const info = await lstat(file);
    if (!info.isFile() || info.size > MAX_IMAGE_BYTES) throw new Error('图片不是普通文件或超过 20 MB。');
    return readFile(file);
  }
  const imageMarkdown = (notePath, body) => prepareImageMarkdown(body, (source) => readImage(notePath, source));
  async function execute(action, notePath, copy = false, nodeTokens = [], folders = [], overwriteSyncedBlocks = false, pullConfirmation) {
    const value = await config();
    if (!value.appSecret) throw new Error('请先配置 App Secret，并测试飞书连接。');
    const wiki = parseWikiUrl(value.wikiUrl);
    const client = clientFactory(value);
    const root = await client.node(wiki.token);
    if (!root?.space_id || !root.obj_token) throw new Error('飞书未返回有效的知识库节点。');
    if (action === 'connect') return [{ status: 'ok', message: `已连接「${root.title || '知识库'}」。读取权限正常；写入权限将在推送时验证。` }];
    const current = await state(value);
    const results = [];
    const downloadedImages = new Map();
    async function localizeImages(remote, filePath, documentId) {
      const blocks = remote.renderBlocks || remote.blocks;
      const imagePaths = new Map();
      const tokens = [...new Set(blocks.filter((block) => block.block_type === 27 && block.image?.token).map((block) => block.image.token))];
      let cursor = 0, failed = false, writeTail = Promise.resolve();
      async function localize(token) {
        job.progress = `正在下载「${path.basename(filePath)}」的图片…`;
        if (!downloadedImages.has(token)) {
          const download = client.downloadImage(token).catch((error) => { downloadedImages.delete(token); throw error; });
          downloadedImages.set(token, download);
        }
        const asset = await downloadedImages.get(token), type = imageType(asset.bytes);
        const relative = `${filePath.replace(/\.md(?:own)?$/i, '')}.assets/feishu-${bytesHash(asset.bytes)}${type.extension}`;
        // Distinct remote tokens can contain identical bytes. Serialize local
        // creation so directory checks and hash-named files cannot race.
        const persisted = writeTail.then(async () => {
          const file = await safePath(relative, true);
          try { await writeFile(file, asset.bytes, { flag: 'wx' }); }
          catch (error) {
            if (error.code !== 'EEXIST') throw error;
            if (!(await readFile(file)).equals(asset.bytes)) throw new Error('本地同步图片已被修改，请保留图片并处理冲突后重试。');
          }
          imagePaths.set(token, path.posix.relative(path.posix.dirname(filePath), relative));
        });
        writeTail = persisted.catch(() => {});
        await persisted;
      }
      // Drain every in-flight worker on failure before releasing the workspace
      // lock or continuing to another note. Never leave writes in the background.
      const workers = Array.from({ length: Math.min(3, tokens.length) }, async () => {
        while (!failed && cursor < tokens.length) {
          const token = tokens[cursor++];
          try { await localize(token); }
          catch (error) { failed = true; throw error; }
        }
      });
      const completed = await Promise.allSettled(workers);
      const failure = completed.find((result) => result.status === 'rejected');
      if (failure) throw failure.reason;
      return blocksToMarkdown(blocks, documentId, { imagePaths }).markdown;
    }
    const allocatedNames = new Set();
    let tree;
    async function wikiTree() {
      if (tree) return tree;
      const items = [], queue = [{ node: root, wikiPath: [] }], seen = new Set();
      while (queue.length) {
        const item = queue.shift();
        if (seen.has(item.node.node_token)) continue;
        seen.add(item.node.node_token);
        items.push(item);
        if (action === 'discover') job.progress = `正在读取知识库目录：${items.length} 个页面…`;
        if (item.node.has_child && item.node.node_type !== 'shortcut') {
          const children = await client.list(`/wiki/v2/spaces/${segment(root.space_id)}/nodes`, { parent_node_token: item.node.node_token, page_size: '50' });
          queue.push(...children.map((node) => ({ node, parentToken: item.node.node_token, wikiPath: [...item.wikiPath, node.title] })));
        }
      }
      tree = items;
      return items;
    }
    function sameLocation(entry, item) {
      if (Array.isArray(entry.wikiPath)) return isDeepStrictEqual(entry.wikiPath, item.wikiPath);
      // Migrate old records using their existing local hierarchy. Never search
      // globally by basename: identical titles in other folders are unrelated.
      const rootEntry = current.entries.find((candidate) => candidate.nodeToken === root.node_token);
      const base = (rootEntry?.path || `飞书/${safeName(root.title)}.md`).replace(/\.md(?:own)?$/i, '');
      const expected = `${base}${item.wikiPath.length ? '/' + item.wikiPath.map(safeName).join('/') : ''}.md`;
      if (entry.path === expected) return true;
      return !entry.path.startsWith('飞书/') && item.wikiPath.length === 1 && item.wikiPath[0] === path.basename(entry.path).replace(/\.md(?:own)?$/i, '');
    }
    async function replacement(entry) {
      const items = await wikiTree();
      const candidates = items.filter((item) => sameLocation(entry, item));
      if (candidates.length !== 1) throw new Error(candidates.length ? '原路径下存在多个同名飞书页面，无法自动确定关联，请先处理重名。' : '原飞书文档已失效，未找到原路径下可访问的同名页面，请检查路径及授权。');
      const item = candidates[0];
      if (item.node.obj_type !== 'docx' || item.node.node_type === 'shortcut') throw new Error('原路径下的同名页面不是新版文档实体，不能自动关联。');
      if (current.entries.some((other) => other !== entry && other.nodeToken === item.node.node_token)) throw new Error('同名飞书页面已关联其他本地笔记，不能自动关联。');
      return item;
    }
    async function rebind(entry, item, remote) {
      if (entry.pending) throw new Error(`上次同步中断，请先检查备份 ${entry.pending} 和飞书原文。`);
      const unchanged = digest(remote.markdown) === (entry.remoteHash || entry.localHash);
      await backup({ kind: 'rebind', previousEntry: structuredClone(entry), remote, node: item.node });
      // Revision counters belong to a document ID. A recreated document with
      // the same counter is unchanged only if its content matches the baseline.
      Object.assign(entry, { nodeToken: item.node.node_token, documentId: item.node.obj_token, wikiPath: item.wikiPath,
        url: `${wiki.origin}/wiki/${item.node.node_token}`, revision: unchanged ? remote.revision : null });
      if (unchanged) Object.assign(entry, { remoteHash: digest(remote.markdown), warnings: remote.warnings });
      await saveState(current);
    }
    async function resolveEntry(entry) {
      if (entry.pending) throw new Error(`上次同步中断，请先检查备份 ${entry.pending} 和飞书原文。`);
      let node, remote;
      try {
        node = await client.node(entry.nodeToken);
        if (node?.obj_token === entry.documentId) remote = await client.snapshot(entry.documentId);
      } catch (error) {
        if (![131005, 1770002, 1770003].includes(error.feishuCode)) throw error;
      }
      if (remote) return { node, remote };
      const item = await replacement(entry);
      remote = await client.snapshot(item.node.obj_token);
      await rebind(entry, item, remote);
      return { node: item.node, remote };
    }
    async function importPath(node, parent) {
      const existing = current.entries.find((entry) => entry.nodeToken === node.node_token);
      if (existing) return existing.path;
      const directory = current.data.directories?.find((item) => item.scope === current.scope && item.nodeToken === node.node_token);
      if (directory) return `${directory.path}.md`;
      const name = safeName(node.title);
      for (let number = 1; ; number++) {
        const stem = `${parent}/${name}${number === 1 ? '' : `（${number}）`}`;
        const candidate = `${stem}.md`;
        if (allocatedNames.has(stem.toLowerCase()) || current.data.directories?.some((item) => item.path.toLowerCase() === stem.toLowerCase()) || current.data.entries.some((entry) => entry.path.toLowerCase() === candidate.toLowerCase() || entry.path.toLowerCase().startsWith(`${stem.toLowerCase()}/`))) continue;
        let occupied = false;
        for (const relative of [candidate, stem]) {
          try { await lstat(await safePath(relative, true)); occupied = true; }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        if (occupied) continue;
        allocatedNames.add(stem.toLowerCase());
        return candidate;
      }
    }
    async function pull(node, targetPath, snapshot, wikiPath) {
      if (node.obj_type !== 'docx' || node.node_type === 'shortcut') { results.push({ status: 'skipped', message: `跳过「${node.title}」：仅支持新版文档实体节点。` }); return; }
      let entry = current.entries.find((item) => item.nodeToken === node.node_token);
      if (entry?.pending) throw new Error(`「${entry.path}」上次同步中断，请先检查备份 ${entry.pending} 和飞书原文。`);
      const remote = snapshot || await client.snapshot(node.obj_token);
      if (entry && entry.documentId !== node.obj_token) await rebind(entry, await replacement(entry), remote);
      if (entry && wikiPath) { entry.wikiPath = wikiPath; await saveState(current); }
      const filePath = entry?.path || targetPath;
      let raw = '';
      if (entry) {
        raw = await readNote(filePath);
        if (remote.incomplete) throw new Error('同步块读取不完整，已保留本地正文；请检查源文档授权后重新拉取。');
        let assetsChanged = false;
        let currentAssetHash = null;
        if (entry.assetHash) {
          try { currentAssetHash = (await imageMarkdown(filePath, splitFrontmatter(raw).body)).assetHash; assetsChanged = currentAssetHash !== entry.assetHash; }
          catch (error) { if (error.code !== 'ENOENT') throw error; assetsChanged = true; }
        }
        const fingerprint = createHash('sha256').update(JSON.stringify({ scope: current.scope, path: filePath, documentId: node.obj_token, raw, assetHash: currentAssetHash, remote })).digest('hex');
        const confirmed = pullConfirmation?.fingerprint === fingerprint;
        const remoteUnchanged = remote.revision === entry.revision && (!entry.remoteHash || digest(remote.markdown) === entry.remoteHash);
        if (!confirmed && (pullConfirmation || digest(raw) !== entry.localHash || assetsChanged)) {
          if (!pullConfirmation && remoteUnchanged) { results.push({ status: 'skipped', path: filePath, message: '本地有修改，飞书未变化；可使用推送当前笔记。' }); return; }
          const conflict = await backup({ kind: 'conflict', path: filePath, local: raw, remote });
          const confirmationToken = randomUUID();
          for (const [token, previous] of pullConfirmations) if (previous.path === filePath) pullConfirmations.delete(token);
          if (pullConfirmations.size >= 10000) pullConfirmations.delete(pullConfirmations.keys().next().value);
          pullConfirmations.set(confirmationToken, { path: filePath, fingerprint });
          results.push({ status: 'conflict', path: filePath, confirmationToken, message: `${pullConfirmation ? '确认期间内容发生变化，请重新选择是否覆盖。' : '两端均有修改，请选择保留本地或用飞书内容覆盖本地。'}两份内容已备份：${conflict}` }); return;
        }
        if (!confirmed && remoteUnchanged && entry.renderVersion === 2) {
          await localizeImages(remote, filePath, node.obj_token);
          results.push({ status: 'unchanged', path: filePath, message: '没有新变化。' }); return;
        }
        await backup({ kind: 'pull', path: filePath, local: raw, remote });
      }
      const markdown = await localizeImages(remote, filePath, node.obj_token);
      const nextRaw = `${entry ? splitFrontmatter(raw).prefix : `---\ntitle: ${JSON.stringify(remote.title)}\n---\n`}\n${markdown}`;
      const assetHash = (await imageMarkdown(filePath, markdown)).assetHash;
      if (!entry) await backup({ kind: 'import', path: filePath, remote });
      const file = await safePath(filePath, true);
      if (entry) {
        if (await readNote(filePath) !== raw) throw new Error('本地笔记在同步期间发生变化，已停止覆盖。');
        await atomic(file, nextRaw);
      } else {
        await writeFile(file, nextRaw, { flag: 'wx' });
        entry = { scope: current.scope, path: filePath, nodeToken: node.node_token, documentId: node.obj_token };
        current.data.entries.push(entry); current.entries.push(entry);
      }
      Object.assign(entry, { revision: remote.revision, localHash: digest(nextRaw), remoteHash: digest(remote.markdown), assetHash, renderVersion: 2, ...(wikiPath ? { wikiPath } : {}), warnings: remote.warnings, syncedAt: new Date().toISOString(), url: `${wiki.origin}/wiki/${node.node_token}` });
      await saveState(current);
      results.push({ status: remote.warnings.length ? 'warning' : 'ok', path: filePath, message: [pullConfirmation ? '已用飞书内容覆盖本地，覆盖前内容已备份。' : '已导入飞书内容。', ...remote.warnings].join(' ') });
    }
    function isUnimported(item, items) {
      return item.node.obj_type === 'docx' && item.node.node_type !== 'shortcut' && !current.entries.some((entry) =>
        entry.nodeToken === item.node.node_token || (sameLocation(entry, item) && !items.some((other) => other.node.node_token === entry.nodeToken)));
    }
    if (action === 'discover') {
      const items = await wikiTree();
      job.candidates = items.filter((item) => isUnimported(item, items)).map((item) => ({
        nodeToken: item.node.node_token, title: item.node.title || '未命名',
        path: [root.title || '未命名', ...item.wikiPath].join(' / '), url: `${wiki.origin}/wiki/${item.node.node_token}`,
      }));
      return [{ status: 'ok', message: job.candidates.length ? `找到 ${job.candidates.length} 篇尚未拉取的笔记，请勾选后拉取。` : '当前知识库下可拉取的笔记均已关联到本地。' }];
    }
    if (action === 'import' || action === 'import-selected') {
      const items = await wikiTree();
      let selected, needed;
      if (action === 'import-selected') {
        selected = new Set(nodeTokens);
        for (const token of selected) {
          const item = items.find((item) => item.node.node_token === token);
          if (!item || item.node.obj_type !== 'docx' || item.node.node_type === 'shortcut') throw new Error('所选页面已失效或不在当前知识库范围内，请刷新待拉取列表。');
          if (!isUnimported(item, items)) {
            selected.delete(token);
            results.push({ status: 'skipped', message: `「${item.node.title}」已关联本地，已跳过；更新正文请使用拉取当前笔记。` });
          }
        }
        needed = new Set(selected);
        for (const token of selected) {
          let item = items.find((item) => item.node.node_token === token);
          while (item?.parentToken) { needed.add(item.parentToken); item = items.find((parent) => parent.node.node_token === item.parentToken); }
        }
      }
      const queue = [{ node: root, parent: '飞书' }], seen = new Set();
      while (queue.length) {
        const { node, parent } = queue.shift();
        if (seen.has(node.node_token)) continue;
        seen.add(node.node_token);
        if (needed && !needed.has(node.node_token)) continue;
        const item = items.find((item) => item.node.node_token === node.node_token);
        let snapshot;
        try {
          if ((!selected || selected.has(node.node_token)) && !current.entries.some((entry) => entry.nodeToken === node.node_token)) {
            const stale = current.entries.filter((entry) => sameLocation(entry, item) && !items.some((other) => other.node.node_token === entry.nodeToken));
            if (stale.length > 1) throw new Error('原路径对应多条同步记录，无法自动确定关联。');
            if (stale.length === 1) {
              await replacement(stale[0]);
              snapshot = await client.snapshot(node.obj_token);
              await rebind(stale[0], item, snapshot);
            }
          }
        } catch (error) { results.push({ status: 'error', message: `「${node.title}」：${error.message}` }); continue; }
        const targetPath = await importPath(node, parent);
        const childDirectory = targetPath.replace(/\.md(?:own)?$/i, '');
        job.progress = `正在导入「${node.title}」`;
        if (selected && !current.entries.some((entry) => entry.nodeToken === node.node_token)) {
          // Reserve paths even when a parent is unselected or its download fails.
          // Later batches must reuse the directories containing imported children.
          current.data.directories ||= [];
          if (!current.data.directories.some((directory) => directory.scope === current.scope && directory.nodeToken === node.node_token)) {
            current.data.directories.push({ scope: current.scope, nodeToken: node.node_token, path: childDirectory });
            await saveState(current);
          }
        }
        if (!selected || selected.has(node.node_token)) {
          try { await pull(node, targetPath, snapshot, item.wikiPath); } catch (error) { results.push({ status: 'error', message: `「${node.title}」：${error.message}` }); }
        }
        if (node.has_child && node.node_type !== 'shortcut') {
          try {
            const children = items.filter((child) => child.parentToken === node.node_token).map((child) => child.node);
            queue.push(...children.map((child) => ({ node: child, parent: childDirectory })));
          } catch (error) { results.push({ status: 'error', message: `读取「${node.title}」子页面失败：${error.message}` }); }
        }
      }
      return results;
    }
    const entry = current.entries.find((item) => item.path === notePath);
    if (action === 'recover' || action === 'recover-original') {
      if (!entry?.pending) return [{ status: 'unchanged', message: '当前笔记没有未完成的同步记录，可以正常操作。' }];
      const saved = JSON.parse(await readFile(await safePath(entry.pending), 'utf8'));
      if (action === 'recover-original') {
        if (!canRestoreOriginal(saved, entry)) throw new Error('这条记录没有可恢复的原文档关联，请使用检查恢复或核对备份。');
        const original = await client.node(saved.previousEntry.nodeToken);
        if (original.obj_token !== saved.previousEntry.documentId) throw new Error('原飞书节点的文档关联已变化，不能自动恢复。');
        const remote = await client.snapshot(original.obj_token);
        await backup({ kind: 'recovery-original-association', entry: structuredClone(entry), previousEntry: saved.previousEntry, recoveredAt: new Date().toISOString() });
        Object.assign(entry, saved.previousEntry, { path: notePath });
        delete entry.pending;
        await saveState(current);
        return [{ status: 'ok', path: notePath, message: '已取消本次另存为，恢复原飞书文档关联。本地内容和备份均保留；若已生成副本，也保留在飞书中。' + (remote.revision !== saved.previousEntry.revision ? '原文有新修改，请先拉取并处理冲突。' : '可以继续推送当前笔记。'), url: entry.url }];
      }
      if (saved.kind !== 'push' || !saved.remote || !saved.previousEntry ||
        saved.previousEntry.documentId !== entry.documentId || saved.previousEntry.nodeToken !== entry.nodeToken || saved.previousEntry.scope !== entry.scope) {
        throw new Error('这条记录可能涉及新文档创建或关联变更，需要核对飞书文档后恢复，不能直接解除。');
      }
      const remote = await client.snapshot(entry.documentId);
      if (remote.revision !== saved.remote.revision || !isDeepStrictEqual(remote.blocks, saved.remote.blocks)) {
        throw new Error('飞书原文已变化或存在部分写入，保护记录仍保留。请先核对飞书原文和备份。');
      }
      await backup({ kind: 'recovery', entry: structuredClone(entry), recoveredAt: new Date().toISOString() });
      delete entry.pending;
      await saveState(current);
      return [{ status: 'ok', path: notePath, message: '已确认飞书原文与写入前一致，已恢复操作。本地修改和原有备份均保留；推送仍需飞书编辑权限。' }];
    }
    if (action === 'pull') {
      if (!entry) throw new Error('此笔记尚未关联飞书，请先导入或推送。');
      const resolved = await resolveEntry(entry);
      await pull(resolved.node, notePath, resolved.remote);
      return results;
    }
    async function pushNote(notePath, copy = false) {
      let entry = current.data.entries.find((item) => item.scope === current.scope && item.path === notePath);
      if (entry?.pending) throw new Error(`上次推送中断，已阻止重复写入。请检查备份 ${entry.pending} 和飞书原文。`);
      const raw = await readNote(notePath);
      const body = splitFrontmatter(raw).body.trim();
      if (!body) throw new Error('空笔记不能推送。');
      const preparedImages = await imageMarkdown(notePath, body);
      let remote;
      let locationChanged = false;
      // The configured page anchors the imported local tree; never move it.
      const folder = path.posix.dirname(notePath);
      const parent = entry?.nodeToken === root.node_token ? null : await pushParent(folder === '.' ? '' : folder);
      const container = current.data.directories?.find((item) => item.scope === current.scope && item.path === notePath.replace(/\.md(?:own)?$/i, ''));
      if (!entry && !copy && container?.createdForFolder && !container.pending) {
        const node = await client.node(container.nodeToken);
        const snapshot = await client.snapshot(node.obj_token);
        if (snapshot.markdown.trim() || snapshot.warnings.length) throw new Error('对应父文档已被编辑，请先拉取关联后推送，避免覆盖已有内容。');
        entry = { scope: current.scope, path: notePath, nodeToken: node.node_token, documentId: node.obj_token,
          wikiPath: container.wikiPath, url: `${wiki.origin}/wiki/${node.node_token}`, revision: snapshot.revision, localHash: null };
        current.data.entries.push(entry); current.entries.push(entry); await saveState(current);
      }
      let flattenedReferences = 0;
      if (entry && !copy) {
        const resolved = await resolveEntry(entry);
        remote = resolved.remote;
        if (parent) locationChanged = await alignNode(entry, resolved.node, parent);
        if (remote.revision !== entry.revision || (entry.renderVersion === 2 && entry.remoteHash && digest(remote.markdown) !== entry.remoteHash)) throw new Error('飞书内容已有变化，请先拉取；若两端均有修改，可选择另存为飞书新文档。');
        if (digest(raw) === entry.localHash && (!preparedImages.assets.size || preparedImages.assetHash === entry.assetHash)) return [{ status: locationChanged ? 'ok' : 'unchanged', path: notePath, message: locationChanged ? '正文未变化，已将飞书页面移到对应父文档下。' : '当前笔记与上次同步一致。', url: entry.url }];
        const syncWarning = '同步块已展开为可读内容；为保留飞书引用关系，禁止覆盖推送，可另存为普通文档。';
        const warnings = [...remote.warnings, ...(entry.warnings || [])];
        const references = remote.blocks.filter((block) => block.reference_synced).length;
        // Confirmation applies only to references in this document. Never delete a
        // source block used by other documents or bypass other conversion warnings.
        const canFlatten = references > 0 && !remote.incomplete && !remote.blocks.some((block) => block.source_synced)
          && warnings.every((warning) => warning === syncWarning);
        if (warnings.length) {
          if (!canFlatten) throw new Error('原文包含无法完整还原的内容或同步块源，已阻止覆盖推送。可另存为飞书新文档。');
          if (!overwriteSyncedBlocks) throw new Error('原文包含同步引用块，请在覆盖提醒中确认后推送；确认后这些内容将转为普通内容，不再跟随源文档更新。');
          flattenedReferences = references;
        }
      }
      const conversion = await client.request('/docx/v1/documents/blocks/convert', { method: 'POST', body: { content_type: 'markdown', content: preparedImages.markdown } });
      const converted = prepareConverted(conversion, { allowImages: true });
      const imageBlocks = converted.descendants.filter((block) => block.block_type === 27);
      const imageUploads = imageBlocks.map((block) => {
        const url = conversion.block_id_to_image_urls?.find((item) => item.block_id === block.block_id)?.image_url;
        const asset = preparedImages.assets.get(url);
        if (!asset) throw new Error('飞书转换结果缺少图片对应关系，已停止推送。');
        return { temporaryId: block.block_id, asset };
      });
      if (imageUploads.length !== preparedImages.assets.size) throw new Error('飞书转换结果中的图片数量不完整，已停止推送。');
      if (await readNote(notePath) !== raw) throw new Error('本地笔记已变化，请保存完成后重试。');
      const savedBackup = await backup({ kind: 'push', path: notePath, local: raw, remote, converted, previousEntry: entry, overwriteSyncedBlocks, flattenedReferences });
      let target = entry;
      if (!entry || copy) {
        // Persist the intent before creating a node: an ambiguous network failure must never create duplicates on retry.
        target = { scope: current.scope, path: notePath, pending: savedBackup };
        if (entry) current.data.entries.splice(current.data.entries.indexOf(entry), 1, target);
        else current.data.entries.push(target);
        await saveState(current);
        let node;
        try {
          node = (await client.request(`/wiki/v2/spaces/${segment(root.space_id)}/nodes`, { method: 'POST', body: { parent_node_token: parent?.nodeToken || root.node_token, obj_type: 'docx', node_type: 'origin', title: path.basename(notePath).replace(/\.md(?:own)?$/i, '') + (copy ? '（本地副本）' : '') } })).node;
        } catch (error) {
          if ([131006, 99991672].includes(error.feishuCode)) {
            const index = current.data.entries.indexOf(target);
            if (entry) current.data.entries.splice(index, 1, entry);
            else current.data.entries.splice(index, 1);
            await saveState(current);
          }
          throw error;
        }
        Object.assign(target, { nodeToken: node.node_token, documentId: node.obj_token, wikiPath: [...(parent?.wikiPath || []), node.title], url: `${wiki.origin}/wiki/${node.node_token}` });
        await saveState(current);
        remote = await client.snapshot(target.documentId);
      } else {
        target.pending = savedBackup;
        await saveState(current);
        const latest = (await client.request(`/docx/v1/documents/${segment(target.documentId)}`)).document;
        if (latest.revision_id !== remote.revision) { delete target.pending; await saveState(current); throw new Error('飞书在同步期间有新修改，已停止写入。'); }
      }
      const endpoint = `/docx/v1/documents/${segment(target.documentId)}`;
      const previousChildren = remote.blocks.find((block) => block.block_id === target.documentId)?.children || [];
      // Insert new content first. A failure leaves the original content and backup intact.
      let inserted;
      try {
        inserted = await client.request(`${endpoint}/blocks/${segment(target.documentId)}/descendant`, { method: 'POST', query: { document_revision_id: String(remote.revision), client_token: randomUUID() }, body: converted });
      } catch (error) {
        // An explicit permission rejection before the first mutation is not a
        // partial write. Keep the backup, but don't lock an existing note forever.
        if (entry && !copy && [1770032, 99991672].includes(error.feishuCode)) {
          delete target.pending;
          await saveState(current);
        }
        throw error;
      }
      let revision = inserted.document_revision_id;
      const uploaded = [];
      for (const { temporaryId, asset } of imageUploads) {
        const blockId = inserted.block_id_relations?.find((item) => item.temporary_block_id === temporaryId)?.block_id;
        if (!blockId) throw new Error('飞书未返回新图片块的对应关系，已保留原文和备份。');
        job.progress = '正在上传图片到飞书…';
        const token = await client.uploadImage(blockId, asset);
        const updated = await client.request(`${endpoint}/blocks/${segment(blockId)}`, { method: 'PATCH', query: { document_revision_id: String(revision), client_token: randomUUID() }, body: { replace_image: { token } } });
        revision = updated.document_revision_id;
        uploaded.push({ blockId, token });
      }
      if (previousChildren.length) {
        const check = await client.snapshot(target.documentId);
        const currentChildren = check.blocks.find((block) => block.block_id === target.documentId)?.children || [];
        const expected = (inserted.children || []).map((block) => block.block_id).concat(previousChildren);
        if (check.revision !== revision || JSON.stringify(currentChildren) !== JSON.stringify(expected)) throw new Error('飞书在推送期间被编辑，已保留新旧内容并停止删除；请根据同步备份核对。');
        if (uploaded.some((item) => check.blocks.find((block) => block.block_id === item.blockId)?.image?.token !== item.token)) throw new Error('图片上传后校验失败，已保留新旧内容和备份。');
        const deleted = await client.request(`${endpoint}/blocks/${segment(target.documentId)}/children/batch_delete`, { method: 'DELETE', query: { document_revision_id: String(revision), client_token: randomUUID() }, body: { start_index: converted.children_id.length, end_index: converted.children_id.length + previousChildren.length } });
        revision = deleted.document_revision_id;
      }
      const verified = await client.snapshot(target.documentId);
      if (verified.revision !== revision) throw new Error('飞书在推送完成时又被编辑，请核对原文和备份后恢复同步。');
      if (uploaded.some((item) => verified.blocks.find((block) => block.block_id === item.blockId)?.image?.token !== item.token)) throw new Error('图片内容校验失败，请核对飞书和同步备份。');
      Object.assign(target, { revision, localHash: digest(raw), remoteHash: digest(verified.markdown), assetHash: preparedImages.assetHash, renderVersion: 2, warnings: verified.warnings, syncedAt: new Date().toISOString() });
      delete target.pending;
      await saveState(current);
      const message = preparedImages.convertedHtmlImages ? `已自动转换 ${preparedImages.convertedHtmlImages} 张 HTML 图片并推送到飞书（保留本地排版）。` : '已推送到飞书。';
      return [{ status: 'ok', path: notePath, message: message + (flattenedReferences ? `已确认覆盖原文，${flattenedReferences} 个同步引用块已转为普通内容，源文档未修改。备份：${savedBackup}` : ''), url: target.url }];
    }
    async function alignNode(record, node, parent) {
      if (node.node_token === root.node_token) return false;
      if (node.node_token === parent.nodeToken) throw new Error('不能将文档移动到自身下面。');
      if (node.space_id !== root.space_id) throw new Error('文档已离开配置的知识空间，不能自动移动。');
      if (record.pendingMove && record.pendingMove.targetParent !== parent.nodeToken) throw new Error('上次目录调整尚未核对，请先恢复到当时的目标目录后重试。');
      const items = node.has_child ? await wikiTree() : [{ node, wikiPath: record.wikiPath || [] }];
      const subtree = new Set([node.node_token]);
      for (const item of items) if (subtree.has(item.parentToken)) subtree.add(item.node.node_token);
      if (subtree.has(parent.nodeToken)) throw new Error('不能将父文档移动到自己的子文档下面。');
      const previousPath = items.find((item) => item.node.node_token === node.node_token)?.wikiPath || record.wikiPath || [];
      const nextPath = [...parent.wikiPath, node.title];
      const changed = node.parent_node_token !== parent.nodeToken;
      if (changed) {
        const saved = await backup({ kind: 'move-node', node, parent, records: structuredClone(current.data) });
        record.pendingMove = { backup: saved, sourceParent: node.parent_node_token, targetParent: parent.nodeToken };
        await saveState(current);
        let failure;
        try {
          await client.request(`/wiki/v2/spaces/${segment(root.space_id)}/nodes/${segment(node.node_token)}/move`, {
            method: 'POST', body: { target_parent_token: parent.nodeToken },
          });
        } catch (error) { failure = error; }
        // A timed-out move can have succeeded. Verify the original node before retrying.
        const verified = await client.node(node.node_token);
        if (verified.parent_node_token !== parent.nodeToken || verified.obj_token !== node.obj_token) {
          if (failure?.feishuCode === 131006 && verified.parent_node_token === node.parent_node_token && verified.obj_token === node.obj_token) {
            delete record.pendingMove; await saveState(current);
            throw new Error(`无法将「${node.title}」移到「${parent.wikiPath.join(' / ')}」：${failure.message}移动节点还需要原父文档和目标父文档的容器编辑权限，正文编辑权限不能代替。页面仍在原位置，可授权后重试。`);
          }
          throw failure || new Error('飞书页面位置校验失败，已保存目录调整备份。');
        }
      }
      for (const item of [...current.data.entries, ...(current.data.directories || [])]) {
        if (item.scope !== current.scope || !subtree.has(item.nodeToken)) continue;
        const old = items.find((candidate) => candidate.node.node_token === item.nodeToken)?.wikiPath || item.wikiPath || [];
        item.wikiPath = [...nextPath, ...old.slice(previousPath.length)];
        // A note moved locally may still have a stale directory alias from import.
        if (item.nodeToken === node.node_token && item.path !== record.path && !/\.md(?:own)?$/i.test(item.path)) item.path = record.path.replace(/\.md(?:own)?$/i, '');
      }
      record.wikiPath = nextPath;
      delete record.pendingMove;
      await saveState(current);
      if (changed) tree = undefined;
      return changed;
    }
    async function pushParent(folder) {
      const rootFolder = current.data.entries.find((item) => item.scope === current.scope && item.nodeToken === root.node_token)?.path.replace(/\.md(?:own)?$/i, '')
        || current.data.directories?.find((item) => item.scope === current.scope && item.nodeToken === root.node_token)?.path;
      if (!folder || (rootFolder && (folder === rootFolder || rootFolder.startsWith(folder + '/')))) return { nodeToken: root.node_token, wikiPath: [] };
      const ancestor = path.posix.dirname(folder);
      const parent = await pushParent(ancestor === '.' ? '' : ancestor);
      const associated = current.data.entries.find((item) => item.scope === current.scope && item.path.replace(/\.md(?:own)?$/i, '') === folder);
      if (associated) {
        const resolved = await resolveEntry(associated);
        await alignNode(associated, resolved.node, parent);
        return { nodeToken: resolved.node.node_token, wikiPath: associated.wikiPath };
      }
      current.data.directories ||= [];
      const existing = current.data.directories.find((item) => item.scope === current.scope && item.path === folder);
      if (existing) {
        if (existing.pending) throw new Error(`文件夹「${folder}」上次创建结果待确认，已阻止重复创建。备份：${existing.pending}`);
        const node = await client.node(existing.nodeToken);
        if (node.obj_type !== 'docx' || node.node_type === 'shortcut') throw new Error(`文件夹「${folder}」的飞书关联不可用。`);
        await alignNode(existing, node, parent);
        return { nodeToken: node.node_token, wikiPath: existing.wikiPath };
      }
      // Reuse an existing same-title parent document only within this exact parent.
      const children = await client.list(`/wiki/v2/spaces/${segment(root.space_id)}/nodes`, { parent_node_token: parent.nodeToken, page_size: '50' });
      const matches = children.filter((node) => node.title === path.posix.basename(folder));
      if (matches.length > 1) throw new Error(`「${folder}」对应位置有多个同名父文档，请先处理重名。`);
      if (matches.length) {
        const node = matches[0];
        if (node.obj_type !== 'docx' || node.node_type === 'shortcut') throw new Error(`「${folder}」同名节点不是普通新版文档，不能用作父文档。`);
        if ([...current.data.entries, ...current.data.directories].some((item) => item.scope === current.scope && item.nodeToken === node.node_token && item.path.replace(/\.md(?:own)?$/i, '') !== folder)) throw new Error(`「${folder}」的同名父文档已关联其他本地路径，不能重复关联。`);
        const directory = { scope: current.scope, path: folder, nodeToken: node.node_token, wikiPath: [...parent.wikiPath, node.title] };
        current.data.directories.push(directory); await saveState(current); return directory;
      }
      const saved = await backup({ kind: 'push-folder', path: folder, parent, createdAt: new Date().toISOString() });
      const directory = { scope: current.scope, path: folder, pending: saved, createdForFolder: true };
      current.data.directories.push(directory);
      await saveState(current);
      let node;
      try {
        node = (await client.request(`/wiki/v2/spaces/${segment(root.space_id)}/nodes`, { method: 'POST', body: {
          parent_node_token: parent.nodeToken, obj_type: 'docx', node_type: 'origin', title: path.posix.basename(folder),
        } })).node;
      } catch (error) {
        if ([131006, 99991672].includes(error.feishuCode)) {
          current.data.directories.splice(current.data.directories.indexOf(directory), 1);
          await saveState(current);
        }
        throw error;
      }
      const verified = await client.node(node.node_token);
      if (verified.parent_node_token !== parent.nodeToken || verified.obj_type !== 'docx') throw new Error('父文档创建后的层级校验失败，请核对同步备份。');
      Object.assign(directory, { nodeToken: node.node_token, wikiPath: [...parent.wikiPath, node.title] });
      delete directory.pending; tree = undefined;
      await saveState(current);
      return directory;
    }
    if (action === 'push') return pushNote(notePath, copy);
    if (action === 'push-folders') {
      const { notes: paths, directories } = await collectPushNotes(folders);
      job.total = paths.length; job.completed = 0;
      job.results = results;
      for (const file of paths) {
        job.progress = `正在推送 ${job.completed + 1}/${paths.length}：${file}`;
        try { results.push(...await pushNote(file)); }
        catch (error) { results.push({ status: 'error', path: file, message: error.message }); }
        job.completed++;
      }
      for (const folder of directories) {
        try {
          await pushParent(folder);
          if (!paths.some((file) => file.startsWith(folder + '/'))) results.push({ status: 'ok', path: folder, message: '空文件夹已对应到飞书父文档。' });
        } catch (error) { results.push({ status: 'error', path: folder, message: error.message }); }
      }
      if (!paths.length && !directories.length) results.push({ status: 'unchanged', message: '所选范围中没有笔记或文件夹。' });
      return results;
    }
    throw new Error('同步操作无效。');
  }

  async function collectPushNotes(folders) {
    // Validate every requested folder before the first remote write.
    for (const folder of folders) {
      const absolute = folder ? await safePath(folder) : await realpath(notesRoot);
      if (!(await lstat(absolute)).isDirectory()) throw new Error(`不是文件夹：${folder}`);
    }
    const selected = [...new Set(folders)].filter((folder, _, all) => !all.some((parent) => parent !== folder && (parent === '' || folder.startsWith(parent + '/'))));
    const notes = new Set(), directories = new Set();
    async function walk(folder) {
      if (folder) directories.add(folder);
      const absolute = folder ? await safePath(folder) : await realpath(notesRoot);
      const entries = await readdir(absolute, { withFileTypes: true });
      for (const item of entries) {
        if (item.name.startsWith('.') || item.name === 'node_modules' || item.name.endsWith('.assets') || item.isSymbolicLink()) continue;
        const relative = path.posix.join(folder, item.name);
        if (item.isDirectory()) await walk(relative);
        else if (item.isFile() && /\.md(?:own)?$/i.test(item.name)) notes.add(relative);
      }
    }
    for (const folder of selected) await walk(folder);
    // Push parent documents before their descendants, so their existing nodes can serve as folders.
    return { notes: [...notes].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b, 'zh-CN')), directories: [...directories].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b, 'zh-CN')) };
  }
  async function start(action, notePath, copy = false, nodeTokens = [], folders = [], overwriteSyncedBlocks = false, pullConfirmationToken) {
    if (busy) throw new Error('已有同步任务正在运行。');
    if (!['connect', 'discover', 'import-selected', 'import', 'pull', 'push', 'push-folders', 'recover', 'recover-original'].includes(action)) throw new Error('同步操作无效。');
    const pullConfirmation = pullConfirmationToken ? pullConfirmations.get(pullConfirmationToken) : undefined;
    if (pullConfirmationToken !== undefined && (action !== 'pull' || !pullConfirmation || pullConfirmation.path !== notePath)) throw new Error('覆盖确认已失效，请重新拉取并确认。');
    if (action === 'import-selected' && (!Array.isArray(nodeTokens) || !nodeTokens.length || nodeTokens.length > 10000 || nodeTokens.some((token) => typeof token !== 'string' || !/^[a-zA-Z0-9]+$/.test(token)))) throw new Error('请勾选要拉取的笔记。');
    if (action === 'push-folders' && (!Array.isArray(folders) || !folders.length || folders.length > 1000 || folders.some((folder) => typeof folder !== 'string' || (folder !== '' && (path.isAbsolute(folder) || folder.includes('\\') || folder.split('/').some((part) => !part || part.startsWith('.') || part === 'node_modules' || part.endsWith('.assets'))))))) throw new Error('请选择知识库内要推送的文件夹。');
    busy = true;
    // A cross-process lock also protects against two local servers using the same vault.
    let lock, lockPath;
    try {
      lockPath = await safePath('.zhixu-feishu/sync.lock', true);
      lock = await open(lockPath, 'wx', 0o600);
      await lock.writeFile(String(process.pid));
    } catch (error) { busy = false; throw new Error(error.code === 'EEXIST' ? '笔记目录已被其他同步进程锁定；若上次异常退出，请确认进程结束后移除 .zhixu-feishu/sync.lock。' : error.message); }
    job = { id: randomUUID(), action, path: notePath, folders, state: 'running', progress: '正在连接飞书…', results: [] };
    if (pullConfirmationToken) pullConfirmations.delete(pullConfirmationToken);
    void execute(action, notePath, copy, nodeTokens, folders, overwriteSyncedBlocks === true, pullConfirmation).then((results) => { job.results = results; job.state = results.some((result) => result.status === 'error' || result.status === 'conflict') ? 'attention' : 'done'; }, (error) => { job.state = 'error'; job.results = [{ status: 'error', message: error.message }]; }).finally(async () => {
      try { await lock.close(); await unlink(lockPath); }
      catch { job.state = 'attention'; job.results.push({ status: 'error', message: '无法释放同步锁，请检查 .zhixu-feishu/sync.lock。' }); }
      finally { busy = false; }
    });
    return { job };
  }
  return { status, saveConfig, start, get busy() { return busy; }, privateRoot };
}

export function allowFeishuRequest(request, port) {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!hosts.has(request.headers.host)) return false;
  const origin = request.headers.origin;
  if (origin && !new Set(['http://localhost:3000', 'http://127.0.0.1:3000', `http://127.0.0.1:${port}`, `http://localhost:${port}`]).has(origin)) return false;
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  return request.method !== 'POST' || String(request.headers['content-type']).split(';')[0] === 'application/json';
}
