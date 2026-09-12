import { createHash } from 'node:crypto';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { parseFragment } from 'parse5';

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const bytesHash = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function imageType(bytes) {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('图片为空或超过 20 MB，请压缩后重试。');
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return { mime: 'image/png', extension: '.png' };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mime: 'image/jpeg', extension: '.jpg' };
  if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString())) return { mime: 'image/gif', extension: '.gif' };
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return { mime: 'image/webp', extension: '.webp' };
  if (bytes.subarray(0, 2).toString() === 'BM') return { mime: 'image/bmp', extension: '.bmp' };
  throw new Error('图片格式暂不支持或返回的不是图片，请使用 PNG、JPEG、GIF、WebP 或 BMP。');
}

export async function imageResponse(response) {
  if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) { await response.body?.cancel(); throw new Error('飞书图片超过 20 MB，请压缩后重试。'); }
  const chunks = []; let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.length;
    if (size > MAX_IMAGE_BYTES) throw new Error('飞书图片超过 20 MB，请压缩后重试。');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  return { bytes, ...imageType(bytes) };
}

// Read image tags with an HTML parser so quoted '>', entities and comments work.
function htmlImages(node) {
  const images = [];
  function visit(element) {
    if (['pre', 'code', 'script', 'style', 'textarea', 'xmp', 'template'].includes(element.tagName)) return;
    if (element.tagName === 'img') {
      const attrs = Object.fromEntries(element.attrs.map(({ name, value }) => [name, value]));
      if (!attrs.src?.trim()) throw new Error('HTML 图片缺少 src 路径，请补充图片地址后推送。');
      const location = element.sourceCodeLocation;
      images.push({ source: attrs.src, alt: attrs.alt || '图片', html: true,
        start: node.position.start.offset + location.startOffset, end: node.position.start.offset + location.endOffset });
    }
    for (const child of element.childNodes || []) visit(child);
  }
  visit(parseFragment(node.value, { sourceCodeLocationInfo: true }));
  return images;
}

// Parse actual images, excluding code examples, comments and escaped text.
export function markdownImages(body) {
  const tree = fromMarkdown(body), definitions = new Map(), images = [];
  function visit(node, callback) { callback(node); for (const child of node.children || []) visit(child, callback); }
  visit(tree, (node) => { if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node); });
  visit(tree, (node) => {
    if (node.type === 'html' && /<img\b/i.test(node.value)) images.push(...htmlImages(node));
    if (node.type !== 'image' && node.type !== 'imageReference') return;
    const source = node.type === 'image' ? node.url : definitions.get(node.identifier)?.url;
    if (!source) throw new Error('图片引用缺少有效路径。');
    images.push({ source, start: node.position.start.offset, end: node.position.end.offset });
  });
  return images.sort((left, right) => left.start - right.start);
}

export async function prepareImageMarkdown(body, readImage) {
  const images = markdownImages(body), assets = new Map(), hashes = [];
  for (let index = 0; index < images.length; index++) {
    const item = images[index], bytes = await readImage(item.source);
    const type = imageType(bytes), marker = `zhixu-image-${index}${type.extension}`;
    assets.set(marker, { bytes, ...type, name: marker });
    hashes.push([item.source, bytesHash(bytes)]);
    item.marker = marker;
  }
  let markdown = body;
  for (const item of [...images].reverse()) {
    const alt = (item.alt || '图片').replace(/[\\\[\]]/g, '\\$&').replace(/[\r\n]+/g, ' ');
    const replacement = `![${alt}](${item.marker})`;
    // Blank lines make images inside HTML wrappers visible to Markdown conversion.
    markdown = markdown.slice(0, item.start) + (item.html ? `\n\n${replacement}\n\n` : replacement) + markdown.slice(item.end);
  }
  return { markdown, assets, assetHash: bytesHash(JSON.stringify(hashes)), convertedHtmlImages: images.filter((item) => item.html).length };
}
