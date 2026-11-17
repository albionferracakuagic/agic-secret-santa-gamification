import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../app.js';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'santa-web-'));
  await mkdir(join(dir, 'assets'));
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>Santa SPA</title>');
  await writeFile(join(dir, 'sw.js'), '// sw');
  await writeFile(join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('SPA serving', () => {
  it('serves index.html for client routes and keeps API/socket/media paths out of the fallback', async () => {
    const app = buildApp({ webDist: dir });
    for (const url of ['/', '/o', '/e/abc', '/d', '/j?code=ABCDEFGHJK']) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode, url).toBe(200);
      expect(r.body).toContain('Santa SPA');
      expect(r.headers['cache-control']).toBe('no-cache');
    }
    for (const url of ['/api/nope', '/media/x.jpg', '/socket.io/x', '/health/x']) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode, url).toBe(404);
      expect(r.json().error.code).toBe('not_found');
    }
    expect((await app.inject({ method: 'POST', url: '/o' })).statusCode).toBe(404);
    await app.close();
  });

  it('hashed assets are immutable, the service worker and index are never cached', async () => {
    const app = buildApp({ webDist: dir });
    const asset = await app.inject({ method: 'GET', url: '/assets/app-abc123.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await app.inject({ method: 'GET', url: '/sw.js' })).headers['cache-control']).toBe(
      'no-cache',
    );
    await app.close();
  });

  it('static files and SPA routes are exempt from the per-IP limit, API routes are not', async () => {
    const app = buildApp({ webDist: dir, rateLimitMax: 3 });
    for (let i = 0; i < 20; i++)
      expect((await app.inject({ method: 'GET', url: '/assets/app-abc123.js' })).statusCode).toBe(
        200,
      );
    const codes: number[] = [];
    for (let i = 0; i < 6; i++)
      codes.push((await app.inject({ method: 'GET', url: '/health' })).statusCode);
    expect(codes).toContain(429);
    await app.close();
  });

  it('fails fast when WEB_DIST has no index.html', () => {
    expect(() => buildApp({ webDist: join(dir, 'assets') })).toThrow(/index\.html/);
  });

  it('API-only mode (no webDist) keeps JSON 404s', async () => {
    const app = buildApp();
    const r = await app.inject({ method: 'GET', url: '/o' });
    expect(r.statusCode).toBe(404);
    await app.close();
  });
});

describe('security headers', () => {
  it('CSP: self-only scripts, no eval, no framing, blob storage images allowed, wss for sockets', async () => {
    const app = buildApp({ cspImgSources: ['https://acct.blob.core.windows.net'] });
    const r = await app.inject({ method: 'GET', url: '/health' });
    const csp = String(r.headers['content-security-policy']);
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/unsafe-eval|script-src[^;]*unsafe-inline/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain('img-src');
    expect(csp).toContain('https://acct.blob.core.windows.net');
    expect(csp).toMatch(/connect-src[^;]*wss:/);
    expect(csp).not.toContain('upgrade-insecure-requests'); // dev/test only: plain-http localhost must work
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['referrer-policy']).toBeTruthy();
    await app.close();
  });

  it('production adds upgrade-insecure-requests and HSTS', async () => {
    const app = buildApp({ guardEnv: 'production' });
    const r = await app.inject({ method: 'GET', url: '/health' });
    expect(String(r.headers['content-security-policy'])).toContain('upgrade-insecure-requests');
    expect(r.headers['strict-transport-security']).toBeTruthy();
    await app.close();
  });
});
