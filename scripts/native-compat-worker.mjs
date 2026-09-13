// Compatibility worker for the existing, tested Feishu transaction protocol
// and link-aware moves. No HTTP listener, polling, index or note-read hot path.
// Rust owns all admission, paths, workspace changes and the request lifecycle.
import { createInterface } from 'node:readline';
import { createFeishuSync } from './feishu-sync.mjs';
import { createLocalFiles } from './local-files.mjs';
import { projectRoot } from './local-config.mjs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { normalizeTags, updateNoteTags } from './note-tags.mjs';
import { atomicWrite } from './note-index.mjs';
let root = process.env.ZHIXU_NATIVE_VAULT;
let feishu = createFeishuSync({ projectRoot, notesRoot: root });
let files = createLocalFiles({ notesRoot: root });
process.stdin.on('end', () => process.exit(0));
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  try {
    const input = JSON.parse(line);
    let result;
    if (input.method === 'status') result = await feishu.status(input.path);
    else if (input.method === 'config') result = await feishu.saveConfig(input.payload);
    else if (input.method === 'start') { const p = input.payload; result = await feishu.start(p.action, p.path, p.copy === true, p.nodeTokens, p.folders, p.overwriteSyncedBlocks === true, p.pullConfirmationToken); }
    else if (input.method === 'files') { if (feishu.busy) throw new Error('飞书同步正在进行，请稍后操作。'); result = await files.execute(input.payload); }
    else if (input.method === 'tags') {
      if (feishu.busy) throw new Error('飞书同步正在进行，请稍后操作。');
      const file = path.join(root, input.payload.path); const raw = await readFile(file, 'utf8');
      const tags = normalizeTags(input.payload.tags); const next = updateNoteTags(raw, tags, (await stat(file)).mtime);
      await atomicWrite(file, next); result = { raw: next, tags };
    } else if (input.method === 'workspace') {
      if (feishu.busy || files.busy) throw new Error('同步正在进行，无法切换知识库。');
      root = input.path; feishu = createFeishuSync({ projectRoot, notesRoot: root }); files = createLocalFiles({ notesRoot: root }); result = { ok: true };
    } else throw new Error('未知兼容任务。');
    process.stdout.write(JSON.stringify({ ok: true, result }) + '\n');
  } catch (error) { process.stdout.write(JSON.stringify({ ok: false, error: error.message }) + '\n'); }
}
