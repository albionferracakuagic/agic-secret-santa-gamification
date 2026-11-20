import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { user } from '@santa/db';
import { createTestDb, type TestDb } from '@santa/db/testing';
import { buildApp } from '../app.js';
import { createAuth } from './auth.js';
import { MemoryEmailTransport } from './email.js';
import { loadEnv, socialFromEnv } from './config.js';
import { createAuthModule } from './routes.js';
import { trustedOrigins } from '../http/origins.js';

const BASE = 'http://localhost:3000';
const SECRET = 'test-secret-test-secret-test-secret-0000';

describe('organizer auth (magic link)', () => {
  let db: TestDb;
  let email: MemoryEmailTransport;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    db = await createTestDb();
    email = new MemoryEmailTransport();
    const auth = createAuth({
      db,
      baseURL: BASE,
      secret: SECRET,
      email,
      rateLimit: { window: 60, max: 1000, magicLink: { window: 60, max: 4 } },
    });
    app = buildApp({ db, auth: createAuthModule(auth, db), guardEnv: 'test' });
    await app.ready();
  }, 60_000);
  afterAll(async () => {
    await app.close();
  });

  const requestLink = (address: string) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/magic-link',
      headers: { origin: BASE, 'content-type': 'application/json' },
      payload: { email: address },
    });

  it('full flow: request link -> console/memory transport -> verify -> session -> organizer API', async () => {
    const res = await requestLink('Organizer@Example.test');
    expect(res.statusCode).toBe(200);
    expect(email.sent).toHaveLength(1);
    const link = /Sign in: (\S+)/.exec(email.sent[0]!.text)![1]!;
    const url = new URL(link);

    const verify = await app.inject({
      method: 'GET',
      url: url.pathname + url.search,
      headers: { origin: BASE },
    });
    expect(verify.statusCode).toBe(302);
    const setCookie = ([] as string[]).concat(verify.headers['set-cookie'] ?? []);
    const session = setCookie.find((c) => c.startsWith('sg.session_token='));
    expect(session, 'session cookie set').toBeDefined();
    expect(session).toMatch(/HttpOnly/i);
    const cookie = session!.split(';')[0]!;

    const me = await app.inject({ method: 'GET', url: '/api/organizer/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ email: 'organizer@example.test', isPlatformAdmin: false });
    expect(me.headers['cache-control']).toBe('no-store');

    // single use
    const again = await app.inject({ method: 'GET', url: url.pathname + url.search });
    expect(again.headers['set-cookie']).toBeUndefined();

    // platform-admin flag gates admin routes; clients cannot set it
    expect(
      (await app.inject({ method: 'GET', url: '/api/admin/ping', headers: { cookie } })).statusCode,
    ).toBe(403);
    await db
      .update(user)
      .set({ isPlatformAdmin: true })
      .where(eq(user.email, 'organizer@example.test'));
    expect(
      (await app.inject({ method: 'GET', url: '/api/admin/ping', headers: { cookie } })).statusCode,
    ).toBe(200);
  });

  it('unauthenticated organizer routes return 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/organizer/me' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/admin/ping' })).statusCode).toBe(401);
  });

  it('rate-limits magic-link requests', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await requestLink(`spam${i}@example.test`)).statusCode);
    expect(codes).toContain(429);
  });

  it('keeps the Better Auth session cookie on an approved ngrok HTTPS origin', async () => {
    const origin = 'https://foo.ngrok-free.app';
    const tunnelEmail = new MemoryEmailTransport();
    const tunnelAuth = createAuth({
      db,
      baseURL: BASE,
      trustedOrigins: (request) => trustedOrigins(request, BASE, [], 'test'),
      secret: SECRET,
      email: tunnelEmail,
    });
    const tunnelApp = buildApp({
      db,
      auth: createAuthModule(tunnelAuth, db),
      baseUrl: BASE,
      guardEnv: 'test',
    });
    try {
      const sent = await tunnelApp.inject({
        method: 'POST',
        url: '/api/auth/sign-in/magic-link',
        headers: {
          origin,
          host: 'localhost:3000',
          'x-forwarded-host': 'foo.ngrok-free.app',
          'x-forwarded-proto': 'https',
          'content-type': 'application/json',
        },
        payload: { email: 'tunnel@example.test', callbackURL: '/o' },
      });
      expect(sent.statusCode).toBe(200);
      const link = /Sign in: (\S+)/.exec(tunnelEmail.sent[0]!.text)![1]!;
      const url = new URL(link);
      const verified = await tunnelApp.inject({
        method: 'GET',
        url: url.pathname + url.search,
        headers: {
          origin,
          host: 'localhost:3000',
          'x-forwarded-host': 'foo.ngrok-free.app',
          'x-forwarded-proto': 'https',
        },
      });
      expect(verified.statusCode).toBe(302);
      const cookies = ([] as string[]).concat(verified.headers['set-cookie'] ?? []);
      const session = cookies.find((c) => c.includes('session_token='))!;
      expect(session).toMatch(/HttpOnly/i);
      expect(session).toMatch(/Secure/i);
      expect(session).toMatch(/SameSite=Lax/i);
      expect(session).toMatch(/Path=\//i);
      expect(session).not.toMatch(/Domain=/i);
      const cookie = session.split(';')[0]!;
      expect(
        (
          await tunnelApp.inject({
            method: 'GET',
            url: '/api/organizer/me',
            headers: { cookie, origin, 'x-forwarded-proto': 'https' },
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      await tunnelApp.close();
    }
  });
});

describe('auth config', () => {
  it('social providers are enabled only when env credentials exist', () => {
    expect(socialFromEnv(loadEnv({ NODE_ENV: 'test' }))).toEqual({
      google: undefined,
      microsoft: undefined,
    });
    const s = socialFromEnv(
      loadEnv({
        NODE_ENV: 'test',
        GOOGLE_CLIENT_ID: 'g',
        GOOGLE_CLIENT_SECRET: 's',
        MICROSOFT_CLIENT_ID: 'm',
        MICROSOFT_CLIENT_SECRET: 's2',
        MICROSOFT_TENANT_ID: 'common',
      }),
    );
    expect(s.google).toMatchObject({ clientId: 'g' });
    expect(s.microsoft).toMatchObject({ clientId: 'm', tenantId: 'common' });
  });

  it('production requires secret and database', () => {
    expect(() => loadEnv({ NODE_ENV: 'production' })).toThrow();
  });
});
