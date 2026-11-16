import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { eventAccess, events, participants, xpLedger } from '@santa/db';
import { MemoryEmailTransport } from '../auth/email.js';
import { hashToken } from '../tokens.js';
import { collect, connected, createWorld, sleep, waitFor, type World } from '../testing/world.js';

let w: World;
let n = 0;
const email = new MemoryEmailTransport();
const OWNER = () => w.organizerCookie('demo-owner', 'sess-o');

beforeAll(async () => {
  w = await createWorld({
    email,
    baseUrl: 'https://santa.test',
    joinRateLimits: { resolve: 1000, claim: 1000 },
  });
}, 60_000);
afterAll(async () => {
  await w.close();
});

const req = (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  o: { body?: unknown; cookie?: string; ip?: string } = {},
) =>
  w.app.inject({
    method,
    url,
    ...(o.body === undefined ? {} : { payload: o.body as object }),
    ...(o.ip ? { remoteAddress: o.ip } : {}),
    headers: { 'idempotency-key': `j-${++n}-xxxxxxxx`, ...(o.cookie ? { cookie: o.cookie } : {}) },
  });
const cookieOf = (res: { cookies: Array<{ name: string; value: string }> }, name = 'sg_p') =>
  res.cookies.find((c) => c.name === name);
const ev = (s = '') => `/api/events/${w.eventId}${s}`;

