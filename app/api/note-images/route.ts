import { env } from 'cloudflare:workers';

const IMAGE_EXTENSIONS = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
  ['image/avif', '.avif'],
  ['image/bmp', '.bmp'],
]);

function bucket() {
  return (env as unknown as { ASSETS: R2Bucket }).ASSETS;
}

export async function GET(request: Request) {
  const key = new URL(request.url).searchParams.get('key');
  if (!key) return Response.json({ error: '缺少图片标识。' }, { status: 400 });
  const object = await bucket().get(key);
  if (!object) return Response.json({ error: '图片不存在。' }, { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Cache-Control', 'private, max-age=31536000, immutable');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(object.body, { headers });
}

export async function POST(request: Request) {
  try {
    const contentType = (request.headers.get('content-type') || '').split(';', 1)[0].toLowerCase();
    const extension = IMAGE_EXTENSIONS.get(contentType);
    if (!extension) {
      return Response.json({ error: '只支持 PNG、JPEG、GIF、WebP、AVIF 和 BMP 图片。' }, { status: 415 });
    }
    const content = await request.arrayBuffer();
    if (!content.byteLength) return Response.json({ error: '没有收到图片内容。' }, { status: 400 });
    if (content.byteLength > 20_000_000) return Response.json({ error: '图片不能超过 20 MB。' }, { status: 413 });

    const notePath = new URL(request.url).searchParams.get('notePath') || 'note.md';
    const safeNotePath = notePath.replaceAll('\\', '/').replace(/[^a-zA-Z0-9._/-]+/g, '-').replace(/\.md(?:own)?$/i, '');
    const key = `notes/${safeNotePath}/${crypto.randomUUID()}${extension}`;
    await bucket().put(key, content, { httpMetadata: { contentType } });
    return Response.json({ url: `/api/note-images?key=${encodeURIComponent(key)}` });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : '图片保存失败。' },
      { status: 500 },
    );
  }
}
