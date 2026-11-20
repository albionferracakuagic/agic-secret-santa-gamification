import { normalizeShortCode } from './shortCode';

/**
 * Keeps a projected join target canonical while rebasing it onto the browser's public origin.
 * Display-token routes are deliberately rejected.
 */
export function publicJoinUrl(
  projectedUrl: string | null | undefined,
  eventCode: string | null | undefined,
  publicOrigin: string,
): string {
  const code = normalizeShortCode(eventCode ?? '');
  if (projectedUrl) {
    try {
      const projected = new URL(projectedUrl, publicOrigin);
      if (projected.pathname === '/j' || /^\/j\/[^/]+\/?$/.test(projected.pathname)) {
        if (projected.pathname === '/j' && code) projected.searchParams.set('code', code);
        return new URL(
          `${projected.pathname}${projected.search}${projected.hash}`,
          publicOrigin,
        ).toString();
      }
    } catch {
      // Fall through to the public short-code route.
    }
  }

  const url = new URL('/j', publicOrigin);
  if (code) url.searchParams.set('code', code);
  return url.toString();
}
