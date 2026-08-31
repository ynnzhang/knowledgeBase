const PASSTHROUGH_IMAGE_SOURCE = /^(?:https?:|data:|blob:)/i;

function isLocalWorkspace() {
  return window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
}

function publishedAssetUrl(notePath: string, imageSource: string) {
  const source = imageSource.trim().replace(/^<|>$/g, '').split(/[?#]/, 1)[0];
  const baseParts = notePath.replaceAll('\\', '/').split('/').slice(0, -1);
  const sourceParts = source.replaceAll('\\', '/').replace(/^\.\//, '').split('/');
  const normalizedParts: string[] = [];
  for (const part of [...baseParts, ...sourceParts]) {
    if (!part || part === '.') continue;
    if (part === '..') normalizedParts.pop();
    else normalizedParts.push(part);
  }
  return `/note-assets/${normalizedParts.map(encodeURIComponent).join('/')}`;
}

export function resolveNoteImageUrl(notePath: string, imageSource?: string) {
  if (!imageSource || PASSTHROUGH_IMAGE_SOURCE.test(imageSource) || imageSource.startsWith('/local-api/') || imageSource.startsWith('/api/note-images')) {
    return imageSource || '';
  }
  if (!isLocalWorkspace()) return publishedAssetUrl(notePath, imageSource);
  const query = new URLSearchParams({ notePath, src: imageSource });
  return `/local-api/assets?${query.toString()}`;
}

export async function uploadNoteImage(notePath: string, image: File) {
  const query = new URLSearchParams({ notePath });
  const endpoint = isLocalWorkspace() ? '/local-api/notes/images' : '/api/note-images';
  const response = await fetch(`${endpoint}?${query.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': image.type || 'application/octet-stream' },
    body: image,
  });
  const responseText = await response.text();
  let result: { url?: string; error?: string } = {};
  if (responseText) {
    try {
      result = JSON.parse(responseText) as { url?: string; error?: string };
    } catch {
      result.error = response.ok ? '图片服务返回了无法识别的内容。' : `图片服务请求失败（${response.status}）。`;
    }
  }
  if (!response.ok || !result.url) throw new Error(result.error || '图片保存失败。');
  return result.url;
}
