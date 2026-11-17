import { randomUUID } from 'node:crypto';

/**
 * Blob storage port. Keys are server-generated and opaque (`gifts/<eventId>/<uuid>.jpg`): the original
 * filename never reaches storage. Reads are via short-lived signed URLs only.
 */
export interface StorageAdapter {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Short-lived read URL (local: HMAC-signed path; Azure: user-delegation SAS). */
  readUrl(key: string, ttlSeconds: number): Promise<string>;
}

export const newGiftPhotoKey = (eventId: string) => `gifts/${eventId}/${randomUUID()}.jpg`;

/** Keys must stay inside our namespace (also protects the local-FS adapter from path traversal). */
export const isValidKey = (key: string) =>
  /^[a-z0-9-]+(\/[a-z0-9-]+)*\/[a-z0-9-]+\.[a-z0-9]{2,5}$/.test(key);

export const PHOTO_URL_TTL_SECONDS = 600;
