import { parseDocument } from 'yaml';

function metadata(raw) {
  const match = raw.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  const document = parseDocument(match?.[1] || '');
  if (document.errors.length) throw new Error('笔记的 YAML 元数据格式有误，已停止标签操作。');
  if (!document.contents) document.contents = document.createNode({});
  return { document, body: match ? raw.slice(match[0].length) : raw, hasFrontmatter: Boolean(match) };
}

export function readNoteTags(raw) {
  const { document } = metadata(raw);
  const value = ['tags', 'tag', 'keywords'].map((key) => document.get(key, true)?.toJSON?.() ?? document.get(key)).find((value) => value !== null && value !== undefined);
  if (Array.isArray(value)) return [...new Set(value.map(String).map((tag) => tag.trim()).filter(Boolean))];
  if (typeof value !== 'string') return [];
  return [...new Set(value.replace(/^\[|\]$/g, '').split(/[,，]/).map((tag) => tag.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean))];
}

export function normalizeTags(value) {
  if (!Array.isArray(value)) throw new Error('标签格式无效。');
  return [...new Set(value.map((tag) => String(tag).trim().replace(/^#+/, '').trim().slice(0, 32)).filter(Boolean))].slice(0, 20);
}

export function updateNoteTags(raw, tags, fallbackUpdated) {
  const { document, body, hasFrontmatter } = metadata(raw);
  document.set('tags', tags);
  if (!['updated', 'last_updated', 'modified', 'date'].some((key) => document.has(key))) document.set('updated', fallbackUpdated.toISOString().slice(0, 10));
  return `---\n${document.toString().trimEnd()}\n---\n${hasFrontmatter ? '' : '\n'}${body}`;
}
