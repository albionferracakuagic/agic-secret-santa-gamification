import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  boardAction,
  events,
  gifts,
  participants,
  publishLiveBoards,
  publishVotedCounter,
  votes,
  votingCategories,
} from '@santa/db';
import { scanForbidden } from '@santa/contracts';
import { connected, createWorld, insertSecondEvent, sleep, type World } from '../testing/world.js';

interface Route {
  method: string;
  url: string;
}
const NIL = '00000000-0000-4000-8000-000000000000';
type Msg = { stream: string; surface?: string; payload?: unknown; data?: Record<string, unknown> };

/** Routes that are public by design (everything else must be classified below). */
const PUBLIC = new Set([
  '/health',
  '/api/time',
  '/api/config',
  '/api/join/resolve',
  '/api/join/claim',
  '/api/join/display',
]);
const PUBLIC_PREFIX = ['/api/auth/', '/media/'];

describe('API authorisation sweep (every registered route)', () => {
  let w: World;
  const routes: Route[] = [];
  let n = 0;
  const hit = (r: Route, cookie?: string) =>
    w.app.inject({
      method: r.method as 'GET',
      url: r.url.replace(':eventId', w.eventId).replace(/:[A-Za-z]+/g, NIL),
      ...(r.method === 'GET' || r.method === 'DELETE' ? {} : { payload: {} }),
      headers: {
        'idempotency-key': `sweep-${++n}-xxxxxxxx`,
        ...(cookie ? { cookie } : {}),
      },
    });

  beforeAll(async () => {
    w = await createWorld({
      // the sweep fires every registered route several times per principal: keep it under the test-only
      // global limiter (the limiter itself is covered by security.test.ts)
      rateLimitMax: 10_000,
      configure: (app: FastifyInstance) => {
        app.addHook('onRoute', (o) => {
          for (const m of [o.method].flat()) {
            if (m !== 'HEAD' && m !== 'OPTIONS') routes.push({ method: m, url: o.url });
          }
        });
      },
    });
  }, 60_000);
  afterAll(async () => {
    await w.close();
  });

  const kind = (u: string) =>
    PUBLIC.has(u) || PUBLIC_PREFIX.some((p) => u.startsWith(p))
      ? 'public'
      : u.startsWith('/api/admin/')
        ? 'platform'
        : u.startsWith('/api/me') || u.startsWith('/api/profiles/')
          ? 'me'
          : u.startsWith('/api/events/:eventId')
            ? 'event'
            : u === '/api/events' || u === '/api/organizer/me'
              ? 'organizer'
              : 'unclassified';

  it('every route is classified (a new route forces a conscious entry here)', () => {
    expect(routes.length).toBeGreaterThan(60);
    expect(routes.filter((r) => kind(r.url) === 'unclassified')).toEqual([]);
  });

  it('no route exposes a ranking/score/tally of unpublished data', () => {
    expect(routes.filter((r) => /rank|score|tally|result|leaderboard/i.test(r.url))).toEqual([]);
  });

  it('organizer event routes: anonymous 401, guest 401, display 401, non-member organizer 403', async () => {
    const guest = await w.guestCookie(0);
    const display = await w.displayCookie();
    const stranger = w.organizerCookie('stranger', 'sess-x');
    const bad: string[] = [];
    for (const r of routes.filter((x) => kind(x.url) === 'event')) {
      const expectations: Array<[string | undefined, number]> = [
        [undefined, 401],
        [guest, 401],
        [display, 401],
        [stranger, 403],
      ];
      for (const [cookie, status] of expectations) {
        const res = await hit(r, cookie);
        if (res.statusCode !== status)
          bad.push(
            `${r.method} ${r.url} as ${cookie?.split('=')[0] ?? 'anon'} -> ${res.statusCode}`,
          );
      }
    }
    expect(bad).toEqual([]);
  });

  it('participant (/api/me, profiles) routes: anonymous, display and organizer sessions get 401', async () => {
    const display = await w.displayCookie();
    const owner = w.organizerCookie();
    const bad: string[] = [];
    for (const r of routes.filter((x) => kind(x.url) === 'me')) {
      for (const cookie of [undefined, display, owner]) {
        const res = await hit(r, cookie);
        if (res.statusCode !== 401)
          bad.push(
            `${r.method} ${r.url} as ${cookie?.split('=')[0] ?? 'anon'} -> ${res.statusCode}`,
          );
      }
    }
    expect(bad).toEqual([]);
  });

  it('platform-admin routes: anonymous 401, guest 401, ordinary organizer 403', async () => {
    const guest = await w.guestCookie(0);
    for (const r of routes.filter((x) => kind(x.url) === 'platform')) {
      expect((await hit(r)).statusCode).toBe(401);
      expect((await hit(r, guest)).statusCode).toBe(401);
      expect((await hit(r, w.organizerCookie())).statusCode).toBe(403);
    }
  });

  it('organizer account routes need an organizer session', async () => {
    const guest = await w.guestCookie(0);
    for (const r of routes.filter((x) => kind(x.url) === 'organizer')) {
      expect((await hit(r)).statusCode).toBe(401);
      expect((await hit(r, guest)).statusCode).toBe(401);
    }
  });

  it('unmask-gated routes refuse a member without grant, with an expired grant and with a bogus grant', async () => {
    const expired = await w.grant({ expiresInMs: -1000 });
    const gated = [
      { method: 'GET', url: `/api/events/${w.eventId}/pairings` },
      { method: 'GET', url: `/api/events/${w.eventId}/integrity/details` },
      { method: 'POST', url: `/api/events/${w.eventId}/pairings/correct` },
    ] as const;
    for (const g of gated) {
      for (const grant of [undefined, expired, NIL, 'not-a-uuid']) {
        const res = await w.app.inject({
          method: g.method,
          url: g.url,
          ...(g.method === 'POST' ? { payload: {} } : {}),
          headers: {
            cookie: w.organizerCookie(),
            'idempotency-key': `gate-${++n}-xxxxxxxx`,
            ...(grant ? { 'x-unmask-grant': grant } : {}),
          },
        });
        expect(res.statusCode, `${g.method} ${g.url} grant=${grant}`).toBe(403);
      }
    }
    const state = await w.app.inject({
      method: 'GET',
      url: `/api/events/${w.eventId}/organizer-state`,
      headers: { cookie: w.organizerCookie(), 'x-unmask-grant': expired },
    });
    expect(state.statusCode).toBe(403);
  });

  it('IDOR: a participant of another event cannot read or act on this event', async () => {
    const other = await insertSecondEvent(w.db);
    const get = (url: string) =>
      w.app.inject({ method: 'GET', url, headers: { cookie: other.cookie } });
    expect((await get(`/api/profiles/${w.participantIds[0]}`)).statusCode).toBe(404);
    const mine = (await get('/api/me')).json();
    expect(mine.eventId).toBe(other.eventId);
    // votes for a gift of the other event never succeed
    const [g] = await w.db
      .insert(gifts)
      .values({
        eventId: w.eventId,
        giverId: w.participantIds[0]!,
        aliasNo: 1,
        name: 'x',
        status: 'opened',
      })
      .returning();
    const [cat] = await w.db
      .select()
      .from(votingCategories)
      .where(eq(votingCategories.eventId, w.eventId));
    const res = await w.app.inject({
      method: 'POST',
      url: '/api/me/votes',
      payload: { categoryId: cat!.id, giftId: g!.id },
      headers: { cookie: other.cookie, 'idempotency-key': `idor-${++n}-xxxxxxxx` },
    });
    expect(res.statusCode).not.toBe(200);
    expect(await w.db.select().from(votes).where(eq(votes.giftId, g!.id))).toHaveLength(0);
  });

  it("another participant's public profile exposes name, avatar and achievements only", async () => {
    const me = await w.guestCookie(1);
    const res = await w.app.inject({
      method: 'GET',
      url: `/api/profiles/${w.participantIds[2]}`,
      headers: { cookie: me },
    });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json()).sort()).toEqual([
      'achievements',
      'avatar',
      'displayName',
      'participantId',
    ]);
  });

  it('malformed ids are a 400, never a 500', async () => {
    const me = await w.guestCookie(1);
    const res = await w.app.inject({
      method: 'GET',
      url: '/api/profiles/not-a-uuid',
      headers: { cookie: me },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_request');
  });

  it('removed and taken-down participants lose REST and socket access immediately', async () => {
    const cookie = await w.guestCookie(3);
    const ok = () => w.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect((await ok()).statusCode).toBe(200);
    await w.db
      .update(participants)
      .set({ status: 'removed' })
      .where(eq(participants.id, w.participantIds[3]!));
    for (const url of [
      '/api/me',
      '/api/me/gift',
      '/api/me/votes',
      '/api/me/voting',
      '/api/me/achievements',
      '/api/me/assignment',
    ]) {
      expect(
        (await w.app.inject({ method: 'GET', url, headers: { cookie } })).statusCode,
        url,
      ).toBe(401);
    }
    await expect(connected(w.client(cookie))).rejects.toBeTruthy();

    const cookie4 = await w.guestCookie(4);
    const display = await w.displayCookie();
    await w.db.update(events).set({ suspendedAt: new Date() }).where(eq(events.id, w.eventId));
    expect(
      (await w.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: cookie4 } }))
        .statusCode,
    ).toBe(401);
    await expect(connected(w.client(cookie4))).rejects.toBeTruthy();
    await expect(connected(w.client(display))).rejects.toBeTruthy();
    await w.db.update(events).set({ suspendedAt: null }).where(eq(events.id, w.eventId));
  });
});

