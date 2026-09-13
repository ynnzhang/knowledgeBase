'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { useCellValue } from '@mdxeditor/gurx';
import { $nodesOfType } from 'lexical';
import { addComposerChild$, readOnly$, realmPlugin, TableNode } from '@mdxeditor/editor';
import { TableProperties } from 'lucide-react';

function TableToggle({ target, readOnly }: { target: HTMLElement; readOnly: boolean }) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    target.setAttribute('data-table-tools', expanded && !readOnly ? 'open' : 'closed');
    return () => { target.removeAttribute('data-table-tools'); };
  }, [target, expanded, readOnly]);
  if (readOnly) return null;
  return createPortal(<div className="note-table-toolbar" contentEditable={false}>
    <button type="button" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>
      <TableProperties size={14} />{expanded ? '收起表格工具' : '表格工具'}
    </button>
  </div>, target);
}

function TableTools() {
  const [editor] = useLexicalComposerContext();
  const readOnly = useCellValue(readOnly$);
  const [tables, setTables] = useState<Array<{ key: string; element: HTMLElement }>>([]);
  useEffect(() => editor.registerMutationListener(TableNode, () => {
    editor.getEditorState().read(() => {
      const next = $nodesOfType(TableNode).flatMap((node) => {
        const key = node.getKey(), element = editor.getElementByKey(key);
        return element ? [{ key, element }] : [];
      });
      setTables((previous) => previous.length === next.length && previous.every((item, index) => item.key === next[index].key && item.element === next[index].element) ? previous : next);
    });
  }, { skipInitialization: false }), [editor]);
  return tables.map(({ key, element }) => <TableToggle key={key} target={element} readOnly={readOnly} />);
}

export const tableToolsPlugin = realmPlugin({
  init(realm) { realm.pub(addComposerChild$, TableTools); },
});
