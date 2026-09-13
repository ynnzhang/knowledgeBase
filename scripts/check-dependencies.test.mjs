import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { dependencyIssues, ensureDependencies } from './check-dependencies.mjs';

async function fixture(t, platform = process.platform) {
  const root = await mkdtemp(path.join(tmpdir(), '知序 依赖检查 '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (relative, value) => {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const dependencies = { 'micromark-extension-cjk-friendly': '^2.0.1' };
  const devDependencies = { vinext: '1.0.0-beta.3' };
  await write('package.json', { dependencies, devDependencies });
  await write('package-lock.json', { lockfileVersion: 3, packages: {
    '': { dependencies, devDependencies },
    'node_modules/micromark-extension-cjk-friendly': { version: '2.0.1' },
    'node_modules/vinext': { version: '1.0.0-beta.3' },
  } });
  await write('node_modules/vinext/package.json', { version: '1.0.0-beta.3' });
  await write(`node_modules/.bin/vinext${platform === 'win32' ? '.cmd' : ''}`, 'stub');
  await write('notes/保留.md', '用户笔记');
  return { root, write };
}

test('current checkout dependencies match the committed lockfile', async () => {
  assert.deepEqual(await dependencyIssues(fileURLToPath(new URL('../', import.meta.url))), []);
});

for (const platform of ['win32', 'darwin']) {
  test(`existing vinext does not hide a newly missing dependency (${platform})`, async (t) => {
    const { root, write } = await fixture(t, platform);
    assert.deepEqual(await dependencyIssues(root, platform), ['micromark-extension-cjk-friendly（未安装或安装不完整）']);
    let installs = 0, checks = 0;
    const options = { projectRoot: root, platform, log: () => {}, beforeInstall: async () => { checks++; }, runNpm: async (args) => {
      assert.deepEqual(args, ['ci']); installs++;
      await write('node_modules/micromark-extension-cjk-friendly/package.json', { version: '2.0.1' });
      return 0;
    } };
    await ensureDependencies(options);
    await ensureDependencies(options);
    assert.equal(installs, 1); assert.equal(checks, 1);
    assert.equal(await readFile(path.join(root, 'notes/保留.md'), 'utf8'), '用户笔记');
    await rm(path.join(root, 'node_modules/.bin', `vinext${platform === 'win32' ? '.cmd' : ''}`));
    assert.deepEqual(await dependencyIssues(root, platform), ['vinext（启动命令缺失）']);
  });
}

test('detects stale versions and damaged package manifests', async (t) => {
  const { root, write } = await fixture(t);
  await write('node_modules/micromark-extension-cjk-friendly/package.json', { version: '1.0.0' });
  assert.match((await dependencyIssues(root))[0], /版本需要更新/);
  await write('node_modules/micromark-extension-cjk-friendly/package.json', '{');
  assert.match((await dependencyIssues(root))[0], /安装不完整/);
});

test('installation failure or an incomplete successful install stops startup', async (t) => {
  const { root } = await fixture(t);
  for (const [code, message] of [[1, /依赖安装失败/], [0, /安装后仍缺少/]]) {
    await assert.rejects(ensureDependencies({ projectRoot: root, log: () => {}, runNpm: async () => code }), message);
  }
});

test('does not install while the existing server is running or after cancellation', async (t) => {
  const { root } = await fixture(t);
  const runNpm = async () => assert.fail('must not install');
  await assert.rejects(ensureDependencies({ projectRoot: root, log: () => {}, runNpm, beforeInstall: async () => { throw new Error('服务运行中'); } }), /服务运行中/);
  await ensureDependencies({ projectRoot: root, log: () => {}, runNpm, isStopping: () => true });
});

test('mismatched manifest and lockfile fails before invoking npm', async (t) => {
  const { root, write } = await fixture(t);
  await write('package.json', { dependencies: { 'micromark-extension-cjk-friendly': '^3.0.0' } });
  await assert.rejects(ensureDependencies({ projectRoot: root, runNpm: async () => assert.fail('must not install') }), /依赖清单与锁文件不一致/);
});
