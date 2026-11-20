import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { events, participants, unmaskGrants } from '@santa/db';
import { scanForbidden } from '@santa/contracts';
import { hashToken } from '../tokens.js';
import {
  addOrganizer,
  collect,
  connected,
  createWorld,
  insertSecondEvent,
  sleep,
  waitFor,
  type World,
} from '../testing/world.js';

interface Snap {
  stream: string;
  cursor: number;
  data: Record<string, { mode?: string; role?: string; me?: { xp: { xp: number } } }>;
}

const latestPresence = (deltas: unknown[]) => {
  for (let i = deltas.length - 1; i >= 0; i--) {
    const delta = deltas[i] as {
      stream?: string;
      surface?: string;
      payload?: { organizer?: { displayConnected?: boolean } };
    };
    if (delta.stream === 'org' && delta.surface === 'eventState') {
      return delta.payload?.organizer?.displayConnected;
    }
  }
  return undefined;
};

const waitForCondition = async (condition: () => boolean, label: string) => {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await sleep(20);
  }
  throw new Error(`timeout waiting for ${label}`);
};

const subscribeAll = async (s: ReturnType<World['client']>, payload: unknown, n: number) => {
  const snaps: Snap[] = [];
  s.on('snapshot', (x: Snap) => snaps.push(x));
  s.emit('subscribe', payload);
  for (let i = 0; i < 50 && snaps.length < n; i++) await sleep(20);
  return snaps;
};

