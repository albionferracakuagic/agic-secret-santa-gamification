import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';

export interface CspOptions {
  /** Extra image origins (e.g. the private-blob SAS host `https://<account>.blob.core.windows.net`). */
  imgSources?: string[];
}

/**
 * Content-Security-Policy for the SPA + API (same origin). No inline script, no eval, no framing, no plugins.
 * `style-src 'unsafe-inline'` stays because React renders inline style attributes (FX layers); scripts do not.
 * `upgrade-insecure-requests` only in production, otherwise plain-http localhost e2e would break.
 */
export function cspDirectives(
  opts: CspOptions,
  env: 'development' | 'test' | 'production',
): Record<string, Iterable<string> | null> {
  return {
    'default-src': ["'self'"],
    'script-src': ["'self'"],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:', ...(opts.imgSources ?? [])],
    'media-src': ["'self'", 'blob:', 'data:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': ["'self'", 'ws:', 'wss:'],
    'worker-src': ["'self'"],
    'manifest-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
    'upgrade-insecure-requests': env === 'production' ? [] : null,
  };
}

/** Paths that must never fall back to index.html. */
export const API_PREFIX = /^\/(api|socket\.io|media|health)(\/|$)/;

/**
 * Serves the built SPA (apps/web/dist) with history fallback: unknown GET paths that are not API/socket/media
 * routes return index.html. Hashed assets are immutable; index.html and the service worker are never cached so
 * a deploy is picked up immediately. Non-API GETs (static files, SPA routes) are exempt from the per-IP rate limit in
 * app.ts: a venue shares one IP and every phone loads ~25 assets.
 * Returns the predicate deciding whether a path may fall back to index.html.
 */
export function registerWeb(app: FastifyInstance, root: string): (path: string) => boolean {
  if (!existsSync(join(root, 'index.html'))) throw new Error(`WEB_DIST has no index.html: ${root}`);
  void app.register(fastifyStatic, {
    root,
    wildcard: true,
    index: ['index.html'],
    setHeaders(reply, filePath) {
      const immutable = /[\\/]assets[\\/]/.test(filePath);
      reply.header('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });
  return (path: string) => !API_PREFIX.test(path.split('?')[0] ?? '');
}
