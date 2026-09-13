'use client';

import { useEffect, useRef, useState } from 'react';
import { CodeMirrorEditor, readOnly$, type CodeBlockEditorProps } from '@mdxeditor/editor';
import { useCellValue } from '@mdxeditor/gurx';
import { Check, Copy } from 'lucide-react';
import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';

export const noteCodeExtensions = [
  EditorView.theme({
    '&': { backgroundColor: '#17202e', color: '#dce5f2', fontSize: '13px' },
    '.cm-content': { caretColor: '#93c5fd', padding: '16px 0' },
    '.cm-scroller': { fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace', lineHeight: '1.75', overflow: 'auto', maxHeight: '520px' },
    '.cm-gutters': { backgroundColor: '#17202e', color: '#718096', border: 'none', paddingRight: '12px' },
    '.cm-line': { padding: '0 16px 0 4px' },
    '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: '#ffffff06' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: '#355275' },
    '.cm-cursor': { borderLeftColor: '#93c5fd' },
    '.cm-matchingBracket': { backgroundColor: '#39516f', color: '#fff' },
  }, { dark: true }),
  syntaxHighlighting(HighlightStyle.define([
    { tag: [tags.keyword, tags.operatorKeyword], color: '#c4a7ff' },
    { tag: [tags.string, tags.special(tags.string)], color: '#a3d9a5' },
    { tag: [tags.number, tags.bool, tags.null], color: '#f5c78e' },
    { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: '#82caff' },
    { tag: [tags.typeName, tags.className], color: '#80d5cf' },
    { tag: [tags.comment, tags.meta], color: '#8a9ab0', fontStyle: 'italic' },
    { tag: [tags.operator, tags.punctuation], color: '#b6c4d8' },
  ])),
];

export function NoteCodeBlock(props: CodeBlockEditorProps) {
  const container = useRef<HTMLElement>(null);
  const readOnly = useCellValue(readOnly$);
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    if (!('IntersectionObserver' in window)) { queueMicrotask(() => setVisible(true)); return; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: '400px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(props.code);
      setCopied(true); setError('');
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1800);
    } catch { setError('复制失败，请选中代码后复制。'); }
  }
  return <section ref={container} className="note-code-block" aria-label={`${props.language || '纯文本'}代码块`}>
    {visible ? <CodeMirrorEditor {...props} /> : <><div className="note-code-preview-language">{props.language || '纯文本'}</div><pre className="note-code-preview" tabIndex={0} onFocus={() => setVisible(true)}>{props.code}</pre></>}
    <button className="note-code-copy" type="button" onClick={() => void copy()} aria-label="复制完整代码">
      {copied ? <Check size={14} /> : <Copy size={14} />}{copied ? '已复制' : '复制'}
    </button>
    <footer><span>{props.code.split('\n').length} 行</span><span role="status">{error || (copied ? '完整代码已复制' : readOnly ? '只读' : '可直接编辑')}</span></footer>
  </section>;
}
