'use client';
import { lazy, Suspense } from 'react';
import type { MarkdownRichEditorProps } from './MarkdownRichEditorInner';
const ClientEditor = lazy(() => import('./MarkdownRichEditorInner'));
export default function MarkdownRichEditor(props: MarkdownRichEditorProps) {
  return <Suspense fallback={<div className="rich-editor-loading">正在打开笔记…</div>}><ClientEditor {...props} /></Suspense>;
}
