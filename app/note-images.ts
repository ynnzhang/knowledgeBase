const PASSTHROUGH_IMAGE_SOURCE = /^(?:https?:|data:|blob:)/i;

export function resolveNoteImageUrl(notePath: string, imageSource?: string) {
  if (!imageSource || PASSTHROUGH_IMAGE_SOURCE.test(imageSource) || imageSource.startsWith('/local-api/')) {
    return imageSource || '';
  }
  const query = new URLSearchParams({ notePath, src: imageSource });
  return `/local-api/assets?${query.toString()}`;
}

export async function uploadNoteImage(notePath: string, image: File) {
  const query = new URLSearchParams({ notePath });
  const response = await fetch(`/local-api/notes/images?${query.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': image.type || 'application/octet-stream' },
    body: image,
  });
  const result = (await response.json()) as { url?: string; error?: string };
  if (!response.ok || !result.url) throw new Error(result.error || '图片保存失败。');
  return result.url;
}
