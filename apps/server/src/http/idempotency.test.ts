import { describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';

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