async function roster(names: string[], withEmail = false) {
  const rows = await w.db
    .insert(participants)
    .values(
      names.map((displayName) => ({
        eventId: w.eventId,
        displayName,
        source: 'import' as const,
        ...(withEmail
          ? { email: `${displayName.toLowerCase().replace(/\s+/g, '.')}@example.test` }
          : {}),
      })),
    )
    .returning();
  return rows;
}
async function joinAccess() {
  const res = await req('POST', ev('/access'), {
    cookie: OWNER(),
    body: { kind: 'join', expiresInHours: 24 },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as {
    accessId: string;
    token: string;
    shortCode: string;
    path: string;
    expiresAt: string;
  };
}
const xpJoined = async (pid: string) =>
  (
    await w.db
      .select()
      .from(xpLedger)
      .where(and(eq(xpLedger.participantId, pid), eq(xpLedger.rewardKey, 'joined')))
  ).length;

describe('join links, short codes, resolve', () => {
  it('mints a 256-bit token + 7-char short code (hash-only storage); resolves by either; hides everything else', async () => {
    const [anna] = await roster(['Anna Pick']);
    const a = await joinAccess();
    expect(a.token.length).toBeGreaterThanOrEqual(43);
    expect(a.shortCode).toMatch(/^[A-Z2-9]{7}$/);
    expect(a.path).toBe(`/j/${a.token}`);
    const [row] = await w.db.select().from(eventAccess).where(eq(eventAccess.id, a.accessId));
    expect(row!.tokenHash).toBe(hashToken(a.token));
    expect(JSON.stringify(row)).not.toContain(a.token);

    for (const target of [{ joinToken: a.token }, { shortCode: a.shortCode }]) {
      const res = await req('POST', '/api/join/resolve', { body: target });
      expect(res.statusCode).toBe(200);
      const b = res.json();
      expect(b.event).toMatchObject({ joinOpen: true, defaultLocale: 'it' });
      expect(b.unclaimed).toContainEqual({ participantId: anna!.id, displayName: 'Anna Pick' });
      expect(JSON.stringify(b)).not.toMatch(/@|Giulia/); // no emails; active players are not listed
    }
    expect(
      (await req('POST', '/api/join/resolve', { body: { joinToken: 'x'.repeat(43) } })).statusCode,
    ).toBe(404);
    expect(
      (await req('POST', '/api/join/resolve', { body: { shortCode: 'abcdefg' } })).statusCode,
    ).toBe(400);
    expect((await req('POST', '/api/join/resolve', { body: {} })).statusCode).toBe(400);
  });

  it('revoked and expired access stop working; organizer-only creation', async () => {
    const a = await joinAccess();
    expect(
      (
        await req('POST', ev('/access'), {
          cookie: w.organizerCookie('stranger', 's'),
          body: { kind: 'join' },
        })
      ).statusCode,
    ).toBe(403);
    await w.db
      .update(eventAccess)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(eventAccess.id, a.accessId));
    expect(
      (await req('POST', '/api/join/resolve', { body: { shortCode: a.shortCode } })).statusCode,
    ).toBe(404);
    const b = await joinAccess();
    expect((await req('DELETE', ev(`/access/${b.accessId}`), { cookie: OWNER() })).statusCode).toBe(
      200,
    );
    expect(
      (await req('POST', '/api/join/resolve', { body: { joinToken: b.token } })).statusCode,
    ).toBe(404);
    expect((await req('DELETE', ev(`/access/${b.accessId}`), { cookie: OWNER() })).statusCode).toBe(
      404,
    );
  });

  it('public join endpoints are rate limited per IP (defaults: resolve 20/min, claim 10/min)', async () => {
    const strict = await createWorld(); // default limits
    try {
      const call = (url: string, body: unknown, i: number) =>
        strict.app.inject({
          method: 'POST',
          url,
          payload: body as object,
          remoteAddress: '10.9.9.9',
          headers: { 'idempotency-key': `rl-${url.length}-${i}-xxxxxxxx` },
        });
      const resolve: number[] = [];
      for (let i = 0; i < 25; i++)
        resolve.push((await call('/api/join/resolve', { shortCode: 'AAAAAAA' }, i)).statusCode);
      expect(resolve.slice(0, 20).every((c) => c === 404)).toBe(true);
      expect(resolve.slice(20)).toContain(429);

      const claim: number[] = [];
      for (let i = 0; i < 14; i++) {
        claim.push(
          (await call('/api/join/claim', { method: 'email_link', token: 'z'.repeat(40) }, i))
            .statusCode,
        );
      }
      expect(claim.slice(0, 10).every((c) => c === 401)).toBe(true); // wrong credential: generic 401
      expect(claim.slice(10)).toContain(429);
    } finally {
      await strict.close();
    }
  });
});

describe('claim paths', () => {
  it('(c) pick name -> pending (no access) -> second device refused -> organizer approves -> active, verified, XP +10 once', async () => {
    const [bruno] = await roster(['Bruno Pending']);
    const a = await joinAccess();
    const claim = { method: 'pick_name', target: { joinToken: a.token }, participantId: bruno!.id };
    const res = await req('POST', '/api/join/claim', { body: claim });
    expect(res.json()).toEqual({ status: 'pending', participantId: bruno!.id, verified: false });
    const c = cookieOf(res)!;
    expect(c).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });

    const me = await req('GET', '/api/me', { cookie: `sg_p=${c.value}` });
    expect(me.json()).toMatchObject({ status: 'pending', verified: false });
    // pending session cannot open sockets / read state
    await expect(connected(w.client(`sg_p=${c.value}`))).rejects.toThrow('unauthorized');
    expect(await xpJoined(bruno!.id)).toBe(0);

    const second = await req('POST', '/api/join/claim', { body: claim });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('already_claimed');

    expect(
      (
        await req('POST', ev(`/participants/${bruno!.id}/approve`), {
          cookie: w.organizerCookie('stranger', 's'),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await req('POST', ev(`/participants/${bruno!.id}/approve`), { cookie: OWNER() })).json(),
    ).toEqual({ participantId: bruno!.id, status: 'active' });
    expect((await req('GET', '/api/me', { cookie: `sg_p=${c.value}` })).json()).toMatchObject({
      status: 'active',
      verified: true,
    });
    await connected(w.client(`sg_p=${c.value}`)); // now a real principal
    expect(await xpJoined(bruno!.id)).toBe(1);
    await req('POST', ev(`/participants/${bruno!.id}/approve`), { cookie: OWNER() });
    expect(await xpJoined(bruno!.id)).toBe(1); // idempotent
  });

  it('auto-approve toggle: base access only (verified=false), XP awarded', async () => {
    await w.app.inject({
      method: 'PATCH',
      url: ev(),
      payload: { settings: { features: { autoApproveJoin: true } } },
      headers: { cookie: OWNER(), 'idempotency-key': 'auto-xxxxxxxx' },
    });
    const [carla] = await roster(['Carla Auto']);
    const a = await joinAccess();
    const res = await req('POST', '/api/join/claim', {
      body: { method: 'pick_name', target: { shortCode: a.shortCode }, participantId: carla!.id },
    });
    expect(res.json()).toEqual({ status: 'active', participantId: carla!.id, verified: false });
    expect(
      (await req('GET', '/api/me', { cookie: `sg_p=${cookieOf(res)!.value}` })).json().verified,
    ).toBe(false);
    expect(await xpJoined(carla!.id)).toBe(1);
    await w.app.inject({
      method: 'PATCH',
      url: ev(),
      payload: { settings: { features: { autoApproveJoin: false } } },
      headers: { cookie: OWNER(), 'idempotency-key': 'auto2-xxxxxxxx' },
    });
  });

  it('(b) personal codes: one-time printable list, verified claim, single use, scoped to the event', async () => {
    const [dino, elsa] = await roster(['Dino Code', 'Elsa Code']);
    const list = (await req('POST', ev('/claims/codes'), { cookie: OWNER() })).json()
      .codes as Array<{ participantId: string; displayName: string; code: string }>;
    const dinoCode = list.find((c) => c.participantId === dino!.id)!;
    expect(list.map((c) => c.participantId)).toContain(elsa!.id);
    expect(dinoCode.code).toMatch(/^[A-Z2-9]{10}$/);
    const a = await joinAccess();
    const target = { joinToken: a.token };

    expect(
      (
        await req('POST', '/api/join/claim', {
          body: { method: 'personal_code', target, code: 'AAAAAAAAAA' },
        })
      ).statusCode,
    ).toBe(401);
    const ok = await req('POST', '/api/join/claim', {
      body: { method: 'personal_code', target, code: dinoCode.code },
    });
    expect(ok.json()).toEqual({ status: 'active', participantId: dino!.id, verified: true });
    expect(await xpJoined(dino!.id)).toBe(1);
    const again = await req('POST', '/api/join/claim', {
      body: { method: 'personal_code', target, code: dinoCode.code },
    });
    expect(again.statusCode).toBe(401); // single use
    expect(
      JSON.stringify(await w.db.select().from(participants).where(eq(participants.id, dino!.id))),
    ).not.toContain(dinoCode.code);
  });

  it('(a) email claim link: sent only to unclaimed entries with an email; verified; single use', async () => {
    const [fede] = await roster(['Fede Mail'], true);
    email.sent.length = 0;
    const r = await req('POST', ev('/claims/email-links'), { cookie: OWNER() });
    expect(r.json().sent).toBeGreaterThanOrEqual(1);
    const mail = email.sent.find((m) => m.to === 'fede.mail@example.test')!;
    expect(mail.text).toContain('https://santa.test/j/claim?token=');
    const token = /token=(\S+)/.exec(mail.text)![1]!;
    const res = await req('POST', '/api/join/claim', { body: { method: 'email_link', token } });
    expect(res.json()).toEqual({ status: 'active', participantId: fede!.id, verified: true });
    expect(
      (await req('POST', '/api/join/claim', { body: { method: 'email_link', token } })).statusCode,
    ).toBe(401);
  });

  it('atomic: concurrent claims on one entry => exactly one wins (pick_name and shared credential)', async () => {
    const [gina, hugo] = await roster(['Gina Race', 'Hugo Race'], true);
    const a = await joinAccess();
    const pick = () =>
      req('POST', '/api/join/claim', {
        body: { method: 'pick_name', target: { joinToken: a.token }, participantId: gina!.id },
      });
    const results = await Promise.all([pick(), pick(), pick()]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409, 409]);

    email.sent.length = 0;
    await req('POST', ev('/claims/email-links'), { cookie: OWNER() });
    const token = /token=(\S+)/.exec(email.sent.find((m) => m.to.startsWith('hugo'))!.text)![1]!;
    const link = () => req('POST', '/api/join/claim', { body: { method: 'email_link', token } });
    expect((await Promise.all([link(), link()])).map((r) => r.statusCode).sort()).toEqual([
      200, 401,
    ]);
    void hugo;
  });

  it('re-claim on a new device revokes the old session (cookie dead, socket dropped), no second XP; pick_name cannot hijack', async () => {
    const [ivan] = await roster(['Ivan Device']);
    const codes = async () =>
      (await req('POST', ev('/claims/codes'), { cookie: OWNER() })).json().codes;
    const a = await joinAccess();
    const target = { joinToken: a.token };
    const first = (await codes()).find(
      (c: { participantId: string }) => c.participantId === ivan!.id,
    );
    const r1 = await req('POST', '/api/join/claim', {
      body: { method: 'personal_code', target, code: first.code },
    });
    const old = cookieOf(r1)!.value;
    const oldSocket = w.client(`sg_p=${old}`);
    await connected(oldSocket);
    const gone = waitFor(oldSocket, 'disconnect');

    // hijack attempt by name is refused
    expect(
      (
        await req('POST', '/api/join/claim', {
          body: { method: 'pick_name', target, participantId: ivan!.id },
        })
      ).statusCode,
    ).toBe(409);

    // organizer reissues a credential for the (now active) entry -> verified re-claim
    const { issueClaimToken } = await import('@santa/db');
    await issueClaimToken(w.db, {
      participantId: ivan!.id,
      method: 'personal_code',
      tokenHash: hashToken('RECLAIM2345'),
      expiresAt: new Date(Date.now() + 60_000),
      now: new Date(),
    });
    const r2 = await req('POST', '/api/join/claim', {
      body: { method: 'personal_code', target, code: 'RECLAIM2345' },
    });
    expect(r2.json()).toMatchObject({ status: 'active', verified: true });
    const fresh = cookieOf(r2)!.value;
    expect(fresh).not.toBe(old);
    await gone;
    expect((await req('GET', '/api/me', { cookie: `sg_p=${old}` })).statusCode).toBe(401);
    expect((await req('GET', '/api/me', { cookie: `sg_p=${fresh}` })).statusCode).toBe(200);
    expect(await xpJoined(ivan!.id)).toBe(1);
  });

  it('join phase gate: pick_name closes with the registration phases, verified claims keep working', async () => {
    const [judy, karl] = await roster(['Judy Late', 'Karl Late']);
    const a = await joinAccess();
    const [{ code }] = (await req('POST', ev('/claims/codes'), { cookie: OWNER() }))
      .json()
      .codes.filter((c: { participantId: string }) => c.participantId === karl!.id);
    await w.db.update(events).set({ phase: 'voting' }).where(eq(events.id, w.eventId));
    expect(
      (await req('POST', '/api/join/resolve', { body: { joinToken: a.token } })).json().event
        .joinOpen,
    ).toBe(false);
    const late = await req('POST', '/api/join/claim', {
      body: { method: 'pick_name', target: { joinToken: a.token }, participantId: judy!.id },
    });
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe('join_closed');
    expect(
      (
        await req('POST', '/api/join/claim', {
          body: { method: 'personal_code', target: { joinToken: a.token }, code },
        })
      ).statusCode,
    ).toBe(200);
    await w.db.update(events).set({ phase: 'gift_registration' }).where(eq(events.id, w.eventId));
  });
});

