import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { browserCommand, npmCommand, sameLocalPath, stopProcessTree } from './local-platform.mjs';

test('npm uses the Windows command interpreter and rejects shell input', () => {
  assert.deepEqual(npmCommand(['ci'], 'win32'), ['cmd.exe', ['/d', '/s', '/c', 'npm ci']]);
  assert.deepEqual(npmCommand(['run', 'dev:site'], 'win32')[1].at(-1), 'npm run dev:site');
  assert.deepEqual(npmCommand(['run', 'dev'], 'darwin'), ['npm', ['run', 'dev']]);
  assert.throws(() => npmCommand(['ci', '&', 'echo bad'], 'win32'));
});

test('browser launch encodes Windows arguments and supports macOS', () => {
  const url = "http://localhost:3000/中文?q=a&value='b'";
  const [command, args] = browserCommand(url, 'win32');
  assert.equal(command, 'powershell.exe');
  assert.equal(Buffer.from(args.at(-1), 'base64').toString('utf16le'), `Start-Process 'http://localhost:3000/中文?q=a&value=''b'''`);
  assert.deepEqual(browserCommand(url, 'darwin'), ['open', [url]]);
});

test('service identity handles Windows case, slash and trailing separator differences', () => {
  assert.ok(sameLocalPath('C:\\Users\\测试\\Note\\', 'c:/Users/测试/Note', 'win32'));
  assert.ok(sameLocalPath('\\\\server\\share\\Note', '//SERVER/share/Note/', 'win32'));
  assert.ok(!sameLocalPath('C:\\Note', 'D:\\Note', 'win32'));
  assert.ok(!sameLocalPath('/Users/test/Note', '/Users/test/note', 'darwin'));
  assert.ok(!sameLocalPath(undefined, '/Note', 'darwin'));
});

test('stopping Windows services targets only the launched process tree', () => {
  const emitter = new EventEmitter();
  let killed;
  stopProcessTree(123, 'win32', (command, args, options) => {
    assert.equal(command, 'taskkill.exe');
    assert.deepEqual(args, ['/pid', '123', '/t', '/f']);
    assert.equal(options.windowsHide, true);
    return emitter;
  }, (pid) => { killed = pid; });
  assert.equal(killed, undefined);
  emitter.emit('error', new Error('taskkill unavailable'));
  assert.equal(killed, 123);
});

test('npm launcher runs from a directory containing Chinese characters and spaces', async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), '知序 启动 '));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  // No package exists: npm must execute and fail normally, without installing anything.
  const [command, args] = npmCommand(['ci']);
  const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const [code] = await once(child, 'close');
  assert.notEqual(code, 0);
  assert.match(output, /npm (?:error|ERR!)/);
  assert.match(output, /package-lock|lockfile/);
});
