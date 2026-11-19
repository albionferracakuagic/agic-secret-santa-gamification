import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { scheduledJobs, user } from '@santa/db';
import { scanForbidden } from '@santa/contracts';
import { JobRunner } from '../jobs/runner.js';
import { registerRealtimeJobs } from '../realtime/jobs.js';
import { connected, createWorld, sleep, waitFor, collect, type World } from '../testing/world.js';

let w: World;
let n = 0;
beforeAll(async () => {
  w = await createWorld();
}, 60_000);
afterAll(async () => {
  await w.close();
});

const call = (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  o: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {},
) =>
  w.app.inject({
    method,
    url,
    ...(o.body === undefined ? {} : { payload: o.body as object }),
    headers: {
      ...(o.cookie ? { cookie: o.cookie } : {}),
      'idempotency-key': `key-${++n}-xxxxxxxx`,
      ...o.headers,
    },
  });
const owner = () => w.organizerCookie('demo-owner', 'sess-o');
const ev = (suffix = '') => `/api/events/${w.eventId}${suffix}`;
const UNMASK = { confirm: true, reason: 'fix assignment of gift' };

describe('masked vs unmasked organizer + audit unmask', () => {
  it('requires organizer session and event membership', async () => {
    expect((await call('GET', ev('/audit'))).statusCode).toBe(401);
    expect(
      (await call('GET', ev('/audit'), { cookie: w.organizerCookie('stranger', 's') })).statusCode,
    ).toBe(403);
    // a participant session is not an organizer session
    const guest = await w.guestCookie(0);
    expect([401, 403]).toContain(
      (await call('GET', ev('/pairings'), { cookie: guest })).statusCode,
    );
  });

  it('unmask needs confirm + reason; grant is 10 min with banner flag and is audited + scheduled', async () => {
    expect(
      (await call('POST', ev('/unmask'), { cookie: owner(), body: { confirm: true, reason: 'x' } }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await call('POST', ev('/unmask'), {
          cookie: owner(),
          body: { reason: 'fix assignment of gift' },
        })
      ).statusCode,
    ).toBe(400);
    const before = Date.now();
    const res = await call('POST', ev('/unmask'), { cookie: owner(), body: UNMASK });
    expect(res.statusCode).toBe(201);
    const g = res.json();
    expect(g.banner).toBe(true);
    expect(Date.parse(g.expiresAt) - before).toBeGreaterThan(599_000);
    expect(Date.parse(g.expiresAt) - before).toBeLessThan(601_500);
    const jobs = await w.db
      .select()
      .from(scheduledJobs)
      .where(eq(scheduledJobs.kind, 'grant.expire'));
    expect(jobs.some((j) => (j.payload as { grantId: string }).grantId === g.grantId)).toBe(true);
    const audit = (await call('GET', ev('/audit'), { cookie: owner() })).json();
    expect(
      audit.entries.find((e: { action: string }) => e.action === 'unmask.grant'),
    ).toMatchObject({ reason: UNMASK.reason });
  });

  it('secret data (pairings, unmasked state) only behind an active grant', async () => {
    expect((await call('GET', ev('/pairings'), { cookie: owner() })).statusCode).toBe(403);
    const { grantId } = (
      await call('POST', ev('/unmask'), { cookie: owner(), body: UNMASK })
    ).json();
    const grant = { 'x-unmask-grant': grantId };

    const pairs = await call('GET', ev('/pairings'), { cookie: owner(), headers: grant });
    expect(pairs.statusCode).toBe(200);
    expect(pairs.json().pairings).toHaveLength(8);

    const masked = (await call('GET', ev('/organizer-state'), { cookie: owner() })).json();
    expect(masked.role).toBe('organizer_masked');
    expect(masked.eventState.organizer.displayConnected).toBe(false);
    expect(scanForbidden(masked, { keys: ['giverId', 'recipientId', 'unmask'] })).toEqual([]);
    const unmasked = (
      await call('GET', ev('/organizer-state'), { cookie: owner(), headers: grant })
    ).json();
    expect(unmasked.role).toBe('organizer_unmasked');
    expect(unmasked.eventState.organizer.displayConnected).toBe(false);
    expect(unmasked.giftList.mode).toBe('unmasked');

    // a non-owned / bogus grant is refused, not silently downgraded
    expect(
      (
        await call('GET', ev('/organizer-state'), {
          cookie: owner(),
          headers: { 'x-unmask-grant': '00000000-0000-0000-0000-000000000000' },
        })
      ).statusCode,
    ).toBe(403);

    // pairing reads are audited; the log never contains pairing ids
    const log = JSON.stringify((await call('GET', ev('/audit'), { cookie: owner() })).json());
    expect(log).toContain('unmask.read_pairings');
    for (const id of w.participantIds) expect(log).not.toContain(id);
  });

  it('revoke endpoint cuts the socket and the grant; second revoke is 404', async () => {
    const { grantId } = (
      await call('POST', ev('/unmask'), { cookie: owner(), body: UNMASK })
    ).json();
    const org = w.client(owner());
    await connected(org);
    org.emit('subscribe', { eventId: w.eventId });
    await waitFor(org, 'snapshot');
    org.emit('grant.subscribe', { grantId });
    await sleep(200);
    const revoked = waitFor<{ reason: string }>(org, 'grant.revoked');
    const gone = waitFor(org, 'disconnect');
    expect(
      (await call('POST', ev(`/unmask/${grantId}/revoke`), { cookie: owner() })).statusCode,
    ).toBe(200);
    expect((await revoked).reason).toBe('revoked');
    await gone;
    expect(
      (await call('POST', ev(`/unmask/${grantId}/revoke`), { cookie: owner() })).statusCode,
    ).toBe(404);
    expect(
      (
        await call('GET', ev('/pairings'), {
          cookie: owner(),
          headers: { 'x-unmask-grant': grantId },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('grant.expire job forces disconnect at expiry and audits it', async () => {
    const { grantId } = (
      await call('POST', ev('/unmask'), { cookie: owner(), body: UNMASK })
    ).json();
    const org = w.client(owner());
    await connected(org);
    org.emit('subscribe', { eventId: w.eventId });
    await waitFor(org, 'snapshot');
    org.emit('grant.subscribe', { grantId });
    await sleep(200);
    const revoked = waitFor<{ reason: string }>(org, 'grant.revoked');
    const runner = new JobRunner(w.db, { clock: () => new Date(Date.now() + 11 * 60_000) });
    registerRealtimeJobs(runner, w.app.hub!, w.db);
    await runner.tick();
    expect((await revoked).reason).toBe('expired');
    const log = (await call('GET', ev('/audit'), { cookie: owner() })).json();
    expect(log.entries.map((e: { action: string }) => e.action)).toContain('unmask.expire');
  });
});

describe('event setup REST', () => {
  const create = (body: Record<string, unknown>) =>
    call('POST', '/api/events', {
      cookie: owner(),
      body: {
        name: 'Team Party',
        startsAt: '2026-12-20T18:00:00Z',
        timezone: 'Europe/Rome',
        ...body,
      },
    });

  it('creates events; enforces cap 100 and privacy floors', async () => {
    const ok = await create({
      defaultLocale: 'it',
      maxParticipants: 40,
      settings: { minVoters: 6 },
    });
    expect(ok.statusCode).toBe(201);
    expect((await create({ maxParticipants: 101 })).statusCode).toBe(400);
    const low = await create({ settings: { minVoters: 3 } });
    expect(low.statusCode).toBe(400);
    expect(low.json().error.code).toBe('invalid_settings');
    const list = (await call('GET', '/api/events', { cookie: owner() })).json();
    expect(list.events.map((e: { name: string }) => e.name)).toContain('Team Party');
  });

  it('phase machine over REST: pairing gate, pause, back-step audit, reopen rules; pushes state to sockets', async () => {
    const id = (await create({})).json().id as string;
    const url = (s: string) => `/api/events/${id}${s}`;
    const phase = (to: string) => call('POST', url('/phase'), { cookie: owner(), body: { to } });
    expect((await phase('registration')).statusCode).toBe(200);
    expect((await phase('gift_registration')).json().error.code).toBe('pairing_not_ready');
    expect((await phase('voting')).json().error.code).toBe('invalid_step');
    expect(
      (await call('POST', url('/pause'), { cookie: owner(), body: { paused: true } })).statusCode,
    ).toBe(200);
    expect((await phase('gift_registration')).json().error.code).toBe('paused');
    await call('POST', url('/pause'), { cookie: owner(), body: { paused: false } });
    expect(
      (
        await call('POST', url('/reopen-voting'), {
          cookie: owner(),
          body: { reason: 'oops need it' },
        })
      ).json().error.code,
    ).toBe('voting_not_closed');
    const audit = (await call('GET', url('/audit'), { cookie: owner() })).json();
    expect(audit.entries.map((e: { action: string }) => e.action)).toEqual(
      expect.arrayContaining(['event.create', 'phase.forward', 'event.pause', 'event.resume']),
    );
  });

  it('broadcasts the new phase to participants (own stream) and display (pub) after a change', async () => {
    const guest = w.client(await w.guestCookie(0));
    await connected(guest);
    guest.emit('subscribe', {});
    await sleep(300);
    const deltas = collect(guest, 'delta') as Array<{
      stream: string;
      payload: { phase: string; me?: unknown };
    }>;
    const r = await call('POST', ev('/phase'), { cookie: owner(), body: { to: 'registration' } });
    expect(r.statusCode).toBe(200);
    await sleep(300);
    const own = deltas.find((d) => d.stream.startsWith('p:'));
    const pub = deltas.find((d) => d.stream === 'pub');
    expect(own?.payload.phase).toBe('registration');
    expect(own?.payload.me).toBeDefined();
    expect(pub?.payload.phase).toBe('registration');
    expect(pub?.payload.me).toBeUndefined();
  });

  it('co-organizers are owner-managed; removal drops their sockets', async () => {
    await w.db
      .insert(user)
      .values({ id: 'co-1', name: 'Co', email: 'co1@example.test' })
      .onConflictDoNothing();
    const coCookie = w.organizerCookie('co-1', 'sess-co');
    expect(
      (
        await call('POST', ev('/organizers'), {
          cookie: coCookie,
          body: { email: 'co1@example.test' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await call('POST', ev('/organizers'), {
          cookie: owner(),
          body: { email: 'nobody@example.test' },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await call('POST', ev('/organizers'), {
          cookie: owner(),
          body: { email: 'co1@example.test' },
        })
      ).statusCode,
    ).toBe(201);
    expect((await call('GET', ev('/audit'), { cookie: coCookie })).statusCode).toBe(200);

    const s = w.client(coCookie);
    await connected(s);
    s.emit('subscribe', { eventId: w.eventId });
    await waitFor(s, 'snapshot');
    const gone = waitFor(s, 'disconnect');
    expect((await call('DELETE', ev('/organizers/co-1'), { cookie: owner() })).statusCode).toBe(
      200,
    );
    await gone;
    expect((await call('GET', ev('/audit'), { cookie: coCookie })).statusCode).toBe(403);
    expect(
      (await call('DELETE', ev('/organizers/demo-owner'), { cookie: owner() })).statusCode,
    ).toBe(404);
  });
});
