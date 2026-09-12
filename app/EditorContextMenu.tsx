'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useCellValue } from '@mdxeditor/gurx';
import { activeEditor$, addComposerChild$, readOnly$, realmPlugin, rootEditor$ } from '@mdxeditor/editor';
import { $createParagraphNode, $getSelection, $isRangeSelection, $setSelection, FORMAT_TEXT_COMMAND, type LexicalEditor, type RangeSelection, type TextFormatType } from 'lexical';
import { $createHeadingNode, $createQuoteNode, type HeadingTagType } from '@lexical/rich-text';
import { $setBlocksType } from '@lexical/selection';
import { Bold, Italic, Strikethrough, Code, Pilcrow, Quote, Heading } from 'lucide-react';

type MenuState = { x: number; y: number; editor: LexicalEditor; selection: RangeSelection };
function EditorContextMenu() {
  const rootEditor = useCellValue(rootEditor$);
  const activeEditor = useCellValue(activeEditor$);
  const readOnly = useCellValue(readOnly$);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const element = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!rootEditor || readOnly) return;
    const show = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target.closest('.cm-editor, input, textarea, button, [role="dialog"]')) return;
      const editor = activeEditor || rootEditor;
      let selection: RangeSelection | null = null;
      editor.getEditorState().read(() => {
        const current = $getSelection();
        if ($isRangeSelection(current)) selection = current.clone();
      });
      if (!selection) return;
      event.preventDefault();
      const rect = window.getSelection()?.rangeCount ? window.getSelection()!.getRangeAt(0).getBoundingClientRect() : null;
      setMenu({ x: event.clientX || rect?.left || 24, y: event.clientY || rect?.bottom || 24, editor, selection });
    };
    return rootEditor.registerRootListener((root, previous) => {
      previous?.removeEventListener('contextmenu', show);
      root?.addEventListener('contextmenu', show);
    });
  }, [rootEditor, activeEditor, readOnly]);

  useEffect(() => {
    if (!menu) return;
    const popup = element.current!;
    popup.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - popup.offsetWidth - 8))}px`;
    popup.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - popup.offsetHeight - 8))}px`;
    popup.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => { if (!popup.contains(event.target as Node)) setMenu(null); };
    const close = (event: Event) => { if (!(event.target instanceof Node) || !popup.contains(event.target)) setMenu(null); };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu]);

  if (!menu || readOnly) return null;
  function apply(action: () => void) {
    if (!menu) return;
    menu.editor.update(() => { $setSelection(menu.selection.clone()); action(); });
    menu.editor.focus();
    setMenu(null);
  }
  function format(value: TextFormatType) { apply(() => menu!.editor.dispatchCommand(FORMAT_TEXT_COMMAND, value)); }
  function block(value: 'paragraph' | 'quote' | HeadingTagType) {
    apply(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) $setBlocksType(selection, () => value === 'paragraph' ? $createParagraphNode() : value === 'quote' ? $createQuoteNode() : $createHeadingNode(value));
    });
  }
  return createPortal(<div ref={element} className="editor-context-menu" role="menu" aria-label="文字与段落排版" style={{ left: menu.x, top: menu.y }}
    onMouseDown={(event) => event.preventDefault()}
    onKeyDown={(event) => {
      const buttons = Array.from(element.current!.querySelectorAll<HTMLButtonElement>('button'));
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      } else if (event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault();
        apply(() => {});
      }
    }}>
    <button role="menuitem" onClick={() => format('bold')}><Bold size={16} /><span>加粗</span><kbd>⌘/Ctrl B</kbd></button>
    <button role="menuitem" onClick={() => format('italic')}><Italic size={16} /><span>斜体</span><kbd>⌘/Ctrl I</kbd></button>
    <button role="menuitem" onClick={() => format('strikethrough')}><Strikethrough size={16} /><span>删除线</span></button>
    <button role="menuitem" onClick={() => format('code')}><Code size={16} /><span>行内代码</span></button>
    <div className="context-menu-divider" role="separator" />
    <button role="menuitem" onClick={() => block('paragraph')}><Pilcrow size={16} /><span>正文</span></button>
    {[1, 2, 3, 4, 5, 6].map((level) => <button role="menuitem" key={level} onClick={() => block(`h${level}` as HeadingTagType)}><Heading size={16} /><span>{level} 级标题</span><small>H{level}</small></button>)}
    <button role="menuitem" onClick={() => block('quote')}><Quote size={16} /><span>引用</span></button>
  </div>, document.body);
}

export const editorContextMenuPlugin = realmPlugin({
  init(realm) { realm.pub(addComposerChild$, EditorContextMenu); },
});
