// Push one explicitly named local note through the same guarded sync workflow as the UI.
import { createFeishuSync, FeishuClient } from './feishu-sync.mjs';
import { notesRoot, projectRoot } from './local-config.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const notePath = process.argv[2];
const inspect = process.argv[3] === '--inspect';
const copy = process.argv[3] === '--copy';
// Only use this flag after the user has explicitly approved flattening references.
const overwrite = process.argv[3] === '--confirmed-overwrite-synced';
if (!notePath || process.argv.length > 4 || (process.argv[3] && !inspect && !copy && !overwrite)) throw new Error('用法：node scripts/push-feishu-note.mjs "知识库内的笔记路径.md" [--inspect | --copy | --confirmed-overwrite-synced]');
const service = createFeishuSync({ projectRoot, notesRoot });
if (inspect) {
  const status = await service.status(notePath);
  const config = JSON.parse(await readFile(path.join(projectRoot, '.feishu-local.json'), 'utf8'));
  const client = new FeishuClient({ appId: status.appId, appSecret: process.env.FEISHU_APP_SECRET || config.appSecret });
  const snapshot = await client.snapshot(status.entry.documentId);
  console.log(JSON.stringify({ warnings: snapshot.warnings, blocks: snapshot.blocks.map(({ block_id, block_type, children, reference_synced, source_synced }) => ({ block_id, block_type, children, reference_synced, source_synced })) }, null, 2));
  process.exit(0);
}
await service.start('push', notePath, copy, [], [], overwrite);
let previous = '';
while (service.busy) {
  const { job } = await service.status(notePath);
  if (job.progress !== previous) { console.log(job.progress); previous = job.progress; }
  await delay(1000);
}
const { job, entry } = await service.status(notePath);
console.log(JSON.stringify({ state: job.state, results: job.results, revision: entry?.revision, pending: Boolean(entry?.pending) }, null, 2));
if (job.state !== 'done') process.exitCode = 1;
