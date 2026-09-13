import { $createCodeBlockNode } from '@mdxeditor/editor';
import { $createParagraphNode, $getNodeByKey, $getSelection, $isParagraphNode, $isRangeSelection, $isTextNode, COMMAND_PRIORITY_HIGH, HISTORY_PUSH_TAG, KEY_DOWN_COMMAND, $addUpdateTag } from 'lexical';

// Own the fence grammar instead of depending on the capture groups of a
// third-party Markdown transformer (Lexical 0.48 changed their positions).
export function parseCodeFence(text) {
  const match = /^[ \t]{0,3}`{3,}([\w#+.-]*)[ \t]*$/.exec(text);
  return match ? (match[1].toLowerCase() || 'txt') : null;
}

export function registerCodeFence(editor) {
  let focusTimer;
  const unregister = editor.registerCommand(KEY_DOWN_COMMAND, (event) => {
    if (!editor.isEditable() || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
      || !['Enter', ' '].includes(event.key)) return false;
    const selection = $getSelection();
    if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
    const anchor = selection.anchor.getNode();
    const paragraph = $isParagraphNode(anchor) ? anchor : anchor.getParent();
    if (!$isParagraphNode(paragraph)) return false;
    if ($isParagraphNode(anchor) && selection.anchor.offset !== paragraph.getChildrenSize()) return false;
    if ($isTextNode(anchor) && (anchor.getNextSibling() || selection.anchor.offset !== anchor.getTextContentSize())) return false;
    const language = parseCodeFence(paragraph.getTextContent());
    if (language === null) return false;
    event.preventDefault();
    $addUpdateTag(HISTORY_PUSH_TAG);
    const block = $createCodeBlockNode({ code: '', language, meta: '' });
    paragraph.replace(block);
    const next = block.getNextSibling() || block.insertAfter($createParagraphNode());
    next.selectStart();
    const key = block.getKey();
    clearTimeout(focusTimer);
    focusTimer = setTimeout(() => editor.getEditorState().read(() => $getNodeByKey(key)?.select()), 80);
    return true;
  }, COMMAND_PRIORITY_HIGH);
  return () => { clearTimeout(focusTimer); unregister(); };
}
