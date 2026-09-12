import { setTimeout as delay } from 'node:timers/promises';
import { createFeishuSync } from './feishu-sync.mjs';
import { projectRoot, notesRoot } from './local-config.mjs';

const notePath = process.argv[2];
if (!notePath) throw new Error('请指定需要恢复的笔记相对路径。');
const sync = createFeishuSync({ projectRoot, notesRoot });
await sync.start('recover', notePath);
while (sync.busy) await delay(200);
const result = await sync.status(notePath);
console.log(JSON.stringify({ job: result.job, pending: Boolean(result.entry?.pending) }, null, 2));
if (result.job.state === 'error') process.exitCode = 1;
