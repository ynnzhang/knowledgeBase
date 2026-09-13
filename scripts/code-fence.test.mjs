import assert from 'node:assert/strict';
import test from 'node:test';
import { createEditor, $createParagraphNode, $createTextNode, $getRoot, KEY_DOWN_COMMAND } from 'lexical';
import { CodeBlockNode } from '@mdxeditor/editor';
import { parseCodeFence, registerCodeFence } from '../app/code-fence.mjs';

for (const [fence, language] of [['```java', 'java'], ['```JAVA', 'java'], ['```', 'txt'], ['```c++', 'c++'], ['```c#', 'c#'], ['```python', 'python'], ['  ````sql', 'sql']]) {
  test(`typing ${fence} then Enter/space creates a ${language} code block`, () => {
    assert.equal(parseCodeFence(fence), language);
    for (const key of ['Enter', ' ']) {
      const editor = createEditor({ namespace: 'fence-test', nodes: [CodeBlockNode], onError: (error) => { throw error; } });
      const unregister = registerCodeFence(editor);
      let prevented = false;
      editor.update(() => {
        const p = $createParagraphNode().append($createTextNode(fence));
        $getRoot().append(p); p.selectEnd();
        assert.equal(editor.dispatchCommand(KEY_DOWN_COMMAND, { key, preventDefault() { prevented = true; } }), true);
      }, { discrete: true });
      editor.getEditorState().read(() => {
        const node = $getRoot().getFirstChild();
        assert.ok(node instanceof CodeBlockNode);
        assert.equal(node.getLanguage(), language);
        assert.equal(node.getCode(), '');
        assert.equal(node.getNextSibling().getType(), 'paragraph');
      });
      assert.equal(prevented, true);
      unregister();
    }
  });
}

test('does not replace inline fences, code examples, selections, composition or modified Enter', () => {
  for (const text of ['text ```java', '```java content', '    ```java', '```java```']) assert.equal(parseCodeFence(text), null);
  for (const options of [{ isComposing: true }, { shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { key: 'x' }, { middle: true }, { range: true }, { readOnly: true }]) {
    const editor = createEditor({ namespace: 'fence-test', nodes: [CodeBlockNode], onError: (error) => { throw error; } });
    const unregister = registerCodeFence(editor);
    editor.update(() => {
      const text = $createTextNode('```java');
      $getRoot().append($createParagraphNode().append(text));
      if (options.readOnly) editor.setEditable(false);
      if (options.range) text.select(0, 7); else if (options.middle) text.select(3, 3); else text.selectEnd();
      editor.dispatchCommand(KEY_DOWN_COMMAND, { key: 'Enter', preventDefault() {}, ...options });
      assert.equal($getRoot().getFirstChild().getType(), 'paragraph');
    }, { discrete: true });
    unregister();
  }
});