describe('sockets cannot bypass publication cadence', () => {
  let w: World;
  beforeAll(async () => {
    w = await createWorld();
    await w.db.update(events).set({ phase: 'voting' }).where(eq(events.id, w.eventId));
    const gs = await w.db
      .insert(gifts)
      .values(
        w.participantIds.map((giverId, i) => ({
          eventId: w.eventId,
          giverId,
          aliasNo: i + 1,
          name: `Present ${i + 1}`,
          status: 'opened' as const,
        })),
      )
      .returning();
    const [cat] = await w.db
      .select()
      .from(votingCategories)
      .where(eq(votingCategories.eventId, w.eventId));
    const cast = (voter: number, gift: number) =>
      w.db
        .insert(votes)
        .values({
          categoryId: cat!.id,
          voterId: w.participantIds[voter]!,
          eventId: w.eventId,
          giftId: gs[gift]!.id,
        })
        .onConflictDoUpdate({
          target: [votes.categoryId, votes.voterId],
          set: { giftId: gs[gift]!.id },
        });
    for (const [v, g] of [
      [0, 1],
      [1, 1],
      [2, 1],
      [3, 2],
      [4, 2],
      [5, 3],
      [6, 4],
      [7, 5],
    ] as const)
      await cast(v, g);
    await boardAction(w.db, {
      eventId: w.eventId,
      actor: 'demo-owner',
      boardKey: cat!.key,
      action: 'enable',
      acknowledgeSmallCohort: true,
      now: new Date(),
    });
    await publishVotedCounter(w.db, w.eventId, new Date());
    // live data moves on AFTER the last publication
    await cast(0, 4);
    await cast(1, 4);
    await cast(2, 4);
    await cast(3, 4);
  }, 60_000);
  afterAll(async () => {
    await w.close();
  });

  const snapshot = async (cookie: string) => {
    const s = w.client(cookie);
    await connected(s);
    const got: Msg[] = [];
    s.on('snapshot', (m: Msg) => got.push(m));
    s.emit('subscribe', {});
    await sleep(300);
    return got;
  };
  const pubData = (msgs: Msg[]) => msgs.find((m) => m.stream === 'pub')!.data!;
  const entries = (msgs: Msg[]) =>
    (
      pubData(msgs)['leaderboards'] as {
        boards: Array<{ entries: Array<{ label: string; rank: number }> }>;
      }
    ).boards[0]!.entries;

  it('reconnecting (any number of times) returns the last PUBLISHED board and counter, never live data', async () => {
    const first = entries(await snapshot(await w.guestCookie(0)));
    const again = entries(await snapshot(await w.guestCookie(0)));
    const display = entries(await snapshot(await w.displayCookie()));
    expect(again).toEqual(first);
    expect(display).toEqual(first);
    expect(first[0]!.label).toBe('Gift 2'); // published leader; live data now favours Gift 5
    expect(
      (pubData(await snapshot(await w.displayCookie()))['scene'] as { votedCount: number })
        .votedCount,
    ).toBe(8);
  });

  it('only a cadence tick changes what reconnecting clients see; snapshots carry no totals/votes/scores', async () => {
    await publishLiveBoards(w.db, w.eventId, new Date());
    await publishVotedCounter(w.db, w.eventId, new Date());
    const msgs = await snapshot(await w.guestCookie(1));
    expect(entries(msgs)[0]!.label).toBe('Gift 5');
    expect(
      scanForbidden(msgs, {
        keys: [
          'score',
          'voterId',
          'giverId',
          'recipientId',
          'openingOrder',
          'aliasNo',
          'createdAt',
        ],
      }),
    ).toEqual([]);
  });

  it('boards carry a localized name; "is this entry mine" = entryId equals my own gift id (no per-person payload)', async () => {
    const msgs = await snapshot(await w.guestCookie(1));
    const board = (
      pubData(msgs)['leaderboards'] as {
        boards: Array<{
          boardKey: string;
          name: Record<string, string>;
          entries: Array<{ entryId: string }>;
        }>;
      }
    ).boards[0]!;
    expect(board.name['en']).toBeTruthy();
    expect(board.name['it']).toBeTruthy();
    const mine = async (i: number) =>
      (
        await w.app.inject({
          method: 'GET',
          url: '/api/me/gift',
          headers: { cookie: await w.guestCookie(i) },
        })
      ).json().gift?.giftId ?? (undefined as string | undefined);
    const leaderGift = board.entries[0]!.entryId;
    const owners = await Promise.all([0, 1, 2, 3, 4, 5].map(mine));
    expect(owners.filter((g) => g === leaderGift)).toHaveLength(1);
  });

  it('a participant cannot subscribe to organizer or grant streams', async () => {
    const s = w.client(await w.guestCookie(2));
    await connected(s);
    const got: Msg[] = [];
    s.on('snapshot', (m: Msg) => got.push(m));
    s.emit('subscribe', { streams: ['org', `grant:${NIL}`] });
    await sleep(300);
    expect(got.filter((m) => m.stream === 'org' || m.stream.startsWith('grant:'))).toEqual([]);
  });
});
