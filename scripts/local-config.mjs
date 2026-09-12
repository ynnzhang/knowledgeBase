import { existsSync, readFileSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Explicit shell variables take priority, followed by .env.local and .env.
for (const name of ['.env.local', '.env']) {
  try {
    loadEnvFile(path.join(projectRoot, name));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export function resolveNotesRoot(env = process.env, platform = process.platform, home = homedir(), exists = existsSync, base = projectRoot) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const configured = env.KNOWLEDGE_BASE_PATH?.trim();
  const defaultPath = platform === 'win32' && exists('E:\\Note') ? 'E:\\Note' : paths.join(home, 'Note');
  const value = configured || defaultPath;
  const expanded = value === '~' ? home
    : value.startsWith('~/') || (platform === 'win32' && value.startsWith('~\\')) ? paths.join(home, value.slice(2)) : value;
  return paths.resolve(base, expanded);
}

export function validSavedRoot(value, platform = process.platform) {
  if (typeof value !== 'string' || value.includes('\0')) return false;
  // A leading slash alone is drive-relative on Windows and may be a copied Mac setting.
  return platform === 'win32'
    ? /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(value)
    : path.posix.isAbsolute(value);
}

let selectedRoot;
try { selectedRoot = JSON.parse(readFileSync(path.join(projectRoot, '.knowledge-base.local.json'), 'utf8')).notesRoot; }
catch (error) { if (error.code !== 'ENOENT') console.warn('[notes] 无法读取上次选择的知识库，使用环境配置。'); }
if (!validSavedRoot(selectedRoot)) selectedRoot = undefined;
export const notesRoot = selectedRoot || resolveNotesRoot();
export const usesDefaultNotesRoot = !selectedRoot && !process.env.KNOWLEDGE_BASE_PATH?.trim();
export const localApiPort = Number(process.env.KNOWLEDGE_BASE_API_PORT || 4312);
if (!Number.isInteger(localApiPort) || localApiPort < 1 || localApiPort > 65535 || localApiPort === 3000) {
  throw new Error('KNOWLEDGE_BASE_API_PORT 必须是 1–65535 之间且不等于网站端口 3000 的整数。');
}
