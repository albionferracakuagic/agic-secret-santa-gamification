import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { IDEMPOTENCY_HEADER, IdempotencyKeySchema } from '@santa/contracts';

interface Entry {
  fingerprint: string;
  state: 'inflight' | 'done';
  status?: number;
  body?: string;
  contentType?: string;
  expiresAt: number;
}

/** In-memory store (single replica MVP). Swap for a DB table before scale-out; XP is protected independently. */
export class MemoryIdempotencyStore {
  private readonly m = new Map<string, Entry>();
  get(key: string): Entry | undefined {
    const e = this.m.get(key);
    if (e && e.expiresAt < Date.now()) {
      this.m.delete(key);
      return undefined;
    }
    return e;
  }
  set(key: string, e: Entry) {
    this.m.set(key, e);
  }
  delete(key: string) {
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
  opts: { store?: MemoryIdempotencyStore; ttlMs?: number; inflightTtlMs?: number } = {},
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
    const existing = store.get(key);
    if (existing) {
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
    }
    store.set(key, { fingerprint, state: 'inflight', expiresAt: Date.now() + inflightTtl });
    req.idemKey = key;
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const key = req.idemKey;
    if (!key) return payload;
    const existing = store.get(key);
    if (reply.statusCode >= 500 || !existing || typeof payload !== 'string') {
      store.delete(key); // allow a retry after server errors
    } else {
      store.set(key, {
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
