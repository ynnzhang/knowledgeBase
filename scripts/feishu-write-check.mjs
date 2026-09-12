// Explicit, one-off live write test. Only modifies its own labelled test page.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { FeishuClient, parseWikiUrl } from './feishu-sync.mjs';
import { prepareConverted } from './feishu-markdown.mjs';
import { projectRoot, notesRoot } from './local-config.mjs';

const config = JSON.parse(await readFile(path.join(projectRoot, '.feishu-local.json'), 'utf8'));
const receipt = path.join(projectRoot, 'outputs', 'feishu-write-check.json');
await mkdir(path.dirname(receipt), { recursive: true });
let report;
try { report = JSON.parse(await readFile(receipt, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; report = { title: `知序写入测试 ${new Date().toISOString()}`, steps: [] }; }
const save = () => writeFile(receipt, JSON.stringify(report, null, 2), { mode: 0o600 });
const client = new FeishuClient(config, async (url, options) => {
  const response = await fetch(url, options);
  if (!url.includes('/auth/')) {
    const result = await response.clone().json();
    const step = { method: options.method, endpoint: new URL(url).pathname, status: response.status, code: result.code, logId: response.headers.get('x-tt-logid') };
    report.steps.push(step);
    console.log(JSON.stringify(step));
    await save();
  }
  return response;
});

try {
  const wiki = parseWikiUrl(config.wikiUrl);
  const root = await client.node(wiki.token);
  // Read-only audit of the user's failed push; do not modify the source note.
  const state = JSON.parse(await readFile(path.join(notesRoot, '.zhixu-feishu/state.json'), 'utf8'));
  for (const entry of state.entries.filter((entry) => entry.pending)) {
    const backup = JSON.parse(await readFile(path.join(notesRoot, entry.pending), 'utf8'));
    const remote = await client.snapshot(entry.documentId);
    console.log(JSON.stringify({ failedNote: entry.path, currentRevision: remote.revision, backupRevision: backup.remote?.revision, originalContentUnchanged: JSON.stringify(remote.blocks) === JSON.stringify(backup.remote?.blocks) }));
  }
  if (!report.node) {
    if (report.creationAttempted) throw new Error('之前已尝试创建测试文档，请先检查执行记录，避免重复创建。');
    report.creationAttempted = true;
    await save();
    report.node = (await client.request(`/wiki/v2/spaces/${root.space_id}/nodes`, { method: 'POST', body: { parent_node_token: root.node_token, obj_type: 'docx', node_type: 'origin', title: report.title } })).node;
    report.url = `${wiki.origin}/wiki/${report.node.node_token}`;
    await save();
    console.log(JSON.stringify({ testDocument: report.url }));
  }
  const id = report.node.obj_token;
  const endpoint = `/docx/v1/documents/${id}`;
  let snapshot = await client.snapshot(id);
  if (!report.inserted) {
    const payload = prepareConverted(await client.request('/docx/v1/documents/blocks/convert', { method: 'POST', body: { content_type: 'markdown', content: '# 写入测试\n\n这是一篇独立的同步测试文档，不包含原有笔记内容。' } }));
    report.insertToken ||= randomUUID();
    await save();
    report.inserted = await client.request(`${endpoint}/blocks/${id}/descendant`, { method: 'POST', query: { document_revision_id: String(snapshot.revision), client_token: report.insertToken }, body: payload });
    await save();
  }
  snapshot = await client.snapshot(id);
  report.verified = snapshot.markdown.includes('这是一篇独立的同步测试文档');
  report.revision = snapshot.revision;
  await save();
  console.log(JSON.stringify({ verified: report.verified, url: report.url, revision: report.revision }));
} catch (error) {
  report.error = error.message;
  await save();
  console.error(error.message);
  process.exitCode = 1;
}
