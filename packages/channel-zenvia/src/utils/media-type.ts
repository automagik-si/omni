import type { ContentType } from '@omni/core/types';

export function omniTypeForMime(mimeType: string | undefined): ContentType {
  if (mimeType?.startsWith('image/')) return 'image';
  if (mimeType?.startsWith('audio/')) return 'audio';
  if (mimeType?.startsWith('video/')) return 'video';
  return 'document';
}
