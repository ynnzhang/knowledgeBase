import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink, stat, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { FeishuClient, createFeishuSync, parseWikiUrl, allowFeishuRequest } from './feishu-sync.mjs';
import { blocksToMarkdown, prepareConverted } from './feishu-markdown.mjs';
import { renameFeishuNotes } from './rename-feishu-notes.mjs';
import { expandSyncedBlocks } from './feishu-content.mjs';
import { bytesHash, imageType, imageResponse, markdownImages, prepareImageMarkdown, MAX_IMAGE_BYTES } from './feishu-media.mjs';

const textBlock = (id, content) => ({ block_id: id, block_type: 2, text: { elements: [{ text_run: { content } }] } });
const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN3kAAAAASUVORK5CYII=', 'base64');
class FakeFeishu {
  constructor() {
    this.nodes = [{ node_token: 'root', obj_token: 'docRoot', space_id: 'space1', title: '技术提升', obj_type: 'docx', node_type: 'origin', has_child: true }, { node_token: 'child', obj_token: 'docChild', space_id: 'space1', parent_node_token: 'root', title: '子页面', obj_type: 'docx', node_type: 'origin' }];
    this.docs = new Map(); this.mutations = []; this.failInsert = false; this.failCreate = false;
    this.media = new Map(); this.downloads = []; this.uploads = [];
    this.set('docRoot', '根内容'); this.set('docChild', '子内容');
  }
  set(id, content) {
    const previous = this.docs.get(id);
    this.docs.set(id, { revision: (previous?.revision || 0) + 1, title: id, blocks: [{ block_id: id, block_type: 1, children: [id + 'text'] }, textBlock(id + 'text', content)] });
  }
  async node(token) {
    const node = this.nodes.find((node) => node.node_token === token);
    if (!node) throw Object.assign(new Error('飞书接口失败（1770003）。'), { feishuCode: 1770003 });
    return node;
  }
  async list(endpoint, query = {}) {
    if (endpoint.startsWith('/docx/')) {
      assert.equal(query.with_descendants, 'true');
      const parts = endpoint.split('/'), doc = this.docs.get(parts[4]), items = [];
      const visit = (id) => { const block = doc.blocks.find((block) => block.block_id === id); items.push(block); for (const child of block.children || []) visit(child); };
      visit(parts[6]); return structuredClone(items);
    }
    return this.nodes.slice(1).filter((node) => (node.parent_node_token || 'root') === query.parent_node_token);
  }
  async snapshot(id) {
    if (!this.docs.has(id)) throw Object.assign(new Error('飞书接口失败（1770003）。'), { feishuCode: 1770003 });
    const doc = structuredClone(this.docs.get(id));
    const expanded = doc.blocks.some((block) => block.reference_synced) ? await expandSyncedBlocks(this, doc.blocks, id) : { renderBlocks: doc.blocks, incomplete: false };
    return { ...doc, ...expanded, ...blocksToMarkdown(expanded.renderBlocks, id), renderVersion: 2 };
  }
  async downloadImage(token) { this.downloads.push(token); if (!this.media.has(token)) throw new Error('没有图片下载权限'); return { bytes: this.media.get(token), ...imageType(this.media.get(token)) }; }
  async uploadImage(blockId, asset) {
    if (this.failUpload) throw new Error('图片上传失败');
    const token = `uploaded${this.uploads.length}`; this.media.set(token, asset.bytes); this.uploads.push({ blockId, token, bytes: asset.bytes }); return token;
  }
  recreate(token, content) {
    const index = this.nodes.findIndex((node) => node.node_token === token);
    const old = this.nodes[index];
    const node = { ...old, node_token: token + 'New', obj_token: old.obj_token + 'New' };
    this.nodes.splice(index, 1, node);
    this.docs.delete(old.obj_token);
    this.set(node.obj_token, content);
    return node;
  }
  async request(endpoint, options = {}) {
    const { method = 'GET', body } = options;
    if (endpoint.endsWith('/convert')) {
      const images = markdownImages(body.content);
      if (!images.length) return { blocks: [textBlock('temp', body.content)], first_level_block_ids: ['temp'] };
      const blocks = [], mapping = []; let cursor = 0;
      for (const image of images) {
        if (image.start > cursor) blocks.push(textBlock(`temp${blocks.length}`, body.content.slice(cursor, image.start).trim()));
        const id = `temp${blocks.length}`;
        blocks.push({ block_id: id, block_type: 27, image: {} }); mapping.push({ block_id: id, image_url: image.source }); cursor = image.end;
      }
      if (cursor < body.content.length) blocks.push(textBlock(`temp${blocks.length}`, body.content.slice(cursor).trim()));
      return { blocks, first_level_block_ids: blocks.map((block) => block.block_id), block_id_to_image_urls: mapping };
    }
    const docId = endpoint.split('/')[4];
    if (method === 'GET') return { document: { revision_id: this.docs.get(docId).revision } };
    this.mutations.push({ endpoint, method, body });
    if (endpoint.endsWith('/move')) {
      const node = this.nodes.find((node) => node.node_token === endpoint.split('/')[6]);
      node.parent_node_token = body.target_parent_token;
      this.nodes.find((item) => item.node_token === body.target_parent_token).has_child = true;
      if (this.failMoveAfterApply) throw new Error('移动响应超时');
      return { node };
    }
    if (endpoint.endsWith('/nodes')) {
      if (this.failCreate) throw this.failCreate instanceof Error ? this.failCreate : new Error('创建请求超时');
      const node = { node_token: `node${this.nodes.length}`, obj_token: `doc${this.nodes.length}`, title: body.title, parent_node_token: body.parent_node_token, obj_type: 'docx', node_type: 'origin', space_id: 'space1' };
      this.nodes.find((item) => item.node_token === body.parent_node_token).has_child = true;
      this.nodes.push(node);
      this.docs.set(node.obj_token, { revision: 1, title: node.title, blocks: [{ block_id: node.obj_token, block_type: 1, children: [] }] });
      return { node };
    }
    const doc = this.docs.get(docId);
    if (method === 'PATCH' && body.replace_image) {
      const block = doc.blocks.find((block) => block.block_id === endpoint.split('/')[6]);
      block.image.token = body.replace_image.token; doc.revision++;
      return { document_revision_id: doc.revision };
    }
    if (endpoint.endsWith('/descendant')) {
      if (this.failInsert) throw this.failInsert instanceof Error ? this.failInsert : new Error('写入请求超时');
      const relations = body.descendants.map((block, index) => ({ temporary_block_id: block.block_id, block_id: `${docId}-new-${doc.revision}-${index}` }));
      const actualId = (id) => relations.find((item) => item.temporary_block_id === id).block_id;
      const blocks = body.descendants.map((block) => ({ ...structuredClone(block), block_id: actualId(block.block_id), ...(block.children ? { children: block.children.map(actualId) } : {}) }));
      const children = body.children_id.map((id) => blocks.find((block) => block.block_id === actualId(id)));
      doc.blocks[0].children.unshift(...children.map((block) => block.block_id)); doc.blocks.push(...blocks); doc.revision++;
      return { document_revision_id: doc.revision, children, block_id_relations: relations };
    }
    if (endpoint.endsWith('/batch_delete')) {
      const removed = doc.blocks[0].children.splice(body.start_index, body.end_index - body.start_index);
      doc.blocks = doc.blocks.filter((block) => !removed.includes(block.block_id)); doc.revision++;
      return { document_revision_id: doc.revision };
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  }
}
async function setup(t) {
  const folder = await mkdtemp(path.join(tmpdir(), 'zhixu-feishu-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const notes = path.join(folder, 'notes'); await mkdir(notes);
  const fake = new FakeFeishu();
  const service = createFeishuSync({ projectRoot: folder, notesRoot: notes, env: {}, clientFactory: () => fake });
  await service.saveConfig({ appId: 'cli_test', appSecret: 'test-secret', wikiUrl: 'https://my.feishu.cn/wiki/root' });
  const run = async (action, notePath, copy = false, nodeTokens, folders, overwriteSyncedBlocks = false) => {
    await service.start(action, notePath, copy, nodeTokens, folders, overwriteSyncedBlocks);
    for (let count = 0; count < 500 && service.busy; count++) await delay(5);
    assert.equal(service.busy, false);
    return (await service.status(notePath)).job;
  };
  return { folder, notes, fake, service, run };
}

test('wiki URLs and local HTTP origins are constrained', () => {
  assert.equal(parseWikiUrl('https://my.feishu.cn/wiki/abc?foo=bar').token, 'abc');
  for (const url of ['http://my.feishu.cn/wiki/abc', 'https://feishu.cn.evil.test/wiki/abc', 'https://my.feishu.cn/docx/abc', 'https://x:y@my.feishu.cn/wiki/a']) assert.throws(() => parseWikiUrl(url));
  const headers = { host: '127.0.0.1:4312', origin: 'http://localhost:3000', 'content-type': 'application/json' };
  assert.equal(allowFeishuRequest({ method: 'POST', headers }, 4312), true);
  assert.equal(allowFeishuRequest({ method: 'POST', headers: { ...headers, origin: 'https://evil.test' } }, 4312), false);
  assert.equal(allowFeishuRequest({ method: 'GET', headers: { host: 'evil.test:4312' } }, 4312), false);
  assert.equal(allowFeishuRequest({ method: 'POST', headers: { ...headers, 'content-type': 'text/plain' } }, 4312), false);
});

test('block conversion preserves text semantics, nested lists, code fences, and image references', () => {
  const blocks = [
    { block_id: 'doc', block_type: 1, children: ['heading', 'bullet', 'code', 'image'] },
    { block_id: 'heading', block_type: 3, heading1: { elements: [{ text_run: { content: '标题', text_element_style: { bold: true } } }] } },
    { block_id: 'bullet', block_type: 12, bullet: { elements: [{ text_run: { content: '项目' } }] }, children: ['nested'] },
    textBlock('nested', '嵌套 <script> *文本*'),
    { block_id: 'code', block_type: 14, code: { style: { language: 30 }, elements: [{ text_run: { content: 'const x = "```";' } }] } },
    { block_id: 'image', block_type: 27, image: { token: 'asset' } },
  ];
  const result = blocksToMarkdown(blocks, 'doc');
  assert.match(result.markdown, /# \*\*标题\*\*/);
  assert.match(result.markdown, /    嵌套 \\<script\\>/);
  assert.match(result.markdown, /````javascript/);
  assert.equal(result.warnings.length, 0);
  assert.match(result.markdown, /!\[图片\]\(<feishu-image:asset>\)/);
  assert.throws(() => prepareConverted({ blocks: [{ block_type: 27 }], first_level_block_ids: ['img'] }), /图片/);
  const table = prepareConverted({ blocks: [{ block_type: 31, parent_id: 'root', table: { property: { merge_info: [], column_size: 1 } } }], first_level_block_ids: ['a'] });
  assert.equal(table.descendants[0].parent_id, undefined);
  assert.equal(table.descendants[0].table.property.merge_info, undefined);
});

test('numbered headings and paragraphs preserve text without a visible escape or accidental list', () => {
  for (const label of ['2. Flyway 是什么', '12. 数据库迁移', '2) 使用方法']) {
    const blocks = [
      { block_id: 'doc', block_type: 1, children: ['heading', 'paragraph'] },
      { block_id: 'heading', block_type: 4, heading2: { elements: [{ text_run: { content: label } }] } },
      textBlock('paragraph', label),
    ];
    const { markdown } = blocksToMarkdown(blocks, 'doc');
    for (const source of [markdown, markdown.replaceAll('\n', '\r\n')]) {
      const tree = fromMarkdown(source);
      assert.deepEqual(tree.children.map((node) => node.type), ['heading', 'paragraph']);
      assert.deepEqual(tree.children.map((node) => node.children[0].value), [label, label]);
    }
  }
});

test('client caches tokens, handles empty wiki pages, and retries rate limits', async () => {
  const calls = []; let attempts = 0;
  const client = new FeishuClient({ appId: 'cli_test', appSecret: 'private-secret' }, async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/auth/')) return Response.json({ code: 0, tenant_access_token: 'token', expire: 7200 });
    attempts++;
    if (attempts === 1) return Response.json({ code: 99991400 }, { status: 400 });
    if (!url.includes('page_token=next')) return Response.json({ code: 0, data: { items: [], has_more: true, page_token: 'next' } });
    return Response.json({ code: 0, data: { items: [{ node_token: 'node' }], has_more: false } });
  }, async () => {});
  assert.deepEqual(await client.list('/wiki/v2/spaces/space/nodes'), [{ node_token: 'node' }]);
  assert.equal(calls.filter((call) => call.url.includes('/auth/')).length, 1);
  const denied = new FeishuClient({ appId: 'a', appSecret: 'secret' }, async () => Response.json({ code: 1, msg: 'secret' }), async () => {});
  await assert.rejects(() => denied.accessToken(), (error) => !error.message.includes('secret'));
});

test('read pacing shares quotas across documents, starts immediately and accounts for network time', async () => {
  let clock = 0, slow = false;
  const waits = [], starts = [];
  const client = new FeishuClient({ appId: 'a', appSecret: 'b' }, async (url) => {
    if (url.includes('/auth/')) return Response.json({ code: 0, tenant_access_token: 'token', expire: 7200 });
    starts.push(clock);
    if (slow) clock += 800;
    return Response.json({ code: 0, data: {} });
  }, async (ms) => { waits.push(ms); clock += ms; }, () => clock);
  await client.request('/docx/v1/documents/a');
  assert.deepEqual(waits, []);
  await client.request('/docx/v1/documents/b/blocks');
  assert.deepEqual(starts, [0, 220]);
  slow = true;
  await client.request('/docx/v1/documents/a');
  const count = waits.length;
  await client.request('/docx/v1/documents/b');
  assert.equal(waits.length, count, 'network time already satisfied the interval');
  slow = false;
  await client.request('/wiki/v2/spaces/s/nodes');
  await client.request('/wiki/v2/spaces/get_node');
  assert.equal(waits.at(-1), 650);
  await client.request('/drive/v1/medias/a/download');
  await client.request('/drive/v1/medias/b/download');
  assert.equal(waits.at(-1), 220);
  await client.request('/docx/v1/documents/a/blocks', { method: 'POST' });
  await client.request('/docx/v1/documents/b/blocks', { method: 'POST' });
  assert.equal(waits.at(-1), 650);
});

test('concurrent reads share token acquisition and wait for their shared rate slot', async () => {
  let clock = 0, tokens = 0, reads = 0;
  const waiting = [];
  const client = new FeishuClient({ appId: 'a', appSecret: 'b' }, async (url) => {
    if (url.includes('/auth/')) {
      tokens++; await delay(5);
      return Response.json({ code: 0, tenant_access_token: 'token', expire: 7200 });
    }
    reads++; return Response.json({ code: 0, data: {} });
  }, (ms) => new Promise((resolve) => waiting.push(() => { clock += ms; resolve(); })), () => clock);
  const requests = Array.from({ length: 3 }, (_, index) => client.request(`/docx/v1/documents/doc${index}`));
  for (let i = 0; i < 100 && !waiting.length; i++) await delay(1);
  assert.equal(tokens, 1); assert.equal(reads, 1); assert.equal(waiting.length, 1);
  waiting.shift()();
  for (let i = 0; i < 100 && !waiting.length; i++) await delay(1);
  assert.equal(reads, 2); assert.equal(waiting.length, 1);
  waiting.shift()();
  await Promise.all(requests);
  assert.equal(reads, 3); assert.equal(clock, 440);
});

test('import recursively, preserve YAML, pull remote updates, detect two-sided conflicts', async (t) => {
  const { notes, fake, service, run } = await setup(t);
  assert.equal((await run('import')).state, 'done');
  const filePath = '飞书/技术提升/子页面.md';
  assert.match(await readFile(path.join(notes, filePath), 'utf8'), /子内容/);
  fake.set('docChild', '飞书更新');
  assert.equal((await run('pull', filePath)).state, 'done');
  let raw = await readFile(path.join(notes, filePath), 'utf8');
  assert.match(raw, /title: "docChild"/);
  assert.match(raw, /飞书更新/);
  await writeFile(path.join(notes, filePath), raw + '\n本地新增');
  fake.set('docChild', '飞书再次更新');
  const conflict = await run('pull', filePath);
  assert.equal(conflict.state, 'attention'); assert.equal(conflict.results[0].status, 'conflict');
  assert.equal(await readFile(path.join(notes, filePath), 'utf8'), raw + '\n本地新增');
  assert.equal((await run('push', filePath)).state, 'error');
  assert.equal(fake.mutations.length, 0);
  const status = await service.status(filePath);
  assert.equal(JSON.stringify(status).includes('test-secret'), false);
  assert.ok((await readdir(path.join(notes, '.zhixu-feishu', 'backups'))).length >= 4);
});

test('snapshot reads latest without history permission and rejects concurrent edits', async () => {
  for (const changed of [false, true]) {
    let metadataReads = 0;
    const client = new FeishuClient({ appId: 'cli_test', appSecret: 'test-secret' }, async (url) => {
      if (url.includes('/auth/')) return Response.json({ code: 0, tenant_access_token: 'token', expire: 7200 });
      if (url.includes('/blocks?')) {
        assert.equal(new URL(url).searchParams.get('document_revision_id'), '-1');
        return Response.json({ code: 0, data: { items: [{ block_id: 'doc', block_type: 1, children: ['text'] }, textBlock('text', '最新正文')], has_more: false } });
      }
      metadataReads++;
      return Response.json({ code: 0, data: { document: { title: '文档', revision_id: changed && metadataReads > 1 ? 4 : 3 } } });
    }, async () => {});
    if (changed) await assert.rejects(() => client.snapshot('doc'), /正在被编辑/);
    else assert.equal((await client.snapshot('doc')).markdown, '最新正文\n');
  }
});

test('push new note once then update the same document, excluding frontmatter', async (t) => {
  const { notes, fake, run, service, folder } = await setup(t);
  await writeFile(path.join(notes, '笔记.md'), '---\ntags: [私有]\n---\n\n第一版');
  assert.equal((await run('push', '笔记.md')).state, 'done');
  const entry = (await service.status('笔记.md')).entry;
  assert.equal(fake.nodes.length, 3);
  assert.equal((await run('push', '笔记.md')).results[0].status, 'unchanged');
  await writeFile(path.join(notes, '笔记.md'), '---\ntags: [私有]\n---\n\n第二版');
  assert.equal((await run('push', '笔记.md')).state, 'done');
  assert.equal(fake.nodes.length, 3);
  const remote = await fake.snapshot(entry.documentId);
  assert.equal(remote.markdown, '第二版\n');
  assert.equal(remote.blocks[0].children.length, 1);
  assert.ok(!JSON.stringify(fake.mutations).includes('私有'));
  // Windows does not implement POSIX owner/group permission bits.
  if (process.platform !== 'win32') assert.equal((await stat(path.join(folder, '.feishu-local.json'))).mode & 0o777, 0o600);
});

test('failed writes retain originals and block unsafe retry', async (t) => {
  const { notes, fake, run, service } = await setup(t);
  await run('import');
  const notePath = '飞书/技术提升.md';
  await writeFile(path.join(notes, notePath), '新内容');
  fake.failInsert = true;
  assert.equal((await run('push', notePath)).state, 'error');
  assert.match((await fake.snapshot('docRoot')).markdown, /根内容/);
  assert.ok((await service.status(notePath)).entry.pending);
  const writes = fake.mutations.length;
  assert.equal((await run('push', notePath)).state, 'error');
  assert.equal(fake.mutations.length, writes);
});

test('uncertain wiki creation is journaled and cannot create duplicate nodes on retry', async (t) => {
  const { notes, fake, run } = await setup(t);
  await writeFile(path.join(notes, '新建.md'), '正文'); fake.failCreate = true;
  assert.equal((await run('push', '新建.md')).state, 'error');
  const writes = fake.mutations.length;
  await run('push', '新建.md');
  assert.equal(fake.mutations.length, writes);
  assert.equal((await run('recover', '新建.md')).state, 'error');
});

test('recovery unlocks only an unchanged original, preserving local edits and the sync baseline', async (t) => {
  const { notes, fake, run, service } = await setup(t);
  await run('import');
  const notePath = '飞书/技术提升.md';
  const original = (await service.status(notePath)).entry;
  await writeFile(path.join(notes, notePath), '保留本地修改');
  fake.failInsert = true;
  await run('push', notePath);
  const backup = (await service.status(notePath)).entry.pending;
  assert.ok(backup);
  const recovery = await run('recover', notePath);
  assert.equal(recovery.state, 'done', JSON.stringify(recovery.results));
  const recovered = (await service.status(notePath)).entry;
  assert.equal(recovered.pending, undefined);
  assert.equal(recovered.localHash, original.localHash);
  assert.equal(recovered.revision, original.revision);
  assert.equal(await readFile(path.join(notes, notePath), 'utf8'), '保留本地修改');
  await stat(path.join(notes, backup));
  fake.failInsert = false;
  assert.equal((await run('push', notePath)).state, 'done');
  assert.equal((await fake.snapshot('docRoot')).markdown, '保留本地修改\n');
});

test('recovery keeps protection if remote changed after a failed write', async (t) => {
  const { notes, fake, run, service } = await setup(t);
  await run('import');
  const notePath = '飞书/技术提升.md';
  await writeFile(path.join(notes, notePath), '本地新内容');
  fake.failInsert = true;
  await run('push', notePath);
  fake.set('docRoot', '飞书又被修改');
  assert.equal((await run('recover', notePath)).state, 'error');
  assert.ok((await service.status(notePath)).entry.pending);
  assert.equal(await readFile(path.join(notes, notePath), 'utf8'), '本地新内容');
});

test('user can cancel a failed copy and restore its original association without altering either document', async (t) => {
  const { notes, fake, run, service } = await setup(t);
  await run('import');
  const notePath = '飞书/技术提升.md';
  const original = (await service.status(notePath)).entry;
  await writeFile(path.join(notes, notePath), '本地修改保留');
  fake.failCreate = true;
  await run('push', notePath, true);
  assert.equal((await service.status(notePath)).entry.documentId, undefined);
  fake.nodes.push({ node_token: 'uncertain', title: '技术提升（本地副本）' });
  assert.equal((await run('recover', notePath)).state, 'error');
  assert.ok((await service.status(notePath)).entry.pending);
  assert.equal((await service.status(notePath)).recovery.canRestoreOriginal, true);
  const writes = fake.mutations.length;
  const result = await run('recover-original', notePath);
  assert.equal(result.state, 'done', JSON.stringify(result.results));
  assert.deepEqual((await service.status(notePath)).entry, original);
  assert.equal(await readFile(path.join(notes, notePath), 'utf8'), '本地修改保留');
  assert.equal(fake.nodes.at(-1).node_token, 'uncertain');
  assert.equal(fake.mutations.length, writes);
  assert.equal((await service.status(notePath)).recovery, undefined);
});

test('copy creation denied by permissions preserves the original association', async (t) => {
  const { fake, run, service } = await setup(t);
  await run('import');
  const notePath = '飞书/技术提升.md';
  const original = (await service.status(notePath)).entry;
  fake.failCreate = Object.assign(new Error('权限不足'), { feishuCode: 131006 });
  assert.equal((await run('push', notePath, true)).state, 'error');
  assert.deepEqual((await service.status(notePath)).entry, original);
});

test('explicit permission denial before insertion does not lock an existing note', async (t) => {
  const { notes, fake, run, service } = await setup(t);
  await run('import');
  const notePath = '飞书/技术提升.md';
  await writeFile(path.join(notes, notePath), '本地修改');
  fake.failInsert = Object.assign(new Error('没有编辑权限'), { feishuCode: 1770032 });
  assert.equal((await run('push', notePath)).state, 'error');
  assert.equal((await service.status(notePath)).entry.pending, undefined);
  assert.equal((await fake.snapshot('docRoot')).markdown, '根内容\n');
});

test('sync rejects escaping paths, symlinks and overlapping jobs', async (t) => {
  const { folder, notes, service, run } = await setup(t);
  await writeFile(path.join(folder, 'outside.md'), '外部文件');
  await symlink(path.join(folder, 'outside.md'), path.join(notes, 'link.md'));
  for (const name of ['../outside.md', 'link.md']) assert.equal((await run('push', name)).state, 'error');
  await service.start('import');
  await assert.rejects(() => service.start('import'), /正在运行/);
  while (service.busy) await delay(5);
  assert.equal(await readFile(path.join(folder, 'outside.md'), 'utf8'), '外部文件');
});

test('imports escape Windows device names in files and parent directories', async (t) => {
  const { notes, fake, run } = await setup(t);
  fake.nodes[0].title = 'CON';
  fake.nodes[1].title = 'NUL.txt';
  const result = await run('import');
  assert.equal(result.state, 'done');
  await stat(path.join(notes, '飞书/_CON.md'));
  await stat(path.join(notes, '飞书/_CON/_NUL.txt.md'));
  assert.equal((await run('import')).state, 'done');
  assert.deepEqual(await readdir(path.join(notes, '飞书/_CON')), ['_NUL.txt.md']);
});

test('imports use titles and short collision numbers, with stable repeated imports', async (t) => {
  const { notes, fake, run } = await setup(t);
  fake.nodes[1].title = '同名';
  fake.nodes.push({ ...fake.nodes[1], node_token: 'other', obj_token: 'docOther' });
  fake.set('docOther', '另一个同名文档');
  await mkdir(path.join(notes, '飞书', '技术提升'), { recursive: true });
  await writeFile(path.join(notes, '飞书', '技术提升', '同名.md'), '用户已有笔记');
  // The occupied root directory also receives a short suffix to prevent merging unrelated trees.
  assert.equal((await run('import')).state, 'done');
  const state = JSON.parse(await readFile(path.join(notes, '.zhixu-feishu', 'state.json'), 'utf8'));
  assert.deepEqual(state.entries.map((entry) => entry.path), ['飞书/技术提升（2）.md', '飞书/技术提升（2）/同名.md', '飞书/技术提升（2）/同名（2）.md']);
  assert.equal((await run('import')).state, 'done');
  assert.equal(await readFile(path.join(notes, '飞书', '技术提升', '同名.md'), 'utf8'), '用户已有笔记');
  assert.equal(JSON.parse(await readFile(path.join(notes, '.zhixu-feishu', 'state.json'), 'utf8')).entries.length, 3);
});

test('legacy filename migration preserves content, nested directories and sync associations', async (t) => {
  const { notes, service, run } = await setup(t);
  await mkdir(path.join(notes, '飞书', '技术提升-root'), { recursive: true });
  await mkdir(path.join(notes, '.zhixu-feishu'));
  await writeFile(path.join(notes, '飞书', '技术提升-root.md'), '根内容');
  await writeFile(path.join(notes, '飞书', '技术提升-root', '子页面-child.md'), '子页面正文\n本地修改');
  await writeFile(path.join(notes, '飞书', '技术提升-root', '子页面.md'), '已有同名文件');
  await writeFile(path.join(notes, '飞书', '技术提升-root', '图片.png'), '图片内容');
  const state = { version: 1, entries: [
    { scope: 'cli_test:root', nodeToken: 'root', documentId: 'docRoot', path: '飞书/技术提升-root.md', revision: 1, localHash: 'unchanged' },
    { scope: 'cli_test:root', nodeToken: 'child', documentId: 'docChild', path: '飞书/技术提升-root/子页面-child.md', revision: 1, localHash: 'unchanged' },
  ] };
  await writeFile(path.join(notes, '.zhixu-feishu', 'state.json'), JSON.stringify(state));
  const preview = await renameFeishuNotes(notes);
  assert.equal(preview.changes.length, 2);
  assert.equal(await readFile(path.join(notes, '飞书', '技术提升-root.md'), 'utf8'), '根内容');
  const result = await renameFeishuNotes(notes, true);
  assert.deepEqual(result.paths, ['飞书/技术提升.md', '飞书/技术提升/子页面（2）.md']);
  assert.equal(await readFile(path.join(notes, '飞书', '技术提升', '子页面（2）.md'), 'utf8'), '子页面正文\n本地修改');
  assert.equal(await readFile(path.join(notes, '飞书', '技术提升', '图片.png'), 'utf8'), '图片内容');
  assert.equal(await readFile(path.join(notes, '飞书', '技术提升', '子页面.md'), 'utf8'), '已有同名文件');
  assert.equal((await service.status('飞书/技术提升/子页面（2）.md')).entry.nodeToken, 'child');
  assert.equal((await renameFeishuNotes(notes, true)).changes.length, 0);
  assert.equal((await run('import')).state, 'done');
  assert.equal(JSON.parse(await readFile(path.join(notes, '.zhixu-feishu', 'state.json'), 'utf8')).entries.length, 2);
  assert.ok(result.backup);
});

for (const action of ['pull', 'push', 'import']) {
  test(`${action} rebinds a recreated document at the same path without duplicate files`, async (t) => {
    const { notes, fake, run, service } = await setup(t);
    await run('import');
    const notePath = '飞书/技术提升/子页面.md';
    const original = await readFile(path.join(notes, notePath), 'utf8');
    const replacement = fake.recreate('child', '子内容');
    // New documents have independent revision counters.
    fake.set(replacement.obj_token, '子内容');
    if (action === 'push') await writeFile(path.join(notes, notePath), original + '\n本地新增');
    const result = await run(action, notePath);
    assert.equal(result.state, 'done', JSON.stringify(result.results));
    const entry = (await service.status(notePath)).entry;
    assert.equal(entry.documentId, replacement.obj_token);
    assert.equal(entry.nodeToken, replacement.node_token);
    assert.match(entry.url, /childNew$/);
    assert.equal(entry.pending, undefined);
    assert.deepEqual(await readdir(path.join(notes, '飞书/技术提升')), ['子页面.md']);
    assert.equal(fake.mutations.some((mutation) => mutation.endpoint.endsWith('/nodes')), false);
    if (action === 'push') assert.match((await fake.snapshot(entry.documentId)).markdown, /本地新增/);
    else assert.equal(await readFile(path.join(notes, notePath), 'utf8'), original);
    fake.set(entry.documentId, '重建后的更新');
    assert.equal((await run('pull', notePath)).state, 'done');
    assert.match(await readFile(path.join(notes, notePath), 'utf8'), /重建后的更新/);
  });
}

test('legacy records rebind using the full local path and original content hash', async (t) => {
  const { notes, fake, run, service } = await setup(t);
  await run('import');
  const stateFile = path.join(notes, '.zhixu-feishu/state.json');
  const saved = JSON.parse(await readFile(stateFile, 'utf8'));
  for (const entry of saved.entries) { delete entry.wikiPath; delete entry.remoteHash; }
  await writeFile(stateFile, JSON.stringify(saved));
  fake.recreate('child', '子内容');
  const notePath = '飞书/技术提升/子页面.md';
  await writeFile(path.join(notes, notePath), '本地更新');
  assert.equal((await run('push', notePath)).state, 'done');
  assert.equal((await service.status(notePath)).entry.documentId, 'docChildNew');
  assert.equal((await fake.snapshot('docChildNew')).markdown, '本地更新\n');
});

for (const localChanged of [false, true]) {
  test(`recreated document with equal revision and different content preserves conflict checks (localChanged=${localChanged})`, async (t) => {
    const { notes, fake, run, service } = await setup(t);
    await run('import');
    const notePath = '飞书/技术提升/子页面.md';
    const before = await readFile(path.join(notes, notePath), 'utf8');
    fake.recreate('child', '重建的新正文');
    if (localChanged) await writeFile(path.join(notes, notePath), before + '\n本地修改');
    assert.equal((await run('push', notePath)).state, 'error');
    assert.equal(fake.mutations.length, 0);
    assert.equal((await service.status(notePath)).entry.revision, null);
    const result = await run('pull', notePath);
    assert.equal(result.state, localChanged ? 'attention' : 'done');
    const after = await readFile(path.join(notes, notePath), 'utf8');
    if (localChanged) assert.equal(after, before + '\n本地修改');
    else { assert.match(after, /title: "docChild"/); assert.match(after, /重建的新正文/); assert.doesNotMatch(after, /子内容/); }
  });
}

test('replacement is restricted to the original folder and rejects duplicate titles', async (t) => {
  const { fake, run, service } = await setup(t);
  fake.nodes.push({ ...fake.nodes[1], node_token: 'folder', obj_token: 'docFolder', title: '其他目录', has_child: true });
  fake.set('docFolder', '目录');
  fake.nodes.push({ ...fake.nodes[1], node_token: 'other', obj_token: 'docOther', parent_node_token: 'folder' });
  fake.set('docOther', '子内容');
  await run('import');
  const notePath = '飞书/技术提升/子页面.md';
  fake.nodes = fake.nodes.filter((node) => node.node_token !== 'child');
  fake.docs.delete('docChild');
  assert.match((await run('pull', notePath)).results[0].message, /未找到原路径/);
  assert.equal((await service.status(notePath)).entry.documentId, 'docChild');
  fake.nodes.push({ ...fake.nodes.find((node) => node.node_token === 'other'), node_token: 'new1', obj_token: 'docNew1', parent_node_token: 'root' });
  fake.nodes.push({ ...fake.nodes.at(-1), node_token: 'new2', obj_token: 'docNew2' });
  fake.set('docNew1', '子内容'); fake.set('docNew2', '子内容');
  for (const action of ['pull', 'push', 'import']) {
    assert.match(JSON.stringify((await run(action, notePath)).results), /多个同名/);
    assert.equal((await service.status(notePath)).entry.documentId, 'docChild');
  }
  assert.equal(fake.mutations.length, 0);
});

test('recreating a parent and child keeps nested local paths', async (t) => {
  const { notes, fake, run, service } = await setup(t);
  fake.nodes[1].has_child = true;
  fake.nodes.push({ ...fake.nodes[1], node_token: 'nested', obj_token: 'docNested', title: '孙页面', parent_node_token: 'child', has_child: false });
  fake.set('docNested', '嵌套内容');
  await run('import');
  const parent = fake.recreate('child', '子内容');
  const child = fake.recreate('nested', '嵌套内容'); child.parent_node_token = parent.node_token;
  assert.equal((await run('import')).state, 'done');
  const notePath = '飞书/技术提升/子页面/孙页面.md';
  assert.equal((await service.status(notePath)).entry.documentId, child.obj_token);
  assert.match(await readFile(path.join(notes, notePath), 'utf8'), /嵌套内容/);
  assert.deepEqual((await readdir(path.join(notes, '飞书/技术提升'))).sort(), ['子页面', '子页面.md']);
});

test('permission and network errors do not trigger replacement lookup', async (t) => {
  const { fake, run, service } = await setup(t);
  await run('import');
  fake.list = async () => { assert.fail('must not search for replacements'); };
  for (const error of [Object.assign(new Error('没有权限'), { feishuCode: 1770032 }), new Error('网络超时')]) {
    fake.snapshot = async () => { throw error; };
    for (const action of ['pull', 'push']) {
      assert.equal((await run(action, '飞书/技术提升/子页面.md')).results[0].message, error.message);
      assert.equal((await service.status('飞书/技术提升/子页面.md')).entry.documentId, 'docChild');
    }
  }
});

test('a changed document ID behind the same wiki token is rebound before pulling', async (t) => {
  const { fake, run, service } = await setup(t);
  await run('import');
  fake.nodes[1].obj_token = 'docReplacement';
  fake.docs.delete('docChild'); fake.set('docReplacement', '子内容');
  assert.equal((await run('pull', '飞书/技术提升/子页面.md')).state, 'done');
  assert.equal((await service.status('飞书/技术提升/子页面.md')).entry.documentId, 'docReplacement');
});

test('recreation never clears protection for an interrupted push', async (t) => {
  const { notes, fake, run, service } = await setup(t);
  await run('import');
  const notePath = '飞书/技术提升/子页面.md';
  await writeFile(path.join(notes, notePath), '本地修改');
  fake.failInsert = true;
  await run('push', notePath);
  const pending = (await service.status(notePath)).entry.pending;
  fake.recreate('child', '子内容');
  const mutations = fake.mutations.length;
  for (const action of ['pull', 'push', 'import']) {
    assert.match(JSON.stringify((await run(action, notePath)).results), /中断/);
    const entry = (await service.status(notePath)).entry;
    assert.equal(entry.documentId, 'docChild'); assert.equal(entry.pending, pending);
  }
  assert.equal(fake.mutations.length, mutations);
});

test('discovery lists only unassociated supported pages without downloading bodies', async (t) => {
  const { notes, fake, run } = await setup(t);
  fake.nodes.push({ ...fake.nodes[1], node_token: 'sheet', obj_type: 'sheet' });
  fake.nodes.push({ ...fake.nodes[1], node_token: 'shortcut', node_type: 'shortcut' });
  const snapshot = fake.snapshot.bind(fake);
  fake.snapshot = () => assert.fail('discovery must not download document content');
  const first = await run('discover');
  assert.equal(first.state, 'done');
  assert.deepEqual(first.candidates.map((item) => [item.nodeToken, item.path]), [['root', '技术提升'], ['child', '技术提升 / 子页面']]);
  assert.equal(fake.mutations.length, 0);
  assert.deepEqual(await readdir(notes), ['.zhixu-feishu']);
  fake.snapshot = snapshot;
  await run('import-selected', undefined, false, ['child']);
  assert.deepEqual((await run('discover')).candidates.map((item) => item.nodeToken), ['root']);
  await run('import-selected', undefined, false, ['root']);
  assert.deepEqual((await run('discover')).candidates, []);
});

test('selective imports preserve ancestor directories across batches and later full imports', async (t) => {
  const { notes, fake, run, service } = await setup(t);
  fake.nodes[1].has_child = true;
  for (const [token, title] of [['nested1', '第一页'], ['nested2', '第二页']]) {
    fake.nodes.push({ ...fake.nodes[1], node_token: token, obj_token: token, title, parent_node_token: 'child', has_child: false });
    fake.set(token, title + '正文');
  }
  const reads = [], snapshot = fake.snapshot.bind(fake);
  fake.snapshot = (id) => { reads.push(id); return snapshot(id); };
  assert.equal((await run('import-selected', undefined, false, ['nested1'])).state, 'done');
  assert.deepEqual(reads, ['nested1']);
  await assert.rejects(readFile(path.join(notes, '飞书/技术提升.md')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(notes, '飞书/技术提升/子页面.md')), { code: 'ENOENT' });
  assert.equal((await run('import-selected', undefined, false, ['nested2'])).state, 'done');
  assert.equal((await service.status('飞书/技术提升/子页面/第二页.md')).entry.nodeToken, 'nested2');
  assert.equal((await run('import')).state, 'done');
  assert.deepEqual(await readdir(path.join(notes, '飞书')), ['技术提升', '技术提升.md']);
  assert.deepEqual(await readdir(path.join(notes, '飞书/技术提升/子页面')), ['第一页.md', '第二页.md']);
  assert.deepEqual((await run('discover')).candidates, []);
});

test('selection is revalidated against the current tree before any content is written', async (t) => {
  const { notes, fake, run, service } = await setup(t);
  await run('discover');
  for (const selection of [[], ['../outside'], 'child']) await assert.rejects(service.start('import-selected', undefined, false, selection), /勾选/);
  assert.equal(service.busy, false);
  assert.equal((await run('import-selected', undefined, false, ['child', 'outside'])).state, 'error');
  assert.deepEqual(await readdir(notes), ['.zhixu-feishu']);
  fake.nodes = fake.nodes.filter((node) => node.node_token !== 'child');
  assert.match((await run('import-selected', undefined, false, ['child'])).results[0].message, /刷新待拉取列表/);
  assert.equal(fake.mutations.length, 0);
});

test('repeated selections never overwrite an already imported or locally edited note', async (t) => {
  const { notes, fake, run } = await setup(t);
  await run('import-selected', undefined, false, ['child', 'child']);
  const file = path.join(notes, '飞书/技术提升/子页面.md');
  await writeFile(file, '本地修改需要保留');
  fake.set('docChild', '远程更新');
  const result = await run('import-selected', undefined, false, ['child']);
  assert.equal(result.state, 'done');
  assert.equal(result.results[0].status, 'skipped');
  assert.equal(await readFile(file, 'utf8'), '本地修改需要保留');
  fake.recreate('child', '重建正文');
  assert.deepEqual((await run('discover')).candidates.map((item) => item.nodeToken), ['root']);
});

test('selected imports avoid local filename collisions and distinguish same-title siblings', async (t) => {
  const { notes, fake, run, service } = await setup(t);
  await run('import-selected', undefined, false, ['root']);
  await mkdir(path.join(notes, '飞书/技术提升'), { recursive: true });
  await writeFile(path.join(notes, '飞书/技术提升/子页面.md'), '已有本地内容');
  fake.nodes.push({ ...fake.nodes[1], node_token: 'other', obj_token: 'docOther' });
  fake.set('docOther', '同名另一篇');
  assert.equal((await run('discover')).candidates.length, 2);
  assert.equal((await run('import-selected', undefined, false, ['other'])).state, 'done');
  assert.equal((await service.status('飞书/技术提升/子页面（2）.md')).entry.nodeToken, 'other');
  assert.deepEqual((await run('discover')).candidates.map((item) => item.nodeToken), ['child']);
  assert.equal((await run('import-selected', undefined, false, ['child'])).state, 'done');
  assert.equal((await service.status('飞书/技术提升/子页面（3）.md')).entry.nodeToken, 'child');
  assert.equal(await readFile(path.join(notes, '飞书/技术提升/子页面.md'), 'utf8'), '已有本地内容');
});

test('one failed selected download does not prevent other selected notes from importing', async (t) => {
  const { notes, fake, run, service } = await setup(t);
  const snapshot = fake.snapshot.bind(fake);
  fake.snapshot = (id) => { if (id === 'docRoot') throw new Error('正文读取失败'); return snapshot(id); };
  const result = await run('import-selected', undefined, false, ['root', 'child']);
  assert.equal(result.state, 'attention');
  assert.ok(result.results.some((item) => item.status === 'error'));
  assert.equal((await service.status('飞书/技术提升/子页面.md')).entry.nodeToken, 'child');
  fake.snapshot = snapshot;
  assert.equal((await run('import-selected', undefined, false, ['root'])).state, 'done');
  assert.deepEqual(await readdir(path.join(notes, '飞书')), ['技术提升', '技术提升.md']);
});

test('Markdown image parsing handles references and spaces while excluding code examples', async () => {
  const body = '![图](<笔记.assets/图 1.png>)\n\n![引用][pic]\n\n[pic]: 笔记.assets/图2.png\n\n`![code](secret.png)`\n\n```md\n![code](secret2.png)\n```';
  assert.deepEqual(markdownImages(body).map((image) => image.source), ['笔记.assets/图 1.png', '笔记.assets/图2.png']);
  const prepared = await prepareImageMarkdown(body, async () => tinyPng);
  assert.equal(prepared.assets.size, 2);
  assert.match(prepared.markdown, /zhixu-image-0.png/);
  assert.match(prepared.markdown, /`!\[code\]\(secret.png\)`/);
  assert.equal(markdownImages('<img src="x.png">')[0].source, 'x.png');
  assert.throws(() => imageType(Buffer.from('<html>登录</html>')), /不是图片/);
});

test('media client downloads bytes with rate-limit retry and uploads multipart to the image block', async () => {
  let attempts = 0;
  const client = new FeishuClient({ appId: 'cli_test', appSecret: 'secret' }, async (url, options) => {
    if (url.includes('/auth/')) return Response.json({ code: 0, tenant_access_token: 'token', expire: 7200 });
    assert.equal(options.headers.Authorization, 'Bearer token');
    assert.equal(options.redirect, 'error');
    if (url.includes('/download?')) {
      if (++attempts === 1) return Response.json({ code: 99991400 }, { status: 429 });
      return new Response(tinyPng, { headers: { 'content-type': 'application/octet-stream' } });
    }
    assert.match(url, /medias\/upload_all/);
    assert.equal(options.headers['Content-Type'], undefined);
    assert.equal(options.body.get('parent_type'), 'docx_image');
    assert.equal(options.body.get('parent_node'), 'actualImageBlock');
    assert.equal(options.body.get('size'), String(tinyPng.length));
    assert.deepEqual(Buffer.from(await options.body.get('file').arrayBuffer()), tinyPng);
    return Response.json({ code: 0, data: { file_token: 'newMedia' } });
  }, async () => {});
  assert.deepEqual((await client.downloadImage('media')).bytes, tinyPng);
  assert.equal(attempts, 2);
  assert.equal(await client.uploadImage('actualImageBlock', { bytes: tinyPng, name: '图.png', mime: 'image/png' }), 'newMedia');
  await assert.rejects(imageResponse(new Response(tinyPng, { headers: { 'content-length': String(MAX_IMAGE_BYTES + 1) } })), /超过/);
  const denied = new FeishuClient({ appId: 'cli_test', appSecret: 'secret' }, async (url) => url.includes('/auth/')
    ? Response.json({ code: 0, tenant_access_token: 'token', expire: 7200 }) : Response.json({ code: 1061004, msg: 'secret' }, { status: 403 }), async () => {});
  await assert.rejects(denied.downloadImage('media'), (error) => /权限/.test(error.message) && !error.message.includes('secret'));
});

test('HTML images convert automatically with entities and wrappers, preserving code and comments', async () => {
  const body = '<div>图示<img ALT="左 &amp; 右 > [图]" src="图&amp;片.png" width="300" /></div>\n\n<img src=second.png>\n\n<!-- <img src="comment.png"> -->\n\n`<img src="inline.png">`\n\n```html\n<img src="fence.png">\n```\n\n<pre><img src="example.png"></pre>';
  const sources = [];
  const prepared = await prepareImageMarkdown(body, async (source) => { sources.push(source); return tinyPng; });
  assert.deepEqual(sources, ['图&片.png', 'second.png']);
  assert.equal(prepared.convertedHtmlImages, 2);
  assert.deepEqual(markdownImages(prepared.markdown).map((item) => item.source), ['zhixu-image-0.png', 'zhixu-image-1.png']);
  assert.match(prepared.markdown, /左 & 右 > \\\[图\\\]/);
  assert.match(prepared.markdown, /<!-- <img src="comment.png"> -->/);
  assert.match(prepared.markdown, /`<img src="inline.png">`/);
  assert.match(prepared.markdown, /<pre><img src="example.png"><\/pre>/);
  assert.throws(() => markdownImages('<img alt="missing">'), /缺少 src/);
});

test('pushing resized HTML images preserves local layout and verifies remote image content', async (t) => {
  const { notes, run, fake, service } = await setup(t);
  await mkdir(path.join(notes, '图片.assets'));
  await writeFile(path.join(notes, '图片.assets/图.png'), tinyPng);
  const raw = '---\ntitle: 图片\n---\n\n正文\n\n<img width="870" height="757" class="image-align-center" src="./图片.assets/图.png" alt="图片" />';
  await writeFile(path.join(notes, '图片.md'), raw);
  const result = await run('push', '图片.md');
  assert.equal(result.state, 'done');
  assert.match(result.results[0].message, /自动转换 1 张 HTML 图片/);
  assert.equal(await readFile(path.join(notes, '图片.md'), 'utf8'), raw);
  assert.equal(fake.uploads.length, 1);
  const entry = (await service.status('图片.md')).entry;
  assert.ok(fake.docs.get(entry.documentId).blocks.some((block) => block.image?.token === fake.uploads[0].token));
  assert.equal((await run('push', '图片.md')).results[0].status, 'unchanged');
});

test('folder pushes recurse, deduplicate selections, preserve hierarchy and skip unchanged notes', async (t) => {
  const { notes, run, fake, service } = await setup(t);
  for (const directory of ['选中/子目录', '另一组', '选中/附件.assets', '选中/.private']) await mkdir(path.join(notes, directory), { recursive: true });
  for (const file of ['选中/一.md', '选中/子目录/二.md', '另一组/三.md', '选中/附件.assets/隐藏.md', '选中/.private/隐藏.md', '根目录.md']) await writeFile(path.join(notes, file), `# ${file}`);
  const result = await run('push-folders', undefined, false, undefined, ['选中', '选中/子目录', '另一组', '选中']);
  assert.equal(result.state, 'done');
  assert.equal(result.total, 3);
  assert.equal(result.completed, 3);
  assert.deepEqual(result.results.map((item) => item.path).sort(), ['另一组/三.md', '选中/一.md', '选中/子目录/二.md'].sort());
  const parent = fake.nodes.find((node) => node.title === '选中');
  const child = fake.nodes.find((node) => node.title === '子目录');
  assert.equal(parent.parent_node_token, 'root');
  assert.equal(child.parent_node_token, parent.node_token);
  assert.equal(fake.nodes.find((node) => node.title === '二').parent_node_token, child.node_token);
  assert.deepEqual((await service.status('选中/子目录/二.md')).entry.wikiPath, ['选中', '子目录', '二']);
  const count = fake.mutations.length;
  assert.ok((await run('push-folders', undefined, false, undefined, ['选中', '另一组'])).results.every((item) => item.status === 'unchanged'));
  assert.equal(fake.mutations.length, count);
  const all = await run('push-folders', undefined, false, undefined, ['']);
  assert.equal(all.total, 4);
  assert.ok(all.results.some((item) => item.path === '根目录.md' && item.status === 'ok'));
});

test('folder pushes reuse imported parents and continue after a per-note conflict or bad image', async (t) => {
  const { notes, run, fake, service } = await setup(t);
  await run('import');
  await writeFile(path.join(notes, '飞书/技术提升/新笔记.md'), '新笔记正文');
  await writeFile(path.join(notes, '飞书/技术提升/坏图片.md'), '<img src="missing.png">');
  fake.set('docChild', '远端已修改');
  await writeFile(path.join(notes, '飞书/技术提升/子页面.md'), '本地已修改');
  const result = await run('push-folders', undefined, false, undefined, ['飞书/技术提升']);
  assert.equal(result.state, 'attention');
  assert.equal(result.total, 3);
  assert.equal(result.results.filter((item) => item.status === 'error').length, 2);
  assert.equal(fake.nodes.find((node) => node.title === '新笔记').parent_node_token, 'root');
  assert.equal((await service.status('飞书/技术提升/新笔记.md')).entry.wikiPath[0], '新笔记');
  assert.match((await fake.snapshot('docChild')).markdown, /远端已修改/);
});

test('folder selection validates all paths before any remote write', async (t) => {
  const { notes, run, service, fake } = await setup(t);
  await mkdir(path.join(notes, 'valid'));
  await writeFile(path.join(notes, 'valid/a.md'), 'A');
  for (const folders of [[], ['../'], ['/outside'], ['.zhixu-feishu'], ['valid\\child'], ['valid/附件.assets']]) {
    await assert.rejects(service.start('push-folders', undefined, false, [], folders), /文件夹/);
  }
  assert.equal((await run('push-folders', undefined, false, [], ['valid', 'missing'])).state, 'error');
  assert.equal(fake.mutations.length, 0);
});

test('ambiguous folder creation is journaled and never duplicated on retry', async (t) => {
  const { notes, run, fake } = await setup(t);
  await mkdir(path.join(notes, '新目录'));
  await writeFile(path.join(notes, '新目录/A.md'), 'A');
  await writeFile(path.join(notes, '新目录/B.md'), 'B');
  fake.failCreate = true;
  const result = await run('push-folders', undefined, false, [], ['新目录']);
  assert.equal(result.state, 'attention');
  assert.equal(fake.mutations.filter((item) => item.endpoint.endsWith('/nodes')).length, 1);
  const saved = JSON.parse(await readFile(path.join(notes, '.zhixu-feishu/state.json'), 'utf8'));
  assert.ok(saved.directories[0].pending);
  fake.failCreate = false;
  assert.equal((await run('push-folders', undefined, false, [], ['新目录'])).state, 'attention');
  assert.equal(fake.mutations.filter((item) => item.endpoint.endsWith('/nodes')).length, 1);
});

test('single-note pushes create and reuse every parent document', async (t) => {
  const { notes, fake, run } = await setup(t);
  await mkdir(path.join(notes, '算法/回溯'), { recursive: true });
  await writeFile(path.join(notes, '算法/回溯/组合.md'), '组合正文');
  assert.equal((await run('push', '算法/回溯/组合.md')).state, 'done');
  const algorithm = fake.nodes.find((node) => node.title === '算法');
  const backtracking = fake.nodes.find((node) => node.title === '回溯');
  const note = fake.nodes.find((node) => node.title === '组合');
  assert.equal(algorithm.parent_node_token, 'root');
  assert.equal(backtracking.parent_node_token, algorithm.node_token);
  assert.equal(note.parent_node_token, backtracking.node_token);
  const count = fake.mutations.length;
  assert.equal((await run('push', '算法/回溯/组合.md')).results[0].status, 'unchanged');
  assert.equal(fake.mutations.length, count);
});

test('pushing an unchanged moved note repairs hierarchy and stale directory aliases without rewriting text', async (t) => {
  const { notes, fake, run, service } = await setup(t);
  await run('import');
  const old = '飞书/技术提升/子页面.md', next = '飞书/技术提升/算法/子页面.md';
  await mkdir(path.join(notes, '飞书/技术提升/算法'));
  await rename(path.join(notes, old), path.join(notes, next));
  const statePath = path.join(notes, '.zhixu-feishu/state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.entries.find((entry) => entry.path === old).path = next;
  state.directories ||= [];
  state.directories.push({ scope: state.entries[0].scope, nodeToken: 'child', path: old.replace(/\.md$/, '') });
  await writeFile(statePath, JSON.stringify(state));
  const original = structuredClone(fake.docs.get('docChild'));
  fake.failMoveAfterApply = true;
  const result = await run('push', next);
  assert.equal(result.state, 'done');
  assert.match(result.results[0].message, /正文未变化.*父文档/);
  assert.deepEqual(fake.docs.get('docChild'), original);
  assert.equal(fake.nodes.find((node) => node.node_token === 'child').parent_node_token, fake.nodes.find((node) => node.title === '算法').node_token);
  assert.deepEqual((await service.status(next)).entry.wikiPath, ['算法', '子页面']);
  const saved = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(saved.directories.find((item) => item.nodeToken === 'child').path, next.replace(/\.md$/, ''));
  assert.equal(saved.entries.find((item) => item.path === next).pendingMove, undefined);
  const count = fake.mutations.length;
  assert.equal((await run('push', next)).results[0].status, 'unchanged');
  assert.equal(fake.mutations.length, count);
});

test('existing same-title parent documents are reused within the correct parent only', async (t) => {
  const { notes, fake, run } = await setup(t);
  fake.nodes[1].title = '算法';
  const original = structuredClone(fake.docs.get('docChild'));
  await mkdir(path.join(notes, '算法'));
  await writeFile(path.join(notes, '算法/新笔记.md'), '新内容');
  assert.equal((await run('push', '算法/新笔记.md')).state, 'done');
  assert.equal(fake.nodes.filter((node) => node.title === '算法').length, 1);
  assert.equal(fake.nodes.find((node) => node.title === '新笔记').parent_node_token, 'child');
  assert.deepEqual(fake.docs.get('docChild'), original);
});

test('empty folders create parent documents and a later same-name note fills the generated container', async (t) => {
  const { notes, fake, run, service } = await setup(t);
  await mkdir(path.join(notes, '资料/空目录'), { recursive: true });
  const first = await run('push-folders', undefined, false, [], ['资料']);
  assert.equal(first.state, 'done');
  const container = fake.nodes.find((node) => node.title === '资料');
  assert.equal(fake.nodes.find((node) => node.title === '空目录').parent_node_token, container.node_token);
  await writeFile(path.join(notes, '资料.md'), '目录介绍');
  assert.equal((await run('push', '资料.md')).state, 'done');
  assert.equal((await service.status('资料.md')).entry.nodeToken, container.node_token);
  assert.equal(fake.nodes.filter((node) => node.title === '资料').length, 1);
  assert.match((await fake.snapshot(container.obj_token)).markdown, /目录介绍/);
});

function addImage(fake, documentId = 'docChild', token = 'media') {
  const doc = fake.docs.get(documentId), id = documentId + 'image';
  doc.blocks[0].children.push(id);
  doc.blocks.push({ block_id: id, block_type: 27, image: { token } });
  fake.media.set(token, tinyPng);
}

test('import downloads up to three images concurrently, deduplicates tokens and serializes identical files', async (t) => {
  const { notes, fake, run } = await setup(t);
  const doc = fake.docs.get('docChild');
  for (const [index, token] of ['a', 'b', 'c', 'd', 'e', 'a'].entries()) {
    const id = `picture${index}`;
    doc.blocks[0].children.push(id);
    doc.blocks.push({ block_id: id, block_type: 27, image: { token } });
    fake.media.set(token, tinyPng);
  }
  let active = 0, peak = 0;
  const download = fake.downloadImage.bind(fake);
  fake.downloadImage = async (token) => {
    active++; peak = Math.max(active, peak);
    try { await delay(15); return await download(token); }
    finally { active--; }
  };
  const result = await run('import');
  assert.equal(result.state, 'done', JSON.stringify(result.results));
  assert.equal(peak, 3); assert.equal(active, 0);
  assert.equal(fake.downloads.length, 5);
  const raw = await readFile(path.join(notes, '飞书/技术提升/子页面.md'), 'utf8');
  assert.equal(markdownImages(raw).length, 6);
  const assets = await readdir(path.join(notes, '飞书/技术提升/子页面.assets'));
  assert.equal(assets.length, 1);
  assert.deepEqual(await readFile(path.join(notes, '飞书/技术提升/子页面.assets', assets[0])), tinyPng);
});

test('failed parallel downloads drain before task completion and preserve existing note and baseline', async (t) => {
  const { notes, fake, run, service } = await setup(t);
  await run('import');
  const notePath = '飞书/技术提升/子页面.md';
  const before = await readFile(path.join(notes, notePath), 'utf8');
  const hash = (await service.status(notePath)).entry.localHash;
  fake.set('docChild', '更新后的正文');
  const doc = fake.docs.get('docChild');
  for (const token of ['fail', 'slow1', 'slow2', 'notStarted']) {
    doc.blocks[0].children.push(token);
    doc.blocks.push({ block_id: token, block_type: 27, image: { token } });
  }
  let active = 0;
  const started = [];
  fake.downloadImage = async (token) => {
    started.push(token); active++;
    try {
      await delay(token === 'fail' ? 5 : 30);
      if (token === 'fail') throw new Error('download failed');
      return { bytes: tinyPng };
    } finally { active--; }
  };
  assert.equal((await run('pull', notePath)).state, 'error');
  assert.equal(active, 0);
  assert.deepEqual(started, ['fail', 'slow1', 'slow2']);
  assert.equal(await readFile(path.join(notes, notePath), 'utf8'), before);
  assert.equal((await service.status(notePath)).entry.localHash, hash);
});

test('pull stores real image files, preserves them on refresh, and uploads them on push', async (t) => {
  const { notes, fake, run, service } = await setup(t);
  addImage(fake);
  const notePath = '飞书/技术提升/子页面.md';
  assert.equal((await run('import')).state, 'done');
  const raw = await readFile(path.join(notes, notePath), 'utf8');
  const images = markdownImages(raw);
  assert.equal(images.length, 1); assert.match(images[0].source, /^子页面.assets\/feishu-.*\.png$/);
  assert.equal(images[0].source, `子页面.assets/feishu-${bytesHash(tinyPng)}.png`);
  const imagePath = path.join(notes, path.dirname(notePath), images[0].source);
  assert.deepEqual(await readFile(imagePath), tinyPng);
  assert.equal((await service.status(notePath)).entry.warnings.length, 0);
  assert.equal((await run('pull', notePath)).results[0].status, 'unchanged');
  await writeFile(path.join(notes, notePath), raw + '\n新增文字');
  assert.equal((await run('push', notePath)).state, 'done');
  assert.equal(fake.uploads.length, 1); assert.deepEqual(fake.uploads[0].bytes, tinyPng);
  const remote = await fake.snapshot('docChild');
  assert.equal(remote.blocks.filter((block) => block.block_type === 27).length, 1);
  assert.equal(remote.blocks.find((block) => block.block_type === 27).image.token, 'uploaded0');
  assert.equal((await run('push', notePath)).results[0].status, 'unchanged');
});

test('a local image-only edit is pushed even when Markdown did not change', async (t) => {
  const { notes, fake, run } = await setup(t);
  await mkdir(path.join(notes, '图片.assets'));
  await writeFile(path.join(notes, '图片.assets/a.png'), tinyPng);
  await writeFile(path.join(notes, '图片.md'), '![图片](图片.assets/a.png)');
  assert.equal((await run('push', '图片.md')).state, 'done');
  const changed = Buffer.concat([tinyPng, Buffer.from('metadata')]);
  await writeFile(path.join(notes, '图片.assets/a.png'), changed);
  assert.equal((await run('push', '图片.md')).state, 'done');
  assert.deepEqual(fake.uploads.at(-1).bytes, changed);
});

test('image upload failure preserves old remote content and blocks repeat writes', async (t) => {
  const { notes, fake, run, service } = await setup(t);
  await run('import');
  const notePath = '飞书/技术提升/子页面.md';
  await mkdir(path.join(notes, '图片.assets'));
  await writeFile(path.join(notes, '图片.assets/a.png'), tinyPng);
  await writeFile(path.join(notes, notePath), '新正文\n\n![图片](../../图片.assets/a.png)');
  fake.failUpload = true;
  assert.equal((await run('push', notePath)).state, 'error');
  assert.ok((await service.status(notePath)).entry.pending);
  assert.ok(fake.docs.get('docChild').blocks.some((block) => block.text?.elements[0].text_run.content === '子内容'));
  assert.equal(fake.mutations.some((item) => item.method === 'DELETE'), false);
  const writes = fake.mutations.length;
  await run('push', notePath); assert.equal(fake.mutations.length, writes);
});

test('image download failure preserves existing local text and successful sync baseline', async (t) => {
  const { notes, fake, run, service } = await setup(t);
  await run('import');
  const notePath = '飞书/技术提升/子页面.md', before = await readFile(path.join(notes, notePath), 'utf8');
  const entry = (await service.status(notePath)).entry;
  fake.set('docChild', '带图新正文'); addImage(fake); fake.media.clear();
  assert.equal((await run('pull', notePath)).state, 'error');
  assert.equal(await readFile(path.join(notes, notePath), 'utf8'), before);
  assert.equal((await service.status(notePath)).entry.localHash, entry.localHash);
});

test('image paths cannot escape the vault, follow symlinks, or upload private backups', async (t) => {
  const { notes, folder, fake, run } = await setup(t);
  await writeFile(path.join(folder, 'outside.png'), tinyPng);
  await symlink(path.join(folder, 'outside.png'), path.join(notes, 'link.png'));
  for (const source of ['../outside.png', '%2e%2e/outside.png', 'link.png', '.zhixu-feishu/backups/a.png', 'http://127.0.0.1/private.png']) {
    await writeFile(path.join(notes, '测试.md'), `![图片](${source})`);
    assert.equal((await run('push', '测试.md')).state, 'error');
  }
  assert.equal(fake.mutations.length, 0);
});

function addReference(fake, documentId = 'docChild') {
  fake.set('sourceDoc', 'unused');
  fake.docs.get('sourceDoc').blocks = [
    { block_id: 'sourceDoc', block_type: 1, children: ['sourceBlock'] },
    { block_id: 'sourceBlock', block_type: 48, source_synced: {}, children: ['sharedText', 'sharedImage'] },
    textBlock('sharedText', '同步块里的正文'),
    { block_id: 'sharedImage', block_type: 27, image: { token: 'sharedMedia' } },
  ];
  fake.media.set('sharedMedia', tinyPng);
  const doc = fake.docs.get(documentId);
  doc.blocks[0].children.push('reference');
  doc.blocks.push({ block_id: 'reference', block_type: 49, reference_synced: { source_document_id: 'sourceDoc', source_block_id: 'sourceBlock' } });
}

test('referenced sync blocks expand text and images, and refresh when only the source changes', async (t) => {
  const { notes, fake, run, service } = await setup(t);
  addReference(fake);
  const notePath = '飞书/技术提升/子页面.md';
  assert.equal((await run('import')).state, 'done');
  let raw = await readFile(path.join(notes, notePath), 'utf8');
  assert.match(raw, /同步块里的正文/); assert.match(raw, /子页面.assets/);
  assert.doesNotMatch(raw, /> 同步块|查看源文档/);
  assert.equal(fake.docs.get('docChild').revision, 1);
  fake.docs.get('sourceDoc').blocks.find((block) => block.block_id === 'sharedText').text.elements[0].text_run.content = '源块更新后的正文';
  fake.docs.get('sourceDoc').revision++;
  assert.equal((await run('pull', notePath)).state, 'done');
  raw = await readFile(path.join(notes, notePath), 'utf8');
  assert.match(raw, /源块更新后的正文/); assert.doesNotMatch(raw, /同步块里的正文/);
  assert.equal((await service.status(notePath)).entry.revision, 1);
  await writeFile(path.join(notes, notePath), raw + '\n本地修改');
  assert.equal((await run('push', notePath)).state, 'error');
  assert.equal(fake.mutations.length, 0);
  assert.equal((await run('push', notePath, true)).state, 'done');
  assert.equal(fake.uploads.length, 1);
});

test('source changes conflict with local changes even when the containing document revision is unchanged', async (t) => {
  const { notes, fake, run } = await setup(t);
  addReference(fake); await run('import');
  const notePath = '飞书/技术提升/子页面.md', raw = await readFile(path.join(notes, notePath), 'utf8');
  await writeFile(path.join(notes, notePath), raw + '\n本地修改');
  fake.docs.get('sourceDoc').blocks.find((block) => block.block_id === 'sharedText').text.elements[0].text_run.content = '源块修改';
  const job = await run('pull', notePath);
  assert.equal(job.state, 'attention'); assert.equal(job.results[0].status, 'conflict');
  assert.equal(await readFile(path.join(notes, notePath), 'utf8'), raw + '\n本地修改');
});

test('explicit confirmation flattens references in the original document, preserving source and backup', async (t) => {
  const { notes, fake, run, service } = await setup(t);
  addReference(fake); await run('import');
  const notePath = '飞书/技术提升/子页面.md';
  const before = (await service.status(notePath)).entry;
  const source = structuredClone(fake.docs.get('sourceDoc'));
  const local = await readFile(path.join(notes, notePath), 'utf8') + '\n已编辑';
  await writeFile(path.join(notes, notePath), local);
  const blocked = await run('push', notePath);
  assert.equal(blocked.state, 'error');
  assert.match(blocked.results[0].message, /覆盖提醒中确认/);
  assert.equal((await run('push', notePath, false, [], [], 'true')).state, 'error');
  assert.equal(fake.mutations.length, 0);
  const done = await run('push', notePath, false, [], [], true);
  assert.equal(done.state, 'done');
  assert.match(done.results[0].message, /1 个同步引用块已转为普通内容/);
  const after = (await service.status(notePath)).entry;
  assert.equal(after.documentId, before.documentId);
  assert.equal(after.url, before.url);
  assert.equal(fake.nodes.length, 2);
  assert.deepEqual(fake.docs.get('sourceDoc'), source);
  assert.ok(!fake.docs.get('docChild').blocks.some((block) => block.reference_synced));
  assert.match((await fake.snapshot('docChild')).markdown, /已编辑/);
  assert.equal(fake.uploads.length, 1);
  assert.equal(await readFile(path.join(notes, notePath), 'utf8'), local);
  const backups = await readdir(path.join(notes, '.zhixu-feishu/backups'));
  const saved = (await Promise.all(backups.map((name) => readFile(path.join(notes, '.zhixu-feishu/backups', name), 'utf8').then(JSON.parse)))).find((item) => item.kind === 'push');
  assert.equal(saved.overwriteSyncedBlocks, true);
  assert.equal(saved.flattenedReferences, 1);
  assert.ok(saved.remote.blocks.some((block) => block.reference_synced));
  assert.equal(after.pending, undefined);
});

test('confirmed folder push supports reference conversion without bypassing other unsupported content', async (t) => {
  const { notes, fake, run } = await setup(t);
  addReference(fake); await run('import');
  const notePath = '飞书/技术提升/子页面.md';
  await writeFile(path.join(notes, notePath), await readFile(path.join(notes, notePath), 'utf8') + '\n修改');
  const result = await run('push-folders', undefined, false, [], ['飞书/技术提升'], true);
  assert.equal(result.state, 'done');
  assert.match(result.results[0].message, /同步引用块已转为普通内容/);

  addReference(fake);
  const snapshot = fake.snapshot.bind(fake);
  fake.snapshot = async (id) => {
    const value = await snapshot(id);
    if (id === 'docChild') value.warnings.push('包含评论或 Markdown 不支持的文字样式，禁止覆盖推送。');
    return value;
  };
  const stateFile = path.join(notes, '.zhixu-feishu/state.json');
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  const entry = state.entries.find((item) => item.path === notePath);
  entry.remoteHash = undefined; entry.revision = fake.docs.get('docChild').revision;
  await writeFile(stateFile, JSON.stringify(state));
  await writeFile(path.join(notes, notePath), await readFile(path.join(notes, notePath), 'utf8') + '\n再次修改');
  const mutations = fake.mutations.length;
  assert.equal((await run('push', notePath, false, [], [], true)).state, 'error');
  assert.equal(fake.mutations.length, mutations);
});

test('repeated sync references render independently and only fetch their source once per snapshot', async (t) => {
  const { fake } = await setup(t); addReference(fake);
  const doc = fake.docs.get('docChild');
  doc.blocks[0].children.push('reference2'); doc.blocks.push({ ...structuredClone(doc.blocks.at(-1)), block_id: 'reference2' });
  const original = structuredClone(doc.blocks), list = fake.list.bind(fake); let reads = 0;
  fake.list = (...args) => { reads++; return list(...args); };
  const result = await fake.snapshot('docChild');
  assert.equal(result.markdown.match(/同步块里的正文/g).length, 2); assert.equal(reads, 2);
  assert.deepEqual(doc.blocks, original); assert.deepEqual(result.blocks, original);
});

test('unavailable or cyclic sync sources show a readable reason and never overwrite an existing good copy', async (t) => {
  const { notes, fake, run } = await setup(t); addReference(fake);
  await run('import');
  const notePath = '飞书/技术提升/子页面.md', before = await readFile(path.join(notes, notePath), 'utf8');
  const list = fake.list.bind(fake);
  fake.list = () => { throw new Error('源文档没有阅读权限'); };
  const unavailable = await fake.snapshot('docChild');
  assert.equal(unavailable.incomplete, true); assert.match(unavailable.markdown, /源文档没有阅读权限/);
  assert.equal((await run('pull', notePath)).state, 'error');
  assert.equal(await readFile(path.join(notes, notePath), 'utf8'), before);
  fake.list = list;
  const source = fake.docs.get('sourceDoc'); source.blocks[1].children.push('cycle');
  source.blocks.push({ block_id: 'cycle', block_type: 49, reference_synced: { source_document_id: 'sourceDoc', source_block_id: 'sourceBlock' } });
  const cyclic = await fake.snapshot('docChild');
  assert.equal(cyclic.incomplete, true); assert.match(cyclic.markdown, /循环引用/);
});

test('old placeholder notes are upgraded without requiring a new remote revision', async (t) => {
  const { notes, fake, run, service } = await setup(t);
  await run('import');
  const notePath = '飞书/技术提升/子页面.md';
  addImage(fake); addReference(fake);
  const stateFile = path.join(notes, '.zhixu-feishu/state.json');
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  for (const entry of state.entries) { delete entry.renderVersion; delete entry.assetHash; }
  await writeFile(stateFile, JSON.stringify(state));
  assert.equal((await run('pull', notePath)).state, 'done');
  const raw = await readFile(path.join(notes, notePath), 'utf8');
  assert.match(raw, /同步块里的正文/); assert.equal(markdownImages(raw).length, 2);
  assert.equal((await service.status(notePath)).entry.renderVersion, 2);
  assert.equal((await service.status(notePath)).entry.revision, 1);
});

test('sync blocks remain readable without source document metadata permission', async (t) => {
  const { fake } = await setup(t); addReference(fake);
  fake.request = () => { throw Object.assign(new Error('源文档基本信息无权限'), { feishuCode: 1770032 }); };
  const result = await fake.snapshot('docChild');
  assert.equal(result.incomplete, false); assert.match(result.markdown, /同步块里的正文/);
  const list = fake.list.bind(fake); let reads = 0;
  fake.list = async (...args) => {
    const items = await list(...args);
    if (++reads === 2) items.find((block) => block.block_id === 'sharedText').text.elements[0].text_run.content = '同时编辑';
    return items;
  };
  const changing = await fake.snapshot('docChild');
  assert.equal(changing.incomplete, true); assert.match(changing.markdown, /正在编辑/);
});
