'use client';

import { useEffect, useRef, useState } from 'react';
import { readOnly$, useCodeBlockEditorContext, type CodeBlockEditorProps } from '@mdxeditor/editor';
import { useCellValue } from '@mdxeditor/gurx';
import { Check, Copy, Trash2, WrapText } from 'lucide-react';
import { EditorView, keymap } from '@codemirror/view';
import { Annotation, Compartment, EditorState } from '@codemirror/state';
import { indentWithTab } from '@codemirror/commands';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { basicSetup } from 'codemirror';
import { tags } from '@lezer/highlight';
import { $createParagraphNode, $getNodeByKey, $setSelection } from 'lexical';

const languageNames: Record<string, string> = {
  txt: '纯文本', java: 'Java', js: 'JavaScript', ts: 'TypeScript', jsx: 'JSX', tsx: 'TSX',
  python: 'Python', bash: 'Shell', sql: 'SQL', json: 'JSON', yaml: 'YAML', html: 'HTML', css: 'CSS', xml: 'XML',
  go: 'Go', rust: 'Rust', c: 'C', cpp: 'C++', csharp: 'C#', kotlin: 'Kotlin', markdown: 'Markdown',
};
const externalChange = Annotation.define<boolean>();
const codeTheme = [EditorView.theme({
  '&': { backgroundColor: '#f5f6f7', color: '#1f2329', fontSize: '13px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-content': { caretColor: '#3370ff', padding: '10px 0 14px' },
  '.cm-scroller': { fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace', lineHeight: '1.7', overflow: 'auto', maxHeight: '560px' },
  '.cm-gutters': { backgroundColor: '#f5f6f7', color: '#9298a1', border: 'none', padding: '0 10px 0 8px' },
  '.cm-line': { padding: '0 18px 0 4px' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'transparent' },
  '&.cm-focused .cm-activeLine': { backgroundColor: '#1f232905' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: '#cce0ff' },
  '.cm-cursor': { borderLeftColor: '#3370ff' },
  '.cm-matchingBracket': { backgroundColor: '#d6e4ff' },
}), syntaxHighlighting(HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword], color: '#a626a4' },
  { tag: [tags.string, tags.special(tags.string)], color: '#44833b' },
  { tag: [tags.number, tags.bool, tags.null], color: '#986801' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: '#356ac3' },
  { tag: [tags.typeName, tags.className], color: '#99621b' },
  { tag: [tags.comment, tags.meta], color: '#858b94' },
  { tag: [tags.operator, tags.punctuation], color: '#565c64' },
]))];

