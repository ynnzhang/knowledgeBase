import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseLocalFolder } from './local-workspace.mjs';

test('native folder chooser uses OS dialogs and treats cancel as no selection', async () => {
  for (const [platform, executable] of [['darwin', 'osascript'], ['win32', 'powershell.exe'], ['linux', 'zenity']]) {
    const result = await chooseLocalFolder(platform, async (command, args) => {
      assert.equal(command, executable);
      assert.ok(Array.isArray(args));
      return { stdout: '/Users/test/我的 笔记\n' };
    });
    assert.equal(result, '/Users/test/我的 笔记');
    assert.equal(await chooseLocalFolder(platform, async () => ({ stdout: '' })), null);
  }
  assert.equal(await chooseLocalFolder('linux', async () => { throw { code: 1 }; }), null);
  await assert.rejects(chooseLocalFolder('darwin', async () => { throw new Error('denied'); }), /完整路径/);
});

test('Windows chooser preserves Unicode and strips BOM/CRLF', async () => {
  const chosen = await chooseLocalFolder('win32', async (command, args) => {
    assert.equal(command, 'powershell.exe');
    assert.ok(args.includes('-STA'));
    assert.ok(args.includes('-EncodedCommand'));
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    assert.match(script, /选择知识库文件夹/);
    assert.match(script, /UTF8Encoding/);
    return { stdout: '\uFEFFC:\\Users\\测试\\我的 笔记\r\n' };
  });
  assert.equal(chosen, 'C:\\Users\\测试\\我的 笔记');
  await assert.rejects(chooseLocalFolder('win32', async () => { throw new Error('PowerShell unavailable'); }), /完整路径/);
});
