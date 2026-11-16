import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { isValidKey, type StorageAdapter } from './adapter.js';

/** Local-FS storage for dev/tests, with HMAC-signed, expiring read URLs served by `registerMediaRoute`. */
export class LocalFsStorage implements StorageAdapter {
  private readonly root: string;

  constructor(
    rootDir: string,
    private readonly secret: string,
    private readonly now: () => number = Date.now,
  ) {
    this.root = resolve(rootDir);
  }

  private path(key: string) {
    if (!isValidKey(key)) throw new Error('invalid storage key');
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root + sep)) throw new Error('invalid storage key');
    return p;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data);
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  private sign(key: string, exp: number) {
    return createHmac('sha256', this.secret).update(`${key}.${exp}`).digest('base64url');
  }

  async readUrl(key: string, ttlSeconds: number): Promise<string> {
    const exp = Math.floor(this.now() / 1000) + ttlSeconds;
    return `/media/${key}?exp=${exp}&sig=${this.sign(key, exp)}`;
  }

  /** Verifies signature + expiry, then returns the bytes (null = invalid/expired/missing). */
  async readSigned(key: string, exp: number, sig: string): Promise<Buffer | null> {
    if (!isValidKey(key) || !Number.isFinite(exp) || exp * 1000 < this.now()) return null;
    const expected = Buffer.from(this.sign(key, exp));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    return readFile(this.path(key)).catch(() => null);
  }
}

export function registerMediaRoute(app: FastifyInstance, storage: LocalFsStorage) {
  app.get('/media/*', async (req, reply) => {
    const key = (req.params as { '*': string })['*'];
    const q = req.query as { exp?: string; sig?: string };
    const data = await storage.readSigned(key, Number(q.exp), q.sig ?? '');
    if (!data) return reply.status(404).send();
    return reply
      .header('content-type', 'image/jpeg')
      .header('cache-control', 'private, max-age=300')
      .header('x-content-type-options', 'nosniff')
      .send(data);
  });
}