describe('display token exchange', () => {
  it('display token -> HttpOnly cookie -> socket works; revoking drops it and blocks new exchanges', async () => {
    const res = await req('POST', ev('/access'), {
      cookie: OWNER(),
      body: { kind: 'display', expiresInHours: 12 },
    });
    const d = res.json();
    expect(d).toMatchObject({ kind: 'display', shortCode: null, path: `/d/${d.token}` });

    expect(
      (await req('POST', '/api/join/display', { body: { token: 'y'.repeat(43) } })).statusCode,
    ).toBe(401);
    const ex = await req('POST', '/api/join/display', { body: { token: d.token } });
    expect(ex.statusCode).toBe(200);
    const c = cookieOf(ex, 'sg_d')!;
    expect(c).toMatchObject({ httpOnly: true, sameSite: 'Lax' });
    // a join token must not work as a display token
    const j = await joinAccess();
    expect((await req('POST', '/api/join/display', { body: { token: j.token } })).statusCode).toBe(
      401,
    );

    const s = w.client(`sg_d=${c.value}`);
    await connected(s);
    s.emit('subscribe', {});
    await sleep(200);
    const gone = waitFor(s, 'disconnect');
    expect((await req('DELETE', ev(`/access/${d.accessId}`), { cookie: OWNER() })).statusCode).toBe(
      200,
    );
    await gone;
    expect((await req('POST', '/api/join/display', { body: { token: d.token } })).statusCode).toBe(
      401,
    );
  });
});

