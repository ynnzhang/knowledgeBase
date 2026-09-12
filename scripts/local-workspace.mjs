import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, realpath, stat, writeFile, rename } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
const run = promisify(execFile);

export async function chooseLocalFolder(platform = process.platform, execute = run) {
  let command, args;
  if (platform === 'darwin') {
    command = 'osascript';
    args = ['-e', 'try\nset chosen to choose folder with prompt "选择知识库文件夹"\nreturn POSIX path of chosen\non error number -128\nreturn ""\nend try'];
  } else if (platform === 'win32') {
    command = 'powershell.exe';
    const script = '$ErrorActionPreference = "Stop"; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::EnableVisualStyles(); $picker = New-Object System.Windows.Forms.FolderBrowserDialog; $picker.Description = "选择知识库文件夹"; try { if ($picker.ShowDialog() -eq "OK") { Write-Output $picker.SelectedPath } } finally { $picker.Dispose() }';
    args = ['-NoProfile', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  } else {
    command = 'zenity'; args = ['--file-selection', '--directory', '--title=选择知识库文件夹'];
  }
  try {
    const { stdout } = await execute(command, args, { encoding: 'utf8', timeout: 300000, maxBuffer: 65536 });
    return stdout.replace(/^\uFEFF/, '').trim() || null;
  } catch (error) {
    if (platform === 'linux' && error.code === 1) return null;
    throw new Error('未能打开系统文件夹选择器，请直接输入本地文件夹的完整路径。');
  }
}

export async function validateLocalFolder(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw new Error('请输入电脑上文件夹的完整绝对路径。');
  const directory = await realpath(value);
  if (!(await stat(directory)).isDirectory()) throw new Error('请选择文件夹，而不是文件。');
  await access(directory, constants.R_OK | constants.W_OK);
  return directory;
}

export async function saveLocalFolder(projectRoot, notesRoot) {
  const file = path.join(projectRoot, '.knowledge-base.local.json');
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify({ notesRoot }, null, 2), { mode: 0o600, flag: 'wx' });
  await rename(temp, file);
}
