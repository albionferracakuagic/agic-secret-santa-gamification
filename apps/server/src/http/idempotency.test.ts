import { describe, expect, it } from 'vitest';
import { createTestDb } from '@santa/db/testing';
import { buildApp } from '../app.js';
import { DbIdempotencyStore, purgeExpiredIdempotencyKeys } from './idempotency-db.js';

const post = (app: ReturnType<typeof buildApp>, key: string | undefined, body: unknown) =>
  app.inject({
    method: 'POST',
    url: '/api/test/echo',
    payload: body as object,
    headers: key ? { 'idempotency-key': key, cookie: 'sg_p=abc' } : { cookie: 'sg_p=abc' },
  });

function makeApp() {
  const app = buildApp();
  let calls = 0;
  app.post('/api/test/echo', async (req) => ({ n: ++calls, body: req.body }));
  return { app, calls: () => calls };
}

describe('idempotency middleware', () => {
  it('requires a key on mutations', async () => {
    const { app } = makeApp();
    const res = await post(app, undefined, { a: 1 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('idempotency_key_required');
  });

  it('replays the stored response for the same key + request (handler runs once)', async () => {
    const { app, calls } = makeApp();
    const first = await post(app, 'key-12345678', { a: 1 });
    const second = await post(app, 'key-12345678', { a: 1 });
    expect(first.json()).toEqual(second.json());
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(calls()).toBe(1);
  });

  it('rejects the same key with a different payload; a fresh key executes again', async () => {
    const { app, calls } = makeApp();
    await post(app, 'key-12345678', { a: 1 });
    expect((await post(app, 'key-12345678', { a: 2 })).statusCode).toBe(422);
    await post(app, 'key-87654321', { a: 1 });
    expect(calls()).toBe(2);
  });

  it('state APIs are no-store', async () => {
    const { app } = makeApp();
    const res = await post(app, 'key-12345678', {});
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('DB-backed idempotency store', () => {
  const NOW = () => Date.now();
  it('a stored response is replayed after a restart (new app instance, same database)', async () => {
    const db = await createTestDb();
    let calls = 0;
    const boot = () => {
      const app = buildApp({ db, organizerSessions: undefined as never });
      app.post('/api/test/echo', async () => ({ n: ++calls }));
      return app;
    };
    const first = boot();
    const a = await post(first, 'key-restart-1', { a: 1 });
    await first.close();
    const second = boot();
    const b = await post(second, 'key-restart-1', { a: 1 });
    expect(b.json()).toEqual(a.json());
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(calls).toBe(1);
    expect((await post(second, 'key-restart-1', { a: 2 })).statusCode).toBe(422);
    await second.close();
  });

  it('claim is atomic: exactly one of many concurrent callers wins', async () => {
    const store = new DbIdempotencyStore(await createTestDb());
    const entry = { fingerprint: 'f', state: 'inflight' as const, expiresAt: NOW() + 60_000 };
    const wins = await Promise.all(Array.from({ length: 10 }, () => store.claim('k', entry)));
    expect(wins.filter(Boolean)).toHaveLength(1);
  });

  it('expired keys can be claimed again and are purged', async () => {
    const db = await createTestDb();
    const store = new DbIdempotencyStore(db);
    expect(
      await store.claim('k', { fingerprint: 'a', state: 'inflight', expiresAt: NOW() - 1000 }),
    ).toBe(true);
    expect(
      await store.claim('k', { fingerprint: 'b', state: 'inflight', expiresAt: NOW() + 60_000 }),
    ).toBe(true);
    expect((await store.get('k'))?.fingerprint).toBe('b');
    await store.set('old', {
      fingerprint: 'x',
      state: 'done',
      status: 200,
      body: '{}',
      expiresAt: NOW() - 5000,
    });
    await purgeExpiredIdempotencyKeys(db);
    expect(await store.get('old')).toBeUndefined();
    expect(await store.get('k')).toBeDefined();
  });
});
