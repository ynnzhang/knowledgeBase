import { isDeepStrictEqual } from 'node:util';

// Keep original API blocks intact for write verification and recovery. Expand
// references into a separate rendering tree, with unique IDs per occurrence.
export async function expandSyncedBlocks(client, blocks, documentId) {
  const rendered = [], sources = new Map();
  let serial = 0, incomplete = false;
  const local = new Map(blocks.map((block) => [block.block_id, block]));
  async function source(doc, id) {
    if (doc === documentId && local.has(id)) return local;
    const key = `${doc}:${id}`;
    if (!sources.has(key)) {
      const endpoint = `/docx/v1/documents/${encodeURIComponent(doc)}/blocks/${encodeURIComponent(id)}/children`;
      const query = { document_revision_id: '-1', with_descendants: 'true', page_size: '500' };
      // Referenced blocks can be readable without metadata access to their
      // source document. Verify the subtree itself across paginated reads.
      const items = await client.list(endpoint, query);
      const after = await client.list(endpoint, query);
      if (!isDeepStrictEqual(items, after)) throw new Error('源同步块正在编辑，请稍后重新拉取。');
      sources.set(key, new Map(items.map((block) => [block.block_id, block])));
    }
    return sources.get(key);
  }
  async function visit(id, doc, byId, prefix, stack, depth = 0) {
    const key = `${doc}:${id}`;
    if (stack.has(key) || depth > 12) throw new Error('同步块存在循环引用或嵌套过深。');
    if (rendered.length >= 20000) throw new Error('同步块内容过多，请拆分后拉取。');
    const original = byId.get(id);
    if (!original) throw new Error('同步块内容不完整，请检查源文档权限后重新拉取。');
    const block = structuredClone(original), next = new Set(stack).add(key);
    block.block_id = prefix + id;
    rendered.push(block);
    const reference = block.reference_synced;
    if (reference) {
      const start = rendered.length;
      try {
        const { source_document_id: sourceDoc, source_block_id: sourceId } = reference;
        if (!sourceDoc || !sourceId) throw new Error('缺少同步块源地址，请在飞书检查引用。');
        const sourceKey = `${sourceDoc}:${sourceId}`;
        if (next.has(sourceKey)) throw new Error('同步块存在循环引用。');
        const bySourceId = await source(sourceDoc, sourceId), root = bySourceId.get(sourceId);
        if (!root?.source_synced) throw new Error('同步块源内容不可用，请检查源文档授权。');
        const sourceStack = new Set(next).add(sourceKey), sourcePrefix = `ref${++serial}:`;
        block.children = [];
        for (const child of root.children || []) block.children.push(await visit(child, sourceDoc, bySourceId, sourcePrefix, sourceStack, depth + 1));
      } catch (error) {
        rendered.splice(start);
        block.children = []; block.sync_error = error.message; incomplete = true;
      }
    } else {
      block.children = [];
      for (const child of original.children || original.table?.cells || []) block.children.push(await visit(child, doc, byId, prefix, next, depth));
    }
    return block.block_id;
  }
  await visit(documentId, documentId, local, '', new Set());
  return { renderBlocks: rendered, incomplete };
}
