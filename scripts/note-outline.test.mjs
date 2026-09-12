import test from 'node:test';
import assert from 'node:assert/strict';
import { extractNoteHeadings } from '../app/note-outline.ts';
import { cleanFeishuMarkdown } from '../app/remark-clean-feishu.ts';

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
