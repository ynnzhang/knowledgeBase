import test from 'node:test';
import assert from 'node:assert/strict';
import { extractNoteHeadings } from '../app/note-outline.ts';
import { cleanFeishuMarkdown } from '../app/remark-clean-feishu.ts';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { toMarkdown } from 'mdast-util-to-markdown';
import { gfmTable } from 'micromark-extension-gfm-table';
import { gfmTableFromMarkdown, gfmTableToMarkdown } from 'mdast-util-gfm-table';
import { cjkSyntax, cjkSerialization } from '../app/markdown-syntax.mjs';
import { blocksToMarkdown } from './feishu-markdown.mjs';

const parse = (markdown) => fromMarkdown(markdown, { extensions: [gfmTable(), cjkSyntax], mdastExtensions: [gfmTableFromMarkdown()] });
const serialize = (tree) => toMarkdown(tree, { extensions: [gfmTableToMarkdown(), cjkSerialization] });
const content = (node) => node.value ?? node.children?.map(content).join('') ?? '';
const strongText = (node) => node.type === 'strong' ? [content(node)] : node.children?.flatMap(strongText) ?? [];

test('Chinese bold next to punctuation and text renders and saves without inserting spaces', () => {
  for (const source of ['**思路：**基础动态规划', '使用**（重点）**解决问题', '**结论。**继续说明', '**思路：**基础，**复杂度：**线性']) {
    const tree = parse(source);
    assert.ok(strongText(tree).length);
    const saved = serialize(tree);
    assert.deepEqual(strongText(parse(saved)), strongText(tree));
    assert.equal(content(parse(saved)), content(tree));
    assert.equal(saved.trim(), source);
  }
});

test('Chinese formatting works in headings, lists and tables with real empty cells preserved', () => {
  const source = '## **思路：**动态规划\n\n- **边界：**空数组\n\n| 项目 | |\n| --- | --- |\n| **结论：**可行 | |';
  const tree = parse(source), saved = parse(serialize(tree));
  assert.deepEqual(strongText(tree), ['思路：', '边界：', '结论：']);
  assert.deepEqual(strongText(saved), strongText(tree));
  const table = saved.children.find((node) => node.type === 'table');
  assert.equal(table.children.length, 2);
  assert.equal(table.children[0].children.length, 2);
  assert.equal(table.children[0].children[1].children.length, 0);
  assert.equal(table.children[1].children[1].children.length, 0);
  assert.equal(extractNoteHeadings(source)[0].title, '思路：动态规划');
});

test('CJK parsing preserves literal Markdown in code, escaped stars and links', () => {
  const source = '`**思路：**基础`\n\n```md\n**思路：**基础\n```\n\n\\*\\*思路：\\*\\*基础\n\n[**重点：**内容](https://example.com/a?q=1)';
  const tree = parse(source), saved = parse(serialize(tree));
  assert.deepEqual(strongText(tree), ['重点：']);
  assert.deepEqual(strongText(saved), ['重点：']);
  assert.equal(saved.children[0].children[0].value, '**思路：**基础');
  assert.equal(saved.children[1].value, '**思路：**基础');
  assert.equal(content(saved.children[2]), '**思路：**基础');
  assert.equal(saved.children[3].children[0].url, 'https://example.com/a?q=1');
});

test('Feishu bold text runs render directly without requiring a separating space', () => {
  const { markdown } = blocksToMarkdown([
    { block_id: 'root', block_type: 1, children: ['body'] },
    { block_id: 'body', block_type: 2, text: { elements: [
      { text_run: { content: '思路：', text_element_style: { bold: true } } },
      { text_run: { content: '基础动态规划' } },
    ] } },
  ], 'root');
  assert.deepEqual(strongText(parse(markdown)), ['思路：']);
  assert.equal(content(parse(markdown)), '思路：基础动态规划');
  assert.equal(cleanFeishuMarkdown(markdown), markdown);
});

test('extracts formatted headings, Setext and skipped levels in document order', () => {
  const result = extractNoteHeadings('# **入门**与 `Flyway`\n\n原理\n---\n\n###### [执行](https://example.com) ![流程](flow.png)');
  assert.deepEqual(result.map(({ title, level }) => ({ title, level })), [
    { title: '入门与 Flyway', level: 1 },
    { title: '原理', level: 2 },
    { title: '执行 流程', level: 6 },
  ]);
});

test('ignores apparent headings in code blocks and inline text', () => {
  const markdown = '```md\n# 示例\n```\n\n    ## 缩进代码\n\n普通正文 # 不是标题\n\n## 真正标题';
  assert.deepEqual(extractNoteHeadings(markdown).map((entry) => entry.title), ['真正标题']);
});

test('repeated and nested headings have separate exact source positions with CRLF', () => {
  const markdown = '## 重复\r\n\r\n> ### 引用标题\r\n\r\n## 重复\r\n';
  const entries = extractNoteHeadings(markdown);
  assert.deepEqual(entries.map((entry) => entry.title), ['重复', '引用标题', '重复']);
  assert.notEqual(entries[0].offset, entries[2].offset);
  assert.deepEqual(entries.map((entry) => markdown.slice(entry.offset, entry.end)), ['## 重复', '### 引用标题', '## 重复']);
});

test('handles notes with no headings and headings without text', () => {
  assert.deepEqual(extractNoteHeadings('只有普通段落。'), []);
  assert.equal(extractNoteHeadings('##')[0].title, '未命名标题');
});

test('legacy Feishu number escapes are repaired in headings and formatted heading starts on both platforms', () => {
  const markdown = '## \\2. Flyway 是什么\n\n### **\\12. 底层原理**\n\n\\3. 正文保留\n\n> ## \\4. 引用标题\n';
  for (const source of [markdown, markdown.replaceAll('\n', '\r\n')]) {
    const cleaned = cleanFeishuMarkdown(source);
    assert.deepEqual(extractNoteHeadings(cleaned).map((entry) => entry.title), ['2. Flyway 是什么', '12. 底层原理', '4. 引用标题']);
    assert.ok(cleaned.includes('\\3. 正文保留'));
    assert.equal(cleanFeishuMarkdown(cleaned), cleaned);
    if (source.includes('\r\n')) assert.equal(cleaned.replaceAll('\r\n', '').includes('\n'), false);
  }
});

test('heading repair preserves paths, explicit backslashes, normal escapes and code examples', () => {
  const source = [
    '## /2. 原本的正斜杠', '## \\\\2. 原本的反斜杠', '## 2\\. 正确的编号转义',
    '## `\\2. 代码`', '## C:\\2. 文件夹', '```md\n## \\2. 示例\n```',
  ].join('\n\n');
  assert.equal(cleanFeishuMarkdown(source), source);
});
