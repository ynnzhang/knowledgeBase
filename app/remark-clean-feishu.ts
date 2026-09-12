import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Root, RootContent, Blockquote } from 'mdast';

// Older imports included these generated labels. Hide only the standalone
// label, retaining the source content and any errors or ordinary quotations.
function isSyncLabel(node: RootContent): node is Blockquote {
  if (node.type !== 'blockquote' || node.children.length !== 1) return false;
  const paragraph = node.children[0];
  if (paragraph.type !== 'paragraph') return false;
  const parts = paragraph.children;
  if (parts[0]?.type !== 'text' || parts[0].value.trim() !== '同步块') return false;
  if (parts.length === 1) return true;
  const link = parts[1];
  return parts.length === 2 && link.type === 'link' && /^https:\/\/my\.feishu\.cn\/docx\/[a-zA-Z0-9]+$/.test(link.url)
    && link.children.length === 1 && link.children[0].type === 'text' && link.children[0].value === '查看源文档';
}

export default function remarkCleanFeishu() {
  return (tree: Root) => {
    function clean(parent: { children: RootContent[] }) {
      parent.children = parent.children.filter((node) => !isSyncLabel(node));
      for (const node of parent.children) if ('children' in node) clean(node as { children: RootContent[] });
    }
    clean(tree);
  };
}

export function cleanFeishuMarkdown(markdown: string) {
  if (!markdown.includes('同步块')) return markdown;
  const removals: Array<{ start: number; end: number }> = [];
  function visit(nodes: RootContent[]) {
    for (const node of nodes) {
      if (isSyncLabel(node) && node.position) removals.push({ start: node.position.start.offset!, end: node.position.end.offset! });
      else if ('children' in node) visit(node.children as RootContent[]);
    }
  }
  visit(fromMarkdown(markdown).children);
  for (const { start, end } of removals.reverse()) markdown = markdown.slice(0, start) + markdown.slice(end);
  return markdown;
}
