import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { IDEMPOTENCY_HEADER, IdempotencyKeySchema } from '@santa/contracts';

export interface IdempotencyEntry {
  fingerprint: string;
  state: 'inflight' | 'done';
  status?: number;
  body?: string;
  contentType?: string;
  expiresAt: number;
}

/** Storage port. `claim` must be atomic: exactly one concurrent caller wins a missing/expired key. */
export interface IdempotencyStore {
  get(key: string): Promise<IdempotencyEntry | undefined>;
  claim(key: string, entry: IdempotencyEntry): Promise<boolean>;
  set(key: string, entry: IdempotencyEntry): Promise<void>;
  delete(key: string): Promise<void>;
}

/** In-memory store (tests, API-only dev). Production uses the DB-backed store so keys survive restarts. */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly m = new Map<string, IdempotencyEntry>();
  async get(key: string) {
    const e = this.m.get(key);
    if (e && e.expiresAt < Date.now()) {
      this.m.delete(key);
      return undefined;
    }
    return e;
  }
  async claim(key: string, entry: IdempotencyEntry) {
    if (await this.get(key)) return false;
    this.m.set(key, entry);
    return true;
  }
  async set(key: string, e: IdempotencyEntry) {
    this.m.set(key, e);
  }
  async delete(key: string) {
    this.m.delete(key);
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    idemKey?: string;
  }
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const err = (code: string, message: string) => ({ error: { code, message } });

/**
 * Mutations under /api/* (except /api/auth/*, handled by Better Auth) need an Idempotency-Key.
 * Same key + same request => stored response replayed; same key + different request => 422.
 */
export function registerIdempotency(
  app: FastifyInstance,
  opts: { store?: IdempotencyStore; ttlMs?: number; inflightTtlMs?: number } = {},
) {
  const store = opts.store ?? new MemoryIdempotencyStore();
  const ttl = opts.ttlMs ?? 24 * 3600_000;
  const inflightTtl = opts.inflightTtlMs ?? 60_000;

  app.addHook('preHandler', async (req, reply) => {
    if (SAFE.has(req.method) || !req.url.startsWith('/api/') || req.url.startsWith('/api/auth/'))
      return;
    const parsed = IdempotencyKeySchema.safeParse(req.headers[IDEMPOTENCY_HEADER]);
    if (!parsed.success) {
      return reply
        .status(400)
        .send(err('idempotency_key_required', 'Idempotency-Key header required'));
    }
    const scope = sha(String(req.headers.cookie ?? req.ip));
    const key = `${scope}:${parsed.data}`;
    const fingerprint = sha(`${req.method} ${req.url} ${JSON.stringify(req.body ?? null)}`);
    const claimed = await store.claim(key, {
      fingerprint,
      state: 'inflight',
      expiresAt: Date.now() + inflightTtl,
    });
    if (claimed) {
      req.idemKey = key;
      return;
    }
    const existing = await store.get(key);
    if (!existing) {
      // expired between claim and get: treat as a concurrent duplicate and let the client retry
      return reply.status(409).send(err('request_in_progress', 'Retry the request'));
    }
    if (existing.fingerprint !== fingerprint) {
      return reply
        .status(422)
        .send(err('idempotency_key_reused', 'Key already used for a different request'));
    }
    if (existing.state === 'inflight') {
      return reply
        .status(409)
        .send(err('request_in_progress', 'Original request still in progress'));
    }
    return reply
      .header('Idempotent-Replayed', 'true')
      .status(existing.status ?? 200)
      .type(existing.contentType ?? 'application/json')
      .send(existing.body ?? '');
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const key = req.idemKey;
    if (!key) return payload;
    const existing = await store.get(key);
    if (reply.statusCode >= 500 || !existing || typeof payload !== 'string') {
      await store.delete(key); // allow a retry after server errors
    } else {
      await store.set(key, {
        ...existing,
        state: 'done',
        status: reply.statusCode,
        body: payload,
        contentType: String(reply.getHeader('content-type') ?? 'application/json'),
        expiresAt: Date.now() + ttl,
      });
    }
    return payload;
  });
}
