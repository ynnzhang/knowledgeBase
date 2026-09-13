import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { createNoteScanner, atomicWrite } from './note-index.mjs';
const count = Number(process.argv[2] || 10000);
const fixture = await mkdtemp(path.join(tmpdir(), 'zhixu-legacy-bench-'));
const root = path.join(fixture, 'notes'); await mkdir(root);
try {
  const body = '# Performance note\n\nRust local knowledge base performance. 中文回溯算法学习。\n'.repeat(100);
  for (let i = 0; i < count; i++) await writeFile(path.join(root, `note-${String(i).padStart(5, '0')}.md`), `${body}\nunique-${String(i).padStart(5, '0')}`);
  const scan = createNoteScanner(); let t = performance.now(); const catalog = await scan(root); const cold = performance.now() - t;
  t = performance.now(); await scan(root); const unchanged = performance.now() - t;
  t = performance.now(); const text = JSON.stringify(catalog); const serialize = performance.now() - t;
  t = performance.now(); await atomicWrite(path.join(fixture, 'index.json'), text); const write = performance.now() - t;
  t = performance.now(); createHash('sha256').update(text).digest('hex'); const hash = performance.now() - t;
  await writeFile(path.join(root, 'note-00000.md'), '# Changed\nunique-saved');
  t = performance.now(); await scan(root); const edited = performance.now() - t;
  console.log(JSON.stringify({ notes: count, noteBytes: Buffer.byteLength(body), initialScanMs: cold, unchangedScanMs: unchanged, editScanMs: edited, catalogBytes: Buffer.byteLength(text), catalogSerializeMs: serialize, catalogWriteMs: write, catalogHashMs: hash }));
} finally { await rm(fixture, { recursive: true, force: true }); }
