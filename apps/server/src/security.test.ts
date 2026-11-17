import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { eventAccess, user } from '@santa/db';
import { io } from 'socket.io-client';
import { allowedOrigin, buildApp } from './app.js';
import { loadEnv } from './auth/config.js';
import { ConsoleEmailTransport } from './auth/email.js';
import { AcsEmailTransport, type AcsSender } from './auth/email-acs.js';
import { createEmailTransport } from './auth/email-factory.js';
import { TRUSTED_IP_HEADER } from './auth/auth.js';
import { toHeaders } from './auth/routes.js';
import { hashToken } from './tokens.js';
import { connected, createWorld } from './testing/world.js';

const PROD = {
  NODE_ENV: 'production',
  BETTER_AUTH_SECRET: 'x'.repeat(40),
  DATABASE_URL: 'postgres://u:p@h/db',
} as const;
const ACS = {
  EMAIL_TRANSPORT: 'acs',
  ACS_ENDPOINT: 'https://acs-test.europe.communication.azure.com',
  ACS_SENDER_ADDRESS: 'noreply@example.test',
} as const;

describe('proxy trust', () => {
  const ipOf = async (hops: number, xff: string) => {
    const app = buildApp({ trustProxyHops: hops });
    app.get('/ip', async (req) => ({ ip: req.ip }));
    const res = await app.inject({
      method: 'GET',
      url: '/ip',
      remoteAddress: '10.0.0.1',
      headers: { 'x-forwarded-for': xff },
    });
    await app.close();
    return res.json().ip as string;
  };

  it('one trusted hop: only the address the proxy appended counts, a forged leftmost entry is ignored', async () => {
    expect(await ipOf(1, '6.6.6.6, 9.9.9.9')).toBe('9.9.9.9');
    expect(await ipOf(1, '1.1.1.1, 2.2.2.2, 9.9.9.9')).toBe('9.9.9.9');
  });

  it('zero hops: X-Forwarded-For is never trusted', async () => {
    expect(await ipOf(0, '6.6.6.6')).toBe('10.0.0.1');
  });

  it('rotating a forged X-Forwarded-For does not escape the per-IP limit', async () => {
    const w = await createWorld();
    try {
      const codes: number[] = [];
      for (let i = 0; i < 25; i++) {
        const r = await w.app.inject({
          method: 'POST',
          url: '/api/join/resolve',
          payload: { shortCode: 'AAAAAAAAAA' },
          remoteAddress: '10.0.0.1',
          headers: {
            'x-forwarded-for': `6.6.6.${i}, 9.9.9.9`,
            'idempotency-key': `spoof-${i}-xxxxxxxx`,
          },
        });
        codes.push(r.statusCode);
      }
      expect(codes.slice(20)).toContain(429);
    } finally {
      await w.close();
    }
  });

  it('Better Auth only sees the trusted client IP header, never a client-supplied forwarding header', () => {
    const req = {
      ip: '9.9.9.9',
      headers: {
        'x-forwarded-for': '6.6.6.6',
        'x-real-ip': '7.7.7.7',
        [TRUSTED_IP_HEADER]: '8.8.8.8',
        cookie: 'a=b',
      },
    } as unknown as Parameters<typeof toHeaders>[0];
    const h = toHeaders(req);
    expect(h.get('x-forwarded-for')).toBeNull();
    expect(h.get('x-real-ip')).toBeNull();
    expect(h.get(TRUSTED_IP_HEADER)).toBe('9.9.9.9');
    expect(h.get('cookie')).toBe('a=b');
  });
});