describe('profile edit', () => {
  it('own display name / avatar preset / locale; uniqueness; validation; pending and anonymous refused; locked after reveal', async () => {
    const [lena, milo] = await roster(['Lena Profile', 'Milo Profile']);
    const codes = (await req('POST', ev('/claims/codes'), { cookie: OWNER() })).json()
      .codes as Array<{ participantId: string; code: string }>;
    const a = await joinAccess();
    const login = async (id: string) =>
      cookieOf(
        await req('POST', '/api/join/claim', {
          body: {
            method: 'personal_code',
            target: { joinToken: a.token },
            code: codes.find((c) => c.participantId === id)!.code,
          },
        }),
      )!.value;
    const lc = `sg_p=${await login(lena!.id)}`;
    await login(milo!.id);

    expect((await req('PATCH', '/api/me/profile', { body: { displayName: 'x' } })).statusCode).toBe(
      401,
    );
    const ok = await req('PATCH', '/api/me/profile', {
      cookie: lc,
      body: { displayName: '  Lena Rossi ', avatar: 'reindeer-1', locale: 'it' },
    });
    expect(ok.json()).toMatchObject({
      displayName: 'Lena Rossi',
      avatar: 'reindeer-1',
      locale: 'it',
      status: 'active',
    });
    const clash = await req('PATCH', '/api/me/profile', {
      cookie: lc,
      body: { displayName: 'MILO  profile' },
    });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.code).toBe('name_taken');
    expect(
      (await req('PATCH', '/api/me/profile', { cookie: lc, body: { avatar: '<script>' } }))
        .statusCode,
    ).toBe(400);
    expect(
      (await req('PATCH', '/api/me/profile', { cookie: lc, body: { isAdmin: true } })).statusCode,
    ).toBe(400);

    await w.db.update(events).set({ phase: 'reveal' }).where(eq(events.id, w.eventId));
    const locked = await req('PATCH', '/api/me/profile', {
      cookie: lc,
      body: { displayName: 'Lena Again' },
    });
    expect(locked.statusCode).toBe(409);
    expect(locked.json().error.code).toBe('profile_locked');
    await w.db.update(events).set({ phase: 'gift_registration' }).where(eq(events.id, w.eventId));

    const [pending] = await roster(['Nico Pending']);
    const a2 = await joinAccess();
    const pc = `sg_p=${cookieOf(await req('POST', '/api/join/claim', { body: { method: 'pick_name', target: { joinToken: a2.token }, participantId: pending!.id } }))!.value}`;
    expect(
      (await req('PATCH', '/api/me/profile', { cookie: pc, body: { displayName: 'Nico' } }))
        .statusCode,
    ).toBe(401);
    void collect;
  });
});
