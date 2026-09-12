// Feishu's block API is structured; raw_content discards headings and lists.
const languages = { 7: 'bash', 8: 'csharp', 9: 'cpp', 10: 'c', 12: 'css', 18: 'dockerfile', 22: 'go', 24: 'html', 28: 'json', 29: 'java', 30: 'javascript', 32: 'kotlin', 39: 'markdown', 43: 'php', 49: 'python', 52: 'ruby', 53: 'rust', 56: 'sql', 60: 'shell', 63: 'typescript', 66: 'xml', 67: 'yaml', 75: 'toml' };
export const hashBody = (raw) => splitFrontmatter(raw).body.replaceAll('\r\n', '\n').trim();

export function splitFrontmatter(raw) {
  const match = raw.match(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/);
  return { prefix: match?.[0] || '', body: match ? raw.slice(match[0].length) : raw };
}

function escapeText(value) {
  return value.replace(/[\\`*_{}\[\]<>#|~]/g, '\\$&').replace(/^(\s*)([-+] |\d+\. )/gm, '$1\\$2');
}

export function blocksToMarkdown(blocks, documentId, { imagePaths = new Map() } = {}) {
  const byId = new Map(blocks.map((block) => [block.block_id, block]));
  const warnings = new Set();
  function inline(elements = [], plain = false) {
    return elements.map((element) => {
      if (!element.text_run) {
        warnings.add('包含公式、提及或其他特殊行内内容，仅导入可读表示，禁止覆盖推送。');
        if (element.equation) return `$${element.equation.content}$`;
        if (element.mention_doc) return `[${escapeText(element.mention_doc.title || '文档')}](${element.mention_doc.url || ''})`;
        return escapeText(element.mention_user?.user_id ? `@${element.mention_user.user_id}` : '[特殊内容，请在飞书查看]');
      }
      const { content = '', text_element_style: style = {} } = element.text_run;
      if (plain) return content;
      if (style.comment_ids?.length || style.underline || style.background_color || style.text_color) warnings.add('包含评论或 Markdown 不支持的文字样式，禁止覆盖推送。');
      let text = escapeText(content);
      if (style.inline_code) {
        const fence = '`'.repeat(Math.max(1, ...(content.match(/`+/g) || []).map((x) => x.length + 1)));
        text = `${fence} ${content} ${fence}`;
      }
      if (style.bold) text = `**${text}**`;
      if (style.italic) text = `*${text}*`;
      if (style.strikethrough) text = `~~${text}~~`;
      if (style.link?.url) {
        let url = style.link.url;
        try { url = decodeURIComponent(url); } catch { /* Already decoded. */ }
        text = `[${text}](<${url.replaceAll('>', '%3E').replaceAll('<', '%3C')}>)`;
      }
      return text;
    }).join('');
  }
  const visited = new Set();
  function render(id) {
    if (visited.has(id)) throw new Error('飞书文档块出现循环引用。');
    visited.add(id);
    const block = byId.get(id);
    if (!block) throw new Error('飞书返回的文档块不完整，请重试。');
    const type = block.block_type;
    const key = type >= 3 && type <= 11 ? `heading${type - 2}` : ({ 2: 'text', 12: 'bullet', 13: 'ordered', 14: 'code', 15: 'quote', 17: 'todo' })[type];
    const children = () => (block.children || []).map(render).join('\n\n');
    if (block.source_synced || block.reference_synced) {
      warnings.add('同步块已展开为可读内容；为保留飞书引用关系，禁止覆盖推送，可另存为普通文档。');
      const reference = block.reference_synced;
      const link = reference?.source_document_id ? ` [查看源文档](https://my.feishu.cn/docx/${encodeURIComponent(reference.source_document_id)})` : '';
      if (block.sync_error) {
        warnings.add(`部分同步块读取失败：${block.sync_error}`);
        return `> 同步块内容读取失败：${escapeText(block.sync_error)}${link}`;
      }
      const title = block.source_synced ? inline(block.source_synced.elements) : '';
      return [title, children()].filter(Boolean).join('\n\n');
    }
    if (type === 27) {
      const token = block.image?.token;
      if (!token) { warnings.add('图片缺少素材标识，禁止覆盖推送。'); return '> [图片尚未上传或无法读取]'; }
      const source = imagePaths.get(token) || `feishu-image:${encodeURIComponent(token)}`;
      return `![图片](<${source.replaceAll('<', '%3C').replaceAll('>', '%3E')}>)`;
    }
    if (type === 1 || type === 32) return children();
    if (type === 31) {
      const prop = block.table.property;
      if (prop.merge_info?.some((cell) => cell.row_span > 1 || cell.col_span > 1)) warnings.add('合并单元格以普通表格导入，禁止覆盖推送。');
      const cells = (block.children || block.table.cells || []).map((cell) => render(cell).replaceAll('\n', '<br>'));
      const rows = [];
      for (let i = 0; i < cells.length; i += prop.column_size) rows.push(`| ${cells.slice(i, i + prop.column_size).join(' | ')} |`);
      rows.splice(1, 0, `| ${Array(prop.column_size).fill('---').join(' | ')} |`);
      return rows.join('\n');
    }
    if (key) {
      const value = block[key];
      let text = inline(value.elements, type === 14);
      if (type >= 3 && type <= 11) {
        if (type > 8) warnings.add('七至九级标题降为六级，禁止覆盖推送。');
        text = `${'#'.repeat(Math.min(type - 2, 6))} ${text}`;
      }
      if (type === 12) text = `- ${text}`;
      if (type === 13) text = `${/^\d+$/.test(value.style?.sequence) ? value.style.sequence : '1'}. ${text}`;
      if (type === 17) text = `- [${value.style?.done ? 'x' : ' '}] ${text}`;
      if (type === 15) text = text.split('\n').map((line) => `> ${line}`).join('\n');
      if (type === 14) {
        if (value.style?.language > 1 && !languages[value.style.language]) warnings.add('代码语言暂未映射，禁止覆盖推送。');
        const fence = '`'.repeat(Math.max(3, ...(text.match(/`+/g) || []).map((x) => x.length + 1)));
        text = `${fence}${languages[value.style?.language] || ''}\n${text}\n${fence}`;
      }
      const nested = children();
      if (nested) text += '\n\n' + ([12, 13, 17].includes(type) ? nested.split('\n').map((line) => `    ${line}`).join('\n') : nested);
      return text;
    }
    if (type === 22) return '---';
    if (type === 34) return children().split('\n').map((line) => `> ${line}`).join('\n');
    warnings.add(`包含暂不支持完整转换的飞书内容（块类型 ${type}），禁止覆盖推送。`);
    return `> [此处包含飞书专有内容，请在原文查看]\n\n${children()}`;
  }
  const markdown = render(documentId).trim() + '\n';
  return { markdown, warnings: [...warnings] };
}

export function prepareConverted(data, { allowImages = false } = {}) {
  if (!Array.isArray(data.blocks) || !Array.isArray(data.first_level_block_ids) || !data.first_level_block_ids.length) throw new Error('飞书没有返回有效的 Markdown 转换结果。');
  if (!allowImages && data.blocks.some((b) => b.block_type === 27)) throw new Error('图片必须先读取本地文件，并在创建图片块后上传。');
  if (data.blocks.length > 1000) throw new Error('当前笔记超过 1000 个文档块，请拆分后推送。');
  return { children_id: data.first_level_block_ids, descendants: data.blocks.map((value) => {
    const block = structuredClone(value);
    delete block.parent_id;
    if (block.block_type === 27) block.image = {};
    if (block.table) {
      delete block.table.merge_info;
      delete block.table.property?.merge_info;
    }
    return block;
  }), index: 0 };
}