describe('short join codes', () => {
  const resolver =
    (w: Awaited<ReturnType<typeof createWorld>>) => (payload: object, ip: string, i: number) =>
      w.app.inject({
        method: 'POST',
        url: '/api/join/resolve',
        payload,
        remoteAddress: ip,
        headers: { 'idempotency-key': `sc-${i}-xxxxxxxx` },
      });

  it('are 10 characters, grouped input is accepted, old 6-8 character codes are rejected', async () => {
    const w = await createWorld();
    try {
      await w.db.insert(eventAccess).values({
        eventId: w.eventId,
        kind: 'join',
        tokenHash: hashToken('t-short'),
        shortCode: 'ABCDEFGHJK',
      });
      const resolve = resolver(w);
      expect((await resolve({ shortCode: 'ABCDEFGHJK' }, '10.3.0.1', 1)).statusCode).toBe(200);
      expect((await resolve({ shortCode: 'abcde-fghjk' }, '10.3.0.2', 2)).statusCode).toBe(200);
      expect((await resolve({ shortCode: 'ABCDEFG' }, '10.3.0.3', 3)).statusCode).toBe(400);
      const [row] = await w.db
        .select()
        .from(eventAccess)
        .where(eq(eventAccess.tokenHash, hashToken('t-short')));
      expect(row!.shortCode).toHaveLength(10);
    } finally {
      await w.close();
    }
  });

  it('a hammered code locks for everyone (any IP); the QR token path keeps working', async () => {
    const w = await createWorld({
      joinRateLimits: { resolve: 1000, claim: 1000 },
      shortCodeLimits: { perCodeMax: 5, lockMs: 60_000 },
    });
    try {
      await w.db.insert(eventAccess).values({
        eventId: w.eventId,
        kind: 'join',
        tokenHash: hashToken('t-q'),
        shortCode: 'QQQQQQQQQQ',
      });
      const resolve = resolver(w);
      const statuses: number[] = [];
      for (let i = 0; i < 8; i++)
        statuses.push((await resolve({ shortCode: 'QQQQQQQQQQ' }, `10.1.0.${i}`, i)).statusCode);
      expect(statuses.slice(0, 5).every((s) => s === 200)).toBe(true);
      expect(statuses.slice(5).every((s) => s === 429)).toBe(true);
      expect((await resolve({ joinToken: 'y'.repeat(25) }, '10.1.1.1', 99)).statusCode).toBe(404);
    } finally {
      await w.close();
    }
  });

  it('a global run of failed guesses locks short-code lookups, valid codes included', async () => {
    const w = await createWorld({
      joinRateLimits: { resolve: 1000, claim: 1000 },
      shortCodeLimits: { globalFailMax: 5, lockMs: 60_000 },
    });
    try {
      await w.db.insert(eventAccess).values({
        eventId: w.eventId,
        kind: 'join',
        tokenHash: hashToken('t-g'),
        shortCode: 'GGGGGGGGGG',
      });
      const resolve = resolver(w);
      for (let i = 0; i < 6; i++)
        expect(
          (await resolve({ shortCode: `ZZZZZZZZZ${'ABCDEF'[i]}` }, `10.2.0.${i}`, i)).statusCode,
        ).toBe(404);
      expect((await resolve({ shortCode: 'GGGGGGGGGG' }, '10.2.0.50', 50)).statusCode).toBe(429);
    } finally {
      await w.close();
    }
  });
});

