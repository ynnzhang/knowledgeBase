import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Nodes } from 'mdast';
import { cjkSyntax } from './markdown-syntax.mjs';

export type NoteHeading = { title: string; level: number; offset: number; end: number };

function headingText(node: Nodes): string {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value;
  if (node.type === 'image' || node.type === 'imageReference') return node.alt || '';
  if (node.type === 'break') return ' ';
  return 'children' in node ? node.children.map(headingText).join('') : '';
}

// Parse Markdown rather than matching lines: code fences are not headings,
// while Setext headings and formatted heading text are part of the outline.
export function extractNoteHeadings(markdown: string): NoteHeading[] {
  const headings: NoteHeading[] = [];
  function visit(node: Nodes) {
    if (node.type === 'heading') {
      headings.push({
        title: headingText(node).replace(/\s+/g, ' ').trim() || '未命名标题',
        level: node.depth,
        offset: node.position?.start.offset ?? 0,
        end: node.position?.end.offset ?? 0,
      });
    } else if ('children' in node) {
      node.children.forEach(visit);
    }
  }
  visit(fromMarkdown(markdown, { extensions: [cjkSyntax] }));
  return headings;
}
