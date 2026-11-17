import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { participants, unmaskGrants } from '@santa/db';
import { hashToken } from '../tokens.js';
import {
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

    const display = w.client(await w.displayCookie());
    await connected(display);
    const dsnaps = await subscribeAll(display, {}, 1);
    expect(dsnaps.map((s) => s.stream)).toEqual(['pub']);

    const org = w.client(w.organizerCookie());
    await connected(org);
    const osnaps = await subscribeAll(org, { eventId: w.eventId }, 2);
    expect(osnaps.map((s) => s.stream).sort()).toEqual(['org', 'pub']);
    expect(osnaps.find((s) => s.stream === 'org')!.data['eventState']).toMatchObject({
      role: 'organizer_masked',
    });
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
