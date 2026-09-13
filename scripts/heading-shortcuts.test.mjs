import assert from 'node:assert/strict';
import test from 'node:test';
import { createEditor, $createParagraphNode, $createTextNode, $getRoot, $getSelection, $isRangeSelection, KEY_DOWN_COMMAND } from 'lexical';
import { HeadingNode } from '@lexical/rich-text';
import { headingLevelFromEvent, registerHeadingShortcuts } from '../app/heading-shortcuts.mjs';

const makeEditor = () => createEditor({ namespace: 'headings-test', nodes: [HeadingNode], onError: (error) => { throw error; } });
for (const modifiers of [{ ctrlKey: true }, { ctrlKey: true, altKey: true }, { metaKey: true, altKey: true }]) {
  test(`heading commands preserve text and selection (${JSON.stringify(modifiers)})`, () => {
    const editor = makeEditor();
    const unregister = registerHeadingShortcuts(editor);
    editor.update(() => {
      const text = $createTextNode('标题正文'); text.setFormat('bold');
      $getRoot().append($createParagraphNode().append(text)); text.select(2, 2);
    }, { discrete: true });
    for (let level = 1; level <= 6; level++) {
      let prevented = false;
      editor.update(() => {
        assert.equal(editor.dispatchCommand(KEY_DOWN_COMMAND, { ...modifiers, code: `Digit${level}`, key: String(level), preventDefault() { prevented = true; } }), true);
      }, { discrete: true });
      editor.getEditorState().read(() => {
        const heading = $getRoot().getFirstChild();
        assert.equal(heading.getTag(), `h${level}`);
        assert.equal(heading.getTextContent(), '标题正文');
        assert.ok(heading.getFirstChild().hasFormat('bold'));
        const selection = $getSelection(); assert.ok($isRangeSelection(selection));
        assert.equal(selection.anchor.offset, 2);
      });
      assert.ok(prevented);
    }
    editor.update(() => { editor.dispatchCommand(KEY_DOWN_COMMAND, { ctrlKey: true, altKey: true, code: 'Digit0', preventDefault() {} }); }, { discrete: true });
    editor.getEditorState().read(() => assert.equal($getRoot().getFirstChild().getType(), 'paragraph'));
    unregister();
  });
}

test('formats multiple selected paragraphs and keeps an existing heading at the requested level', () => {
  const editor = makeEditor(); const unregister = registerHeadingShortcuts(editor);
  editor.update(() => {
    const first = $createTextNode('第一段'), second = $createTextNode('第二段');
    $getRoot().append($createParagraphNode().append(first), $createParagraphNode().append(second));
    first.select(0, 0); $getSelection().focus.set(second.getKey(), 3, 'text');
    const event = { ctrlKey: true, altKey: true, key: '2', preventDefault() {} };
    editor.dispatchCommand(KEY_DOWN_COMMAND, event);
    editor.dispatchCommand(KEY_DOWN_COMMAND, event);
    assert.deepEqual($getRoot().getChildren().map((node) => [node.getTag(), node.getTextContent()]), [['h2', '第一段'], ['h2', '第二段']]);
  }, { discrete: true });
  unregister();
});

test('ignores unrelated keys, composition, AltGraph, repeat and browser zoom reset', () => {
  for (const event of [{ key: '1' }, { ctrlKey: true, key: '7' }, { ctrlKey: true, key: '0' }, { ctrlKey: true, key: '1', shiftKey: true }, { ctrlKey: true, key: '1', repeat: true }, { ctrlKey: true, key: '1', isComposing: true }, { ctrlKey: true, altKey: true, key: '1', getModifierState: () => true }, { ctrlKey: true, metaKey: true, key: '1' }]) {
    assert.equal(headingLevelFromEvent(event), null);
  }
  assert.equal(headingLevelFromEvent({ ctrlKey: true, altKey: true, key: '¡', code: 'Digit1' }), 1);
});

test('readonly, input controls and missing selection never format the note', () => {
  for (const mode of ['readonly', 'input', 'no-selection']) {
    const editor = makeEditor(); const unregister = registerHeadingShortcuts(editor);
    editor.update(() => {
      const text = $createTextNode('正文'); $getRoot().append($createParagraphNode().append(text));
      if (mode !== 'no-selection') text.selectEnd();
      if (mode === 'readonly') editor.setEditable(false);
      editor.dispatchCommand(KEY_DOWN_COMMAND, { ctrlKey: true, altKey: true, key: '1', target: { closest: () => mode === 'input' }, preventDefault() { assert.fail('must not consume'); } });
      assert.equal($getRoot().getFirstChild().getType(), 'paragraph');
    }, { discrete: true });
    unregister();
  }
});
