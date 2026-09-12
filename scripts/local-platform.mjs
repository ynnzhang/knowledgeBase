import { spawn } from 'node:child_process';
import path from 'node:path';

// Keep shell input fixed: project and note paths are passed as cwd/options.
export function npmCommand(args, platform = process.platform) {
  if (!['ci', 'run dev', 'run dev:site'].includes(args.join(' '))) throw new Error('不支持的启动命令。');
  return platform === 'win32'
    ? ['cmd.exe', ['/d', '/s', '/c', `npm ${args.join(' ')}`]]
    : ['npm', args];
}

export function browserCommand(url, platform = process.platform) {
  if (platform === 'win32') {
    // EncodedCommand preserves Unicode and avoids cmd.exe quoting rules.
    const script = `Start-Process '${url.replaceAll("'", "''")}'`;
    return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]];
  }
  return [platform === 'darwin' ? 'open' : 'xdg-open', [url]];
}

export function sameLocalPath(left, right, platform = process.platform) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const normalize = (value) => paths.normalize(value).replace(/[\\/]+$/, '');
  return platform === 'win32'
    ? normalize(left).toLowerCase() === normalize(right).toLowerCase()
    : normalize(left) === normalize(right);
}

export function stopProcessTree(pid, platform = process.platform, launch = spawn, kill = process.kill.bind(process)) {
  if (!pid) return;
  if (platform === 'win32') {
    const cleanup = launch('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    cleanup.on('error', () => { try { kill(pid); } catch { /* Already exited. */ } });
    return;
  }
  try { kill(-pid, 'SIGTERM'); } catch { /* Already exited. */ }
  const timer = setTimeout(() => {
    try { kill(-pid, 'SIGKILL'); } catch { /* Already exited. */ }
  }, 3000);
  timer.unref();
}