export function NoteCodeBlock(props: CodeBlockEditorProps) {
  const container = useRef<HTMLElement>(null);
  const mount = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const readOnly = useCellValue(readOnly$);
  const context = useCodeBlockEditorContext();
  const latest = useRef({ props, context, readOnly });
  useEffect(() => { latest.current = { props, context, readOnly }; });
  const [visible, setVisible] = useState(false);
  const [wrapped, setWrapped] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wantsFocus = useRef(false);
  const [slots] = useState(() => ({ language: new Compartment(), wrap: new Compartment(), editable: new Compartment() }));
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
  useEffect(() => {
    props.focusEmitter.subscribe(() => {
      wantsFocus.current = true;
      setVisible(true);
      view.current?.focus();
    });
    return () => props.focusEmitter.subscribe(() => {});
  }, [props.focusEmitter]);
  useEffect(() => {
    if (!visible || !mount.current) return;
    // Create once. Language/wrapping/readonly changes reconfigure compartments,
    // retaining the current document, selection, scroll position and undo history.
    const instance = new EditorView({ parent: mount.current, state: EditorState.create({
      doc: latest.current.props.code,
      extensions: [basicSetup, ...codeTheme, keymap.of([indentWithTab, {
        key: 'Mod-Enter', run: () => {
          const { context, props } = latest.current;
          context.parentEditor.update(() => {
            const node = $getNodeByKey(props.nodeKey);
            if (!node) return;
            const next = node.getNextSibling() || node.insertAfter($createParagraphNode());
            next.selectStart();
          });
          return true;
        },
      }]), slots.language.of([]), slots.wrap.of([]),
      slots.editable.of([EditorState.readOnly.of(latest.current.readOnly), EditorView.editable.of(!latest.current.readOnly)]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !update.transactions.some((transaction) => transaction.annotation(externalChange))) {
          latest.current.context.setCode(update.state.doc.toString());
        }
      }), EditorView.domEventHandlers({
        focus: () => { latest.current.context.parentEditor.update(() => $setSelection(null)); },
        keydown: (event) => { event.stopPropagation(); return false; },
      })],
    }) });
    view.current = instance;
    if (wantsFocus.current) { instance.focus(); wantsFocus.current = false; }
    return () => { view.current = null; instance.destroy(); };
  }, [visible, slots]);
  useEffect(() => {
    const instance = view.current;
    if (instance && props.code !== instance.state.doc.toString()) {
      instance.dispatch({ changes: { from: 0, to: instance.state.doc.length, insert: props.code }, annotations: externalChange.of(true) });
    }
  }, [props.code, visible]);
  useEffect(() => {
    view.current?.dispatch({ effects: [slots.wrap.reconfigure(wrapped ? EditorView.lineWrapping : []),
      slots.editable.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)])] });
  }, [readOnly, wrapped, slots, visible]);
  useEffect(() => {
    const instance = view.current;
    if (!instance) return;
    let cancelled = false;
    instance.dispatch({ effects: slots.language.reconfigure([]) });
    const name = (props.language || 'txt').toLowerCase();
    const language = languages.find((item) => item.name.toLowerCase() === name || item.alias.includes(name) || item.extensions.includes(name));
    if (language) void language.load().then((support) => {
      if (!cancelled) instance.dispatch({ effects: slots.language.reconfigure(support.extension) });
    }).catch(() => { if (!cancelled) setError('高亮加载失败，仍可编辑和复制'); });
    return () => { cancelled = true; };
  }, [props.language, slots, visible]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(view.current?.state.doc.toString() ?? props.code);
      setCopied(true); setError('');
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1800);
    } catch { setError('复制失败，请选中代码后复制'); }
  }
  const language = props.language || 'txt';
  return <section ref={container} className="note-code-block" aria-label={`${languageNames[language] || language}代码块`} contentEditable={false}>
    <header className="note-code-header">
      <select aria-label="代码语言" value={language} disabled={readOnly} onChange={(event) => context.setLanguage(event.target.value)}>
        {!languageNames[language] && <option value={language}>{language}</option>}
        {Object.entries(languageNames).map(([key, name]) => <option key={key} value={key}>{name}</option>)}
      </select>
      <div className="note-code-actions">
        <button type="button" aria-label="自动换行" title="自动换行" aria-pressed={wrapped} onClick={() => setWrapped((current) => !current)}><WrapText size={15} /></button>
        <button type="button" onClick={() => void copy()} aria-label="复制完整代码" title={copied ? '已复制' : '复制代码'}>{copied ? <Check size={15} /> : <Copy size={15} />}</button>
        {!readOnly && <button type="button" aria-label="删除代码块" title="删除代码块" onClick={() => context.parentEditor.update(() => {
          const node = $getNodeByKey(props.nodeKey);
          if (!node) return;
          const next = node.getNextSibling() || node.insertAfter($createParagraphNode());
          next.selectStart(); node.remove();
        })}><Trash2 size={15} /></button>}
      </div>
    </header>
    {visible ? <div ref={mount} /> : <pre className="note-code-preview" tabIndex={0} onFocus={() => { wantsFocus.current = true; setVisible(true); }}>{props.code || ' '}</pre>}
    <span className={error ? 'note-code-error' : 'sr-only'} role="status">{error || (copied ? '完整代码已复制' : '')}</span>
  </section>;
}
