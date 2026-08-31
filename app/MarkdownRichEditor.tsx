'use client';

import dynamic from 'next/dynamic';
import type { MarkdownRichEditorProps } from './MarkdownRichEditorInner';

const ClientEditor = dynamic(() => import('./MarkdownRichEditorInner'), {
  ssr: false,
  loading: () => <div className="rich-editor-loading">正在打开笔记…</div>,
});

export default function MarkdownRichEditor(props: MarkdownRichEditorProps) {
  return <ClientEditor {...props} />;
}