describe('production email transport', () => {
  const saved = process.env['NODE_ENV'];
  afterEach(() => {
    process.env['NODE_ENV'] = saved;
    vi.restoreAllMocks();
  });

  it('startup fails in production with the console transport or incomplete ACS config', () => {
    expect(() => loadEnv({ ...PROD })).toThrow(/EMAIL_TRANSPORT=acs/);
    expect(() => loadEnv({ ...PROD, EMAIL_TRANSPORT: 'acs' })).toThrow(/ACS_ENDPOINT/);
    expect(loadEnv({ ...PROD, ...ACS }).EMAIL_TRANSPORT).toBe('acs');
    expect(loadEnv({ NODE_ENV: 'development' }).EMAIL_TRANSPORT).toBe('console');
  });

  it('the console transport cannot even be constructed in production (defence in depth)', () => {
    const env = { ...loadEnv({ NODE_ENV: 'development' }), NODE_ENV: 'production' as const };
    expect(() => createEmailTransport(env)).toThrow(/not allowed in production/);
    process.env['NODE_ENV'] = 'production';
    expect(() => new ConsoleEmailTransport()).toThrow(/production/);
  });

  it('the factory returns the ACS transport when configured and delivers through the sender', async () => {
    const beginSend = vi.fn(async () => ({ pollUntilDone: async () => ({ status: 'Succeeded' }) }));
    const sender: AcsSender = { beginSend };
    const t = createEmailTransport(loadEnv({ ...PROD, ...ACS }), sender);
    expect(t).toBeInstanceOf(AcsEmailTransport);
    await t.send({ to: 'a@example.test', subject: 'Hi', text: 'link' });
    expect(beginSend).toHaveBeenCalledWith({
      senderAddress: 'noreply@example.test',
      recipients: { to: [{ address: 'a@example.test' }] },
      content: { subject: 'Hi', plainText: 'link' },
    });
  });

  it('delivery failures throw without echoing the message body, link or recipient', async () => {
    const sender: AcsSender = {
      beginSend: async () => ({
        pollUntilDone: async () => ({ status: 'Failed', error: { message: 'boom' } }),
      }),
    };
    const t = new AcsEmailTransport(sender, 'noreply@example.test');
    const err = (await t
      .send({
        to: 'victim@example.test',
        subject: 'Magic',
        text: 'https://app.test/magic?token=SECRET123',
      })
      .catch((e: unknown) => e)) as Error;
    expect(err.message).toBe('ACS email failed: Failed');
    expect(`${err.message}${err.stack}`).not.toMatch(/SECRET123|victim@/);
  });

  it('the ACS transport never writes to the console', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const t = new AcsEmailTransport(
      { beginSend: async () => ({ pollUntilDone: async () => ({ status: 'Succeeded' }) }) },
      'noreply@example.test',
    );
    await t.send({ to: 'a@example.test', subject: 's', text: 'https://app.test/x?token=SECRET' });
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

describe('socket handshake origin check', () => {
  it('allowedOrigin: same origin and configured extras only; localhost only outside production', () => {
    const base = 'https://santa.example';
    expect(allowedOrigin('https://santa.example', base, [], 'production')).toBe(true);
    expect(allowedOrigin('https://evil.example', base, [], 'production')).toBe(false);
    expect(allowedOrigin('http://localhost:5173', base, [], 'production')).toBe(false);
    expect(allowedOrigin('http://localhost:5173', base, [], 'development')).toBe(true);
    expect(
      allowedOrigin('https://admin.example', base, ['https://admin.example'], 'production'),
    ).toBe(true);
    expect(allowedOrigin('https://santa.example.evil.example', base, [], 'production')).toBe(false);
  });

  it('a cross-site page cannot open a socket with the victim cookies; same-origin and non-browser clients can', async () => {
    const w = await createWorld({ baseUrl: 'https://santa.example' });
    try {
      const cookie = await w.guestCookie(0);
      const open = (origin?: string) =>
        io(`http://127.0.0.1:${w.port}`, {
          transports: ['websocket'],
          extraHeaders: { cookie, ...(origin ? { origin } : {}) },
          reconnection: false,
          forceNew: true,
        });
      const evil = open('https://evil.example');
      await expect(connected(evil)).rejects.toBeTruthy();
      evil.close();
      const same = open('https://santa.example');
      await connected(same);
      same.close();
      const nonBrowser = open();
      await connected(nonBrowser);
      nonBrowser.close();
    } finally {
      await w.close();
    }
  });
});
describe('platform admin bootstrap by verified email', () => {
  it('a listed email is admin only once verified; unlisted or unverified accounts are not', async () => {
    const w = await createWorld({ platformAdminEmails: ['STRANGER@example.test'] });
    try {
      let n = 0;
      const call = (userId: string) =>
        w.app.inject({
          method: 'POST',
          url: `/api/admin/events/${w.eventId}/restore`,
          payload: { reason: 'bootstrap check' },
          headers: {
            cookie: w.organizerCookie(userId, 's-adm'),
            'idempotency-key': `adm-${userId}-${++n}-xxxxxxxx`,
          },
        });
      expect((await call('stranger')).statusCode).toBe(403); // email not verified yet
      await w.db.update(user).set({ emailVerified: true }).where(eq(user.id, 'stranger'));
      expect((await call('stranger')).statusCode).toBe(200);
      expect((await call('demo-owner')).statusCode).toBe(403); // not listed
    } finally {
      await w.close();
    }
  });
});
