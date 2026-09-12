import test from 'node:test';
import assert from 'node:assert/strict';
import { extractNoteHeadings } from '../app/note-outline.ts';

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
