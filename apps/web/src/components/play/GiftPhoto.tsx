import { useEffect, useMemo, useState } from 'react';

/** Server-provided photo URL only (same-origin or HTTPS); never a DOM/user-derived value. */
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
}: {
  src: string | null | undefined;
  alt: string;
  className: string;
  testId?: string;
  loading?: 'eager' | 'lazy';
}) {
  const url = useMemo(() => safePhotoUrl(src), [src]);
  const [failedUrl, setFailedUrl] = useState<string>();
  const [loadedUrl, setLoadedUrl] = useState<string>();

  if (!url || failedUrl === url) return null;
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
    if (typeof URL.createObjectURL !== 'function') return;
    try {
      const next = URL.createObjectURL(file);
      setUrl(next);
      return () => URL.revokeObjectURL(next);
    } catch {
      setUrl(undefined);
    }
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
