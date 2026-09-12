import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { assertProjectFiles, requiredProjectFiles } from './check-project.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), '知序 源码检查 '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'scripts'));
  await cp(path.join(root, 'scripts/start-local.mjs'), path.join(directory, 'scripts/start-local.mjs'));
  return directory;
}

test('current checkout contains every required runtime source', () => {
  assert.doesNotThrow(() => assertProjectFiles(root));
});

test('incomplete source copy reports all missing modules before importing config or installing', async (t) => {
  const directory = await fixture(t);
  await cp(path.join(root, 'scripts/check-project.mjs'), path.join(directory, 'scripts/check-project.mjs'));
  const result = spawnSync(process.execPath, [path.join(directory, 'scripts/start-local.mjs')], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /项目文件不完整/);
  assert.match(result.stderr, /scripts\/local-config\.mjs/);
  assert.match(result.stderr, /scripts\/feishu-sync\.mjs/);
  assert.doesNotMatch(result.stderr, /node:internal|ERR_MODULE_NOT_FOUND/);
});

test('missing checker itself still produces recovery guidance', async (t) => {
  const directory = await fixture(t);
  const result = spawnSync(process.execPath, [path.join(directory, 'scripts/start-local.mjs')], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /缺少 scripts\/check-project\.mjs/);
  assert.doesNotMatch(result.stderr, /node:internal/);
});

test('check-only works without npm dependencies and does not execute local configuration', async (t) => {
  const directory = await fixture(t);
  for (const file of requiredProjectFiles) {
    if (file === 'scripts/start-local.mjs') continue;
    const destination = path.join(directory, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.endsWith('.json') ? '{}' : 'throw new Error("must not execute");');
  }
  await cp(path.join(root, 'scripts/check-project.mjs'), path.join(directory, 'scripts/check-project.mjs'));
  const result = spawnSync(process.execPath, [path.join(directory, 'scripts/start-local.mjs'), '--check'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /项目源码完整/);
  await rm(path.join(directory, 'scripts/local-config.mjs'));
  await mkdir(path.join(directory, 'scripts/local-config.mjs'));
  assert.throws(() => assertProjectFiles(directory), /scripts\/local-config\.mjs/);
});