describe('realtime core', () => {
  let w: World;
  beforeAll(async () => {
    w = await createWorld({
      clock: () => new Date('2026-12-24T20:00:00Z'),
      rate: { messagesPerSec: 50, reactionsPerSec: 3 },
    });
  }, 60_000);

  it('selects display and organizer roles from one cookie jar, tracks readiness, and broadcasts a presentation', async () => {
    const world = await createWorld({
      clock: () => new Date('2026-12-24T20:00:00Z'),
      rate: { messagesPerSec: 50, reactionsPerSec: 3 },
    });
    try {
      await world.db.update(events).set({ phase: 'reveal' }).where(eq(events.id, world.eventId));
      const owner = world.organizerCookie('demo-owner', 'shared-browser-owner');
      const access = await world.app.inject({
        method: 'POST',
        url: `/api/events/${world.eventId}/access`,
        headers: {
          cookie: owner,
          'idempotency-key': 'display-runtime-access-xxxx',
        },
        payload: { kind: 'display', expiresInHours: 12 },
      });
      expect(access.statusCode).toBe(201);
      const { token } = access.json() as { token: string };
      const exchange = await world.app.inject({
        method: 'POST',
        url: '/api/join/display',
        headers: { 'idempotency-key': 'display-runtime-exchange-xx' },
        payload: { token },
      });
      expect(exchange.statusCode).toBe(200);
      const displayToken = exchange.cookies.find((c) => c.name === 'sg_d')?.value;
      expect(displayToken).toBe(token);
      const staleGuest = await world.guestCookie(0, 'still-valid-stale-guest');
      const sharedCookies = `${owner}; ${staleGuest}; sg_d=${displayToken}`;
      const tunnelOrigin = 'https://shared-browser.ngrok-free.app';

      const org = world.client(sharedCookies, tunnelOrigin);
      const display = world.client(sharedCookies, tunnelOrigin);
      const orgDeltas = collect(org, 'delta');
      const displayDeltas = collect(display, 'delta');
      await Promise.all([connected(org), connected(display)]);

      const [orgSnapshots] = await Promise.all([subscribeAll(org, { eventId: world.eventId }, 2)]);
      expect(orgSnapshots.find((s) => s.stream === 'org')?.data['eventState']).toMatchObject({
        organizer: { displayConnected: false },
      });
      expect(
        scanForbidden(orgSnapshots, {
          keys: ['token', 'sessionId', 'giverId', 'recipientId', 'voterId', 'score', 'pairings'],
        }),
      ).toEqual([]);

      const displaySnapshots = await subscribeAll(display, {}, 1);
      const pub = displaySnapshots[0]!;
      expect(pub.stream).toBe('pub');
      expect(pub.data['eventState']).toMatchObject({
        role: 'display',
        eventId: world.eventId,
      });
      expect(JSON.stringify(pub.data)).not.toContain(token);
      await waitForCondition(
        () =>
          latestPresence(orgDeltas) === true &&
          orgDeltas.some(
            (m) =>
              (m as { payload?: { organizer?: { displayConnected?: boolean } } }).payload?.organizer
                ?.displayConnected === true,
          ),
        'same-browser organizer display presence',
      );
      expect(
        scanForbidden(displaySnapshots, {
          keys: ['token', 'sessionId', 'giverId', 'recipientId', 'voterId', 'score', 'pairings'],
        }),
      ).toEqual([]);

      const presented = await world.app.inject({
        method: 'POST',
        url: `/api/events/${world.eventId}/presentations`,
        headers: {
          cookie: owner,
          'idempotency-key': 'display-runtime-present-xxxx',
        },
        payload: { kind: 'santa_detective' },
      });
      expect(presented.statusCode).toBe(200);
      await waitForCondition(
        () =>
          displayDeltas.some(
            (m) =>
              (m as { surface?: string; payload?: { scene?: string } }).surface === 'scene' &&
              (m as { payload?: { scene?: string } }).payload?.scene === 'spotlight',
          ),
        'display presentation scene',
      );
      const latestScene = [...displayDeltas]
        .reverse()
        .find((m) => (m as { surface?: string }).surface === 'scene') as
        { payload?: { scene?: string; spotlight?: { kind?: string } } } | undefined;
      expect(latestScene?.payload).toMatchObject({
        scene: 'spotlight',
        spotlight: { kind: 'santa_detective' },
      });
      expect(
        scanForbidden([displaySnapshots, displayDeltas], {
          keys: ['token', 'sessionId', 'giverId', 'recipientId', 'voterId', 'score', 'pairings'],
        }),
      ).toEqual([]);
    } finally {
      await world.close();
    }
  }, 60_000);
  afterAll(async () => {
    await w.close();
  });

  it('rejects connections without a valid session', async () => {
    await expect(connected(w.client('sg_p=nope'))).rejects.toThrow('unauthorized');
    await expect(connected(w.client(''))).rejects.toThrow('unauthorized');
  });

  it('subscribe -> role-scoped snapshots with cursors; guest never gets organizer streams', async () => {
    const guest = w.client(await w.guestCookie(0));
    await connected(guest);
    const snaps = await subscribeAll(guest, {}, 2);
    expect(snaps.map((s) => s.stream).sort()).toEqual([`p:${w.participantIds[0]}`, 'pub']);
    expect(snaps.every((s) => s.cursor === 0)).toBe(true);
    const own = snaps.find((s) => s.stream.startsWith('p:'))!;
    expect(own.data['eventState']?.me?.xp.xp).toBe(10); // self-only XP
    expect(snaps.find((s) => s.stream === 'pub')!.data['giftList']?.mode).toBe('count_only');
    expect(JSON.stringify(snaps)).not.toContain('displayConnected');

    const display = w.client(await w.displayCookie());
    await connected(display);
    const dsnaps = await subscribeAll(display, {}, 1);
    expect(dsnaps.map((s) => s.stream)).toEqual(['pub']);
    expect(JSON.stringify(dsnaps)).not.toContain('displayConnected');

    const org = w.client(w.organizerCookie());
    await connected(org);
    const osnaps = await subscribeAll(org, { eventId: w.eventId }, 2);
    expect(osnaps.map((s) => s.stream).sort()).toEqual(['org', 'pub']);
    expect(osnaps.find((s) => s.stream === 'org')!.data['eventState']).toMatchObject({
      role: 'organizer_masked',
      organizer: { displayConnected: true },
    });
    const displayGone = waitFor(display, 'disconnect');
    display.disconnect();
    await displayGone;
  });

  it('tracks authenticated display presence per event and preserves it until the last disconnect', async () => {
    const other = await insertSecondEvent(w.db, 'presence-outsider');
    await addOrganizer(w.db, other.eventId, 'stranger');
    const org = w.client(w.organizerCookie('demo-owner', 'presence-observer'));
    const otherOrg = w.client(w.organizerCookie('stranger', 'other-observer'));
    await Promise.all([connected(org), connected(otherOrg)]);
    const [orgSnaps, otherSnaps] = await Promise.all([
      subscribeAll(org, { eventId: w.eventId }, 2),
      subscribeAll(otherOrg, { eventId: other.eventId }, 2),
    ]);
    expect(orgSnaps.find((s) => s.stream === 'org')!.data['eventState']).toMatchObject({
      organizer: { displayConnected: false },
    });
    expect(otherSnaps.find((s) => s.stream === 'org')!.data['eventState']).toMatchObject({
      organizer: { displayConnected: false },
    });
    const orgDeltas = collect(org, 'delta');
    const otherDeltas = collect(otherOrg, 'delta');

    const d1 = w.client(await w.displayCookie());
    const d2 = w.client(await w.displayCookie());
    await connected(d1);
    await connected(d2);
    const d1Snaps = subscribeAll(d1, {}, 1);
    const d2Snaps = subscribeAll(d2, {}, 1);
    await Promise.all([d1Snaps, d2Snaps]);
    await waitForCondition(
      () => latestPresence(orgDeltas) === true,
      'organizer presence connected delta',
    );
    expect(latestPresence(otherDeltas)).toBeUndefined();

    const gone1 = waitFor(d1, 'disconnect');
    d1.disconnect();
    await gone1;
    await sleep(50);
    expect(latestPresence(orgDeltas)).toBe(true);

    const gone2 = waitFor(d2, 'disconnect');
    d2.disconnect();
    await gone2;
    await waitForCondition(
      () => latestPresence(orgDeltas) === false,
      'organizer presence disconnected delta',
    );
    expect(latestPresence(otherDeltas)).toBeUndefined();
  });

  it('organizer must be a member of the named event', async () => {
    const stranger = w.client(w.organizerCookie('stranger', 's2'));
    await connected(stranger);
    const err = waitFor<{ code: string }>(stranger, 'error');
    stranger.emit('subscribe', { eventId: w.eventId });
    expect(await err).toEqual({ code: 'forbidden' });
    const err2 = waitFor<{ code: string }>(stranger, 'error');
    stranger.emit('subscribe', {});
    expect(await err2).toEqual({ code: 'forbidden' });
  });

  it('deltas have contiguous per-stream cursors, stay inside the event/stream, and late joiners snapshot', async () => {
    const a = w.client(await w.guestCookie(0));
    const b = w.client(await w.guestCookie(1));
    const outsider = await insertSecondEvent(w.db);
    const o = w.client(outsider.cookie);
    await Promise.all([connected(a), connected(b), connected(o)]);
    const [aSnaps] = await Promise.all([
      subscribeAll(a, {}, 2),
      subscribeAll(b, {}, 2),
      subscribeAll(o, {}, 2),
    ]);
    const aDeltas = collect(a, 'delta');
    const bDeltas = collect(b, 'delta');
    const oDeltas = collect(o, 'delta');

    const hub = w.app.hub!;
    const base = hub.currentCursor(w.eventId, 'pub');
    hub.publish(w.eventId, 'pub', 'giftList', { mode: 'count_only', count: 3 });
    hub.publish(w.eventId, 'pub', 'giftList', { mode: 'count_only', count: 4 });
    const ownState = aSnaps.find((s) => s.stream.startsWith('p:'))!.data['eventState'];
    hub.publish(w.eventId, 'p:' + w.participantIds[1], 'eventState', {
      ...ownState,
      me: { ...ownState!.me, participantId: w.participantIds[1] },
    });
    await sleep(150);

    expect((aDeltas as Array<{ cursor: number }>).map((d) => d.cursor)).toEqual([
      base + 1,
      base + 2,
    ]);
    expect(bDeltas).toHaveLength(3); // b also receives its private stream
    expect(oDeltas).toHaveLength(0); // other event: nothing

    const late = w.client(await w.guestCookie(2));
    await connected(late);
    const lateDeltas = collect(late, 'delta');
    const lateSnaps = await subscribeAll(late, {}, 2);
    expect(lateSnaps.find((s) => s.stream === 'pub')!.cursor).toBe(base + 2);
    await sleep(50);
    expect(lateDeltas).toHaveLength(0);
  });

  it('send guard: leaky payloads are never emitted (test env throws)', async () => {
    const hub = w.app.hub!;
    const display = w.client(await w.displayCookie().catch(() => 'sg_d=display-token'));
    await connected(display);
    await subscribeAll(display, {}, 1);
    const deltas = collect(display, 'delta');
    const before = hub.currentCursor(w.eventId, 'pub');
    expect(() =>
      hub.publish(w.eventId, 'pub', 'leaderboard', {
        boardKey: 'b',
        state: 'live',
        entries: [{ entryId: 'g1', rank: 1, tied: false, score: 9 }],
      }),
    ).toThrow();
    expect(() =>
      hub.publish(w.eventId, 'pub', 'giftList', {
        mode: 'gallery',
        gifts: [{ giftId: 'g', giverId: 'x' }],
      }),
    ).toThrow();
    await sleep(100);
    expect(deltas).toHaveLength(0);
    expect(hub.currentCursor(w.eventId, 'pub')).toBe(before);
  });

  it('time.ping returns server time; /api/time is no-store', async () => {
    const guest = w.client(await w.guestCookie(4));
    await connected(guest);
    const sync = waitFor<{ clientTime: number; serverTime: number }>(guest, 'time.sync');
    guest.emit('time.ping', { clientTime: 42 });
    expect(await sync).toEqual({ clientTime: 42, serverTime: Date.parse('2026-12-24T20:00:00Z') });
    const res = await w.app.inject({ method: 'GET', url: '/api/time' });
    expect(res.json()).toEqual({ serverTime: Date.parse('2026-12-24T20:00:00Z') });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('a newer session for the same roster entry force-disconnects the old one', async () => {
    const old = w.client(await w.guestCookie(5, 'tok-old'));
    await connected(old);
    const gone = waitFor(old, 'disconnect');
    await w.db
      .update(participants)
      .set({ sessionTokenHash: hashToken('tok-new') })
      .where(eq(participants.id, w.participantIds[5]!));
    const fresh = w.client('sg_p=tok-new');
    await connected(fresh);
    await gone;
    expect(old.connected).toBe(false);
    expect(fresh.connected).toBe(true);
  });
});

describe('grant-scoped unmask channel', () => {
  let w: World;
  beforeAll(async () => {
    w = await createWorld();
  }, 60_000);
  afterAll(async () => {
    await w.close();
  });

  const orgSocket = async (cookie = w.organizerCookie()) => {
    const s = w.client(cookie);
    await connected(s);
    await subscribeAll(s, { eventId: w.eventId }, 2);
    return s;
  };
  const grantPayload = {
    boardKey: 'b',
    voterCount: 6,
    entries: [{ entryId: 'g1', label: 'Gift 1', rank: 1, tied: false, score: 3 }],
  };

  it('grants unmasked snapshot + deltas only to the grant holder; others are refused', async () => {
    const grantId = await w.grant();
    const org = await orgSocket();
    const snap = waitFor<Snap>(org, 'snapshot');
    org.emit('grant.subscribe', { grantId });
    const s = await snap;
    expect(s.stream).toBe(`grant:${grantId}`);
    expect(s.data['giftList']?.mode).toBe('unmasked');
    expect(s.data['eventState']).toMatchObject({ role: 'organizer_unmasked' });

    const deltas = collect(org, 'delta');
    await w.app.hub!.publishToGrant(grantId, 'leaderboard', grantPayload);
    await sleep(100);
    expect(deltas).toHaveLength(1);

    // participant: refused; masked organizer socket without grant never receives it
    const guest = w.client(await w.guestCookie(0));
    await connected(guest);
    await subscribeAll(guest, {}, 2);
    const err = waitFor<{ code: string }>(guest, 'error');
    const guestDeltas = collect(guest, 'delta');
    guest.emit('grant.subscribe', { grantId });
    expect(await err).toEqual({ code: 'forbidden' });
    await w.app.hub!.publishToGrant(grantId, 'leaderboard', grantPayload);
    await sleep(100);
    expect(guestDeltas).toHaveLength(0);

    // someone else's grant / expired grant are refused
    const other = await w.grant({ userId: 'stranger' });
    const expired = await w.grant({ expiresInMs: -1000 });
    for (const g of [other, expired]) {
      const e = waitFor<{ code: string }>(org, 'error');
      org.emit('grant.subscribe', { grantId: g });
      expect(await e).toEqual({ code: 'forbidden' });
    }
  });

  it('expiry mid-session: authz re-check before send forces revoke + disconnect', async () => {
    const grantId = await w.grant({ expiresInMs: 600_000 });
    const org = await orgSocket();
    org.emit('grant.subscribe', { grantId });
    await waitFor(org, 'snapshot');
    await w.db
      .update(unmaskGrants)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(unmaskGrants.id, grantId));
    const revoked = waitFor<{ grantId: string; reason: string }>(org, 'grant.revoked');
    const gone = waitFor(org, 'disconnect');
    const deltas = collect(org, 'delta');
    await w.app.hub!.publishToGrant(grantId, 'leaderboard', grantPayload);
    expect(await revoked).toMatchObject({ grantId });
    await gone;
    expect(deltas).toHaveLength(0);
  });

  it('explicit revocation (job/endpoint) disconnects immediately', async () => {
    const grantId = await w.grant();
    const org = await orgSocket();
    org.emit('grant.subscribe', { grantId });
    await waitFor(org, 'snapshot');
    const revoked = waitFor<{ reason: string }>(org, 'grant.revoked');
    const gone = waitFor(org, 'disconnect');
    w.app.hub!.revokeGrant(grantId, 'expired');
    expect((await revoked).reason).toBe('expired');
    await gone;
  });

  it('DB revocation, membership removal and session revocation each cut off the next send', async () => {
    // DB revokedAt
    let grantId = await w.grant();
    let org = await orgSocket(w.organizerCookie('demo-owner', 'sess-a'));
    org.emit('grant.subscribe', { grantId });
    await waitFor(org, 'snapshot');
    await w.db
      .update(unmaskGrants)
      .set({ revokedAt: new Date() })
      .where(eq(unmaskGrants.id, grantId));
    let gone = waitFor(org, 'disconnect');
    await w.app.hub!.publishToGrant(grantId, 'leaderboard', grantPayload);
    await gone;

    // session revoked
    grantId = await w.grant();
    org = await orgSocket(w.organizerCookie('demo-owner', 'sess-b'));
    org.emit('grant.subscribe', { grantId });
    await waitFor(org, 'snapshot');
    w.organizers.revoked.add('sess-b');
    gone = waitFor(org, 'disconnect');
    await w.app.hub!.publishToGrant(grantId, 'leaderboard', grantPayload);
    await gone;

    // membership removal (forced, no send needed)
    grantId = await w.grant();
    org = await orgSocket(w.organizerCookie('demo-owner', 'sess-c'));
    org.emit('grant.subscribe', { grantId });
    await waitFor(org, 'snapshot');
    const revoked = waitFor<{ reason: string }>(org, 'grant.revoked');
    gone = waitFor(org, 'disconnect');
    w.app.hub!.dropOrganizer(w.eventId, 'demo-owner');
    expect((await revoked).reason).toBe('membership');
    await gone;
  });
});
