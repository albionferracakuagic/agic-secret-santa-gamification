import { useEffect, useMemo, useState, type ReactNode } from 'react';

const PREVIEW_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

async function rasterizePreview(file: File): Promise<Blob | undefined> {
  if (!PREVIEW_IMAGE_TYPES.has(file.type) || typeof createImageBitmap !== 'function') {
    return undefined;
  }

  // MIME metadata is user-controlled. Require a raster signature before decoding, then
  // re-encode the decoded pixels so the preview URL never points at the original file.
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const isPng =
    header.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, i) => header[i] === byte);
  const isJpeg =
    header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  const isWebp =
    header.length >= 12 &&
    String.fromCharCode(...header.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...header.slice(8, 12)) === 'WEBP';
  if (
    (file.type === 'image/png' && !isPng) ||
    (file.type === 'image/jpeg' && !isJpeg) ||
    (file.type === 'image/webp' && !isWebp)
  ) {
    return undefined;
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return undefined;
  }

  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) return undefined;
    context.drawImage(bitmap, 0, 0);
    return await new Promise<Blob | undefined>((resolve) => {
      canvas.toBlob((blob) => resolve(blob?.type === 'image/png' ? blob : undefined), 'image/png');
    });
  } finally {
    bitmap.close();
  }
}

/** Server-provided photo URL only (same-origin or HTTPS). Blob URLs are reserved for local previews. */
export const safePhotoUrl = (src: string | null | undefined): string | undefined => {
  if (!src) return undefined;
  try {
    const url = new URL(src, window.location.origin);
    if (url.protocol === 'https:' || url.origin === window.location.origin) return url.href;
  } catch {
    // Unparsable: no photo.
  }
  return undefined;
};

/** Hides a photo immediately if its URL is unsafe or it cannot be decoded. */
export function GiftPhoto({
  src,
  alt,
  className,
  testId,
  loading,
  fallback,
}: {
  src: string | null | undefined;
  alt: string;
  className: string;
  testId?: string;
  loading?: 'eager' | 'lazy';
  fallback?: ReactNode;
}) {
  const url = useMemo(() => safePhotoUrl(src), [src]);
  const [failedUrl, setFailedUrl] = useState<string>();
  const [loadedUrl, setLoadedUrl] = useState<string>();

  if (!url || failedUrl === url) return fallback ?? null;
  return (
    <img
      src={url}
      alt={alt}
      className={className}
      data-testid={testId}
      loading={loading}
      hidden={loadedUrl !== url}
      onLoad={() => setLoadedUrl(url)}
      onError={() => setFailedUrl(url)}
    />
  );
}

/** Object URL backed preview for the selected File. The URL is always revoked on replacement/unmount. */
export function GiftPhotoPreview({
  file,
  alt,
  className,
}: {
  file: File;
  alt: string;
  className: string;
}) {
  const [url, setUrl] = useState<string>();
  const [failedUrl, setFailedUrl] = useState<string>();
  const [loadedUrl, setLoadedUrl] = useState<string>();

  useEffect(() => {
    let active = true;
    let previewUrl: string | undefined;
    setUrl(undefined);

    void rasterizePreview(file)
      .then((blob) => {
        if (!active || !blob || typeof URL.createObjectURL !== 'function') return;
        try {
          previewUrl = URL.createObjectURL(blob);
          setUrl(previewUrl);
        } catch {
          setUrl(undefined);
        }
      })
      .catch(() => {
        if (active) setUrl(undefined);
      });

    return () => {
      active = false;
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [file]);

  if (!url || failedUrl === url) return null;
  return (
    <img
      src={url}
      alt={alt}
      className={className}
      data-testid="gift-photo-preview"
      hidden={loadedUrl !== url}
      onLoad={() => setLoadedUrl(url)}
      onError={() => setFailedUrl(url)}
    />
  );
}
