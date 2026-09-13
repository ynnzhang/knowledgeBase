import { $addUpdateTag, $createParagraphNode, $getSelection, $isRangeSelection, COMMAND_PRIORITY_HIGH, HISTORY_PUSH_TAG, KEY_DOWN_COMMAND } from 'lexical';
import { $createHeadingNode, HeadingNode } from '@lexical/rich-text';
import { $setBlocksType } from '@lexical/selection';

export function headingLevelFromEvent(event) {
  if (event.isComposing || event.repeat || event.shiftKey || event.getModifierState?.('AltGraph')) return null;
  if (Boolean(event.ctrlKey) === Boolean(event.metaKey)) return null;
  const physicalKey = /^(?:Digit|Numpad)([0-6])$/.exec(event.code || '');
  const level = physicalKey ? Number(physicalKey[1]) : /^[0-6]$/.test(event.key) ? Number(event.key) : null;
  // Ctrl+0 is browser zoom reset. Only offer the Alt variant for plain text.
  return level === 0 && !event.altKey ? null : level;
}

export function registerHeadingShortcuts(editor) {
  if (!editor.hasNodes([HeadingNode])) return () => {};
  return editor.registerCommand(KEY_DOWN_COMMAND, (event) => {
    const level = headingLevelFromEvent(event);
    if (level === null || !editor.isEditable()) return false;
    // Formatting applies only to the rich-text selection, never to code,
    // source Markdown, language selectors or other input controls.
    if (event.target?.closest?.('.cm-editor, input, textarea, select, button, [role="dialog"]')) return false;
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return false;
    event.preventDefault();
    $addUpdateTag(HISTORY_PUSH_TAG);
    $setBlocksType(selection, () => level === 0 ? $createParagraphNode() : $createHeadingNode(`h${level}`));
    return true;
  }, COMMAND_PRIORITY_HIGH);
}
