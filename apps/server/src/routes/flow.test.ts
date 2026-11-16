import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { awards, events, gifts, saveOwnGift, scheduledJobs } from '@santa/db';
import { scanForbidden } from '@santa/contracts';
import { JobRunner } from '../jobs/runner.js';
import { registerVotingJobs } from '../realtime/votingJobs.js';
import { collect, connected, createWorld, sleep, type World } from '../testing/world.js';

const NAMES = ['Giulia', 'Marco', 'Sofia', 'Luca', 'Chiara', 'Paolo', 'Elena', 'Davide'];

type Msg = { stream: string; surface?: string; payload?: unknown; data?: Record<string, unknown> };

async function registerAllGifts(w: World) {
  for (let i = 0; i < 8; i++) {
    await saveOwnGift(w.db, {
      participantId: w.participantIds[i]!,
      name: `Gift of ${i}`,
      description: null,
      now: new Date(),
    });
  }
  const rows = await w.db.select().from(gifts).where(eq(gifts.eventId, w.eventId));
  return w.participantIds.map((id) => rows.find((g) => g.giverId === id)!);
}

describe('opening -> voting -> reveal (end to end, with live streams)', () => {
  let w: World;
  let n = 0;
  let byGiver: Array<typeof gifts.$inferSelect>;
  const OWNER = () => w.organizerCookie('demo-owner', 'sess-o');
  const call = (
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    o: { cookie?: string; body?: unknown } = {},
  ) =>
    w.app.inject({
      method,
      url: `/api/events/${w.eventId}${url}`,
      ...(o.body === undefined ? {} : { payload: o.body as object }),
      headers: { 'idempotency-key': `f-${++n}-xxxxxxxx`, cookie: o.cookie ?? OWNER() },
    });
  const me = (method: 'GET' | 'POST', url: string, i: number, body?: unknown) =>
    w.guestCookie(i).then((cookie) =>
      w.app.inject({
        method,
        url,
        ...(body === undefined ? {} : { payload: body as object }),
        headers: { 'idempotency-key': `m-${++n}-xxxxxxxx`, cookie },
      }),
    );

  let display: ReturnType<World['client']>;
  let displayMsgs: Msg[];
  let guestMsgs: Msg[]; // participant 0

  beforeAll(async () => {
    w = await createWorld();
    byGiver = await registerAllGifts(w);
    display = w.client(await w.displayCookie());
    const g0 = w.client(await w.guestCookie(0));
    await Promise.all([connected(display), connected(g0)]);
    displayMsgs = [
      ...(collect(display, 'snapshot') as Msg[]),
      ...(collect(display, 'delta') as Msg[]),
    ];
    // arrays above are separate collectors; merge on read
    const snaps = collect(display, 'snapshot') as Msg[];
    const deltas = collect(display, 'delta') as Msg[];
    displayMsgs = [];
    display.on('snapshot', (m: Msg) => displayMsgs.push(m));
    display.on('delta', (m: Msg) => displayMsgs.push(m));
    void snaps;
    void deltas;
    guestMsgs = [];
    g0.on('snapshot', (m: Msg) => guestMsgs.push(m));
    g0.on('delta', (m: Msg) => guestMsgs.push(m));
    display.emit('subscribe', {});
    g0.emit('subscribe', {});
    await sleep(400);
  }, 60_000);
  afterAll(async () => {
    await w.close();
  });

  const latest = (msgs: Msg[], stream: string, surface: string) => {
    const delta = [...msgs].reverse().find((m) => m.stream === stream && m.surface === surface);
    if (delta) return delta.payload as Record<string, unknown>;
    const snap = [...msgs]
      .reverse()
      .find((m) => m.stream === stream && m.data && surface in m.data);
    return snap?.data?.[surface] as Record<string, unknown> | undefined;
  };
  const noSecrets = (msgs: Msg[], names: string[]) => {
    const text = JSON.stringify(msgs);
    for (const nm of names) expect(text, `leaked name ${nm}`).not.toContain(nm);
    expect(
      scanForbidden(msgs, {
        keys: [
          'giverId',
          'recipientId',
          'voterId',
          'score',
          'openingOrder',
          'aliasNo',
          'createdAt',
        ],
      }),
    ).toEqual([]);
  };

  it('opening: random order, one gift at a time; display scene + gallery follow; nobody sees givers', async () => {
    expect((await call('POST', '/opening/next')).json().error.code).toBe('opening_not_available'); // registration phase
    expect(
      (await call('POST', '/opening/order', { body: { mode: 'manual', order: ['nope'] } })).json()
        .error.code,
    ).toBe('invalid_order');
    expect(
      (await call('POST', '/opening/order', { body: { mode: 'random' } })).json(),
    ).toMatchObject({ mode: 'random', total: 8, openedCount: 0 });

    expect((await call('POST', '/phase', { body: { to: 'gift_opening' } })).statusCode).toBe(200);
    await sleep(300);
    expect(latest(displayMsgs, 'pub', 'scene')).toMatchObject({
      scene: 'opening',
      openedCount: 0,
      total: 8,
      current: null,
    });
    expect(latest(displayMsgs, 'pub', 'giftList')).toMatchObject({
      mode: 'gallery',
      gifts: [],
      currentGiftId: null,
    });

    const first = (await call('POST', '/opening/next')).json();
    expect(first).toMatchObject({ openedCount: 1, total: 8, allOpened: false });
    await sleep(300);
    const gallery = latest(displayMsgs, 'pub', 'giftList') as {
      gifts: Array<{ giftId: string; alias: string }>;
      currentGiftId: string;
    };
    expect(gallery.currentGiftId).toBe(first.currentGiftId);
    expect(gallery.gifts.map((g) => g.giftId)).toEqual([first.currentGiftId]);
    expect(latest(displayMsgs, 'pub', 'scene')).toMatchObject({
      scene: 'opening',
      openedCount: 1,
      current: { giftId: first.currentGiftId, status: 'opened' },
    });
    // participant sees the same public gallery
    expect((latest(guestMsgs, 'pub', 'giftList') as { currentGiftId: string }).currentGiftId).toBe(
      first.currentGiftId,
    );

    for (let i = 0; i < 7; i++) await call('POST', '/opening/next');
    expect((await call('GET', '/opening')).json()).toMatchObject({
      openedCount: 8,
      allOpened: true,
    });
    expect((await call('POST', '/opening/next')).json().error.code).toBe('nothing_to_open');
    await sleep(300);
    noSecrets(displayMsgs, NAMES);
    noSecrets(
      guestMsgs.filter((m) => m.stream === 'pub'),
      NAMES,
    );
    const opened = (latest(displayMsgs, 'pub', 'giftList') as { gifts: unknown[] }).gifts;
    expect(opened).toHaveLength(8);
    expect(opened.every((g) => !('giver' in (g as object)))).toBe(true);
    const aliases = (opened as Array<{ alias: string }>).map((g) =>
      Number(g.alias.replace('Gift ', '')),
    );
    expect(aliases).toEqual([...aliases].sort((a, b) => a - b)); // sorted by alias, not by opening order
  });

  it('reveal is refused before the reveal phase', async () => {
    const r = await call('POST', `/reveal/gifts/${byGiver[1]!.id}`);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('reveal_not_started');
    expect((await call('POST', '/reveal/all')).json().error.code).toBe('reveal_not_started');
  });

  it('voting: open with a server deadline; own gift blocked; one selection per category; XP once; only own selections returned', async () => {
    const before = Date.now();
    const open = await call('POST', '/voting/open', { body: { durationMinutes: 5 } });
    expect(open.statusCode).toBe(200);
    const state = open.json();
    expect(state).toMatchObject({ status: 'open', votedCount: null });
    expect(Date.parse(state.endsAt) - before).toBeGreaterThan(299_000);
    expect(state.categories).toHaveLength(6); // seeded demo event has 6 categories
    await sleep(300);
    expect(latest(displayMsgs, 'pub', 'scene')).toMatchObject({
      scene: 'voting',
      endsAt: state.endsAt,
      votedCount: null,
      closed: false,
    });
    expect(latest(displayMsgs, 'pub', 'eventState')).toMatchObject({
      phase: 'voting',
      votingEndsAt: state.endsAt,
    });

    const cat = state.categories[0].id as string;
    const vote = (i: number, g: number, c = cat) =>
      me('POST', '/api/me/votes', i, { categoryId: c, giftId: byGiver[g]!.id });

    const own = await vote(1, 1);
    expect(own.statusCode).toBe(422);
    expect(own.json().error.code).toBe('own_gift');
    const first = await vote(1, 2);
    expect(first.json()).toEqual({ categoryId: cat, giftId: byGiver[2]!.id, xpAwarded: true });
    expect(Object.keys(first.json()).sort()).toEqual(['categoryId', 'giftId', 'xpAwarded']);
    expect((await vote(1, 2)).json().xpAwarded).toBe(false); // repeated request: same selection, no new XP
    await vote(1, 3); // change of mind replaces the selection
    const mine = (await me('GET', '/api/me/votes', 1)).json().votes as Array<{ giftId: string }>;
    expect(mine).toEqual([{ categoryId: cat, giftId: byGiver[3]!.id }]);
    expect(((await me('GET', '/api/me/votes', 0)).json().votes as unknown[]).length).toBe(0); // others' votes are invisible
    expect((await vote(1, 3, '00000000-0000-0000-0000-000000000000')).json().error.code).toBe(
      'invalid_category',
    );
    expect((await me('POST', '/api/me/votes', 1, { categoryId: cat })).statusCode).toBe(400);
    expect((await call('POST', '/voting/open', { body: {} })).statusCode).toBe(409); // already open
  });

  it('"N voted" appears only on cadence; live boards/totals never leak; display and participants get the same published value', async () => {
    const cat = (await me('GET', '/api/me/voting', 0)).json().categories[0].id as string;
    const vote = (i: number, g: number) =>
      me('POST', '/api/me/votes', i, { categoryId: cat, giftId: byGiver[g]!.id });
    for (const [v, g] of [
      [0, 1],
      [2, 1],
      [3, 1],
      [4, 2],
      [5, 3],
      [6, 1],
    ] as const)
      await vote(v, g);
    await sleep(300);
    expect((await me('GET', '/api/me/voting', 0)).json().votedCount).toBeNull(); // nothing published yet
    expect(latest(displayMsgs, 'pub', 'scene')).toMatchObject({
      scene: 'voting',
      votedCount: null,
    });

    const runner = new JobRunner(w.db, { clock: () => new Date(Date.now() + 11_000) });
    registerVotingJobs(runner, w.app.hub!, w.db, () => new Date(Date.now() + 11_000));
    await runner.tick(); // cadence tick (cadenceSeconds = 10)
    await sleep(300);
    expect(latest(displayMsgs, 'pub', 'scene')).toMatchObject({ scene: 'voting', votedCount: 7 }); // 1 + 6 distinct voters
    expect(latest(displayMsgs, 'pub', 'eventState')).toMatchObject({ votedCount: 7 });
    expect((await me('GET', '/api/me/voting', 0)).json().votedCount).toBe(7);

    await vote(7, 1); // a new voter between ticks stays invisible until the next publication
    await sleep(200);
    expect(latest(displayMsgs, 'pub', 'scene')).toMatchObject({ votedCount: 7 });

    noSecrets(displayMsgs, NAMES);
    noSecrets(
      guestMsgs.filter((m) => m.stream === 'pub'),
      NAMES,
    );
    // no leaderboard/tally surface is ever pushed while voting is open
    expect(
      displayMsgs.some((m) => m.surface === 'leaderboard' || (m.data && 'leaderboard' in m.data)),
    ).toBe(false);
  });

  it('close locks winners via canPublish and rejects later votes; closing again and a late timer job are harmless', async () => {
    const closed = await call('POST', '/voting/close');
    expect(closed.json()).toMatchObject({ categoriesLocked: 6, categoriesPublishable: 1 });
    const rows = await w.db.select().from(awards).where(eq(awards.eventId, w.eventId));
    expect(rows).toHaveLength(6);
    expect(rows.filter((r) => r.publishable)).toHaveLength(1);
    expect(rows.every((r) => r.lockedAt !== null)).toBe(true);

    const again = await call('POST', '/voting/close');
    expect(again.statusCode).toBe(200);
    expect(again.json().categoriesPublishable).toBe(1);
    expect(await w.db.select().from(awards).where(eq(awards.eventId, w.eventId))).toHaveLength(6);

    const cat = (await me('GET', '/api/me/voting', 0)).json();
    expect(cat.status).toBe('closed');
    const late = await me('POST', '/api/me/votes', 2, {
      categoryId: cat.categories[0].id,
      giftId: byGiver[3]!.id,
    });
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe('voting_closed');

    const timer = (
      await w.db.select().from(scheduledJobs).where(eq(scheduledJobs.kind, 'voting.autoclose'))
    )[0]!;
    expect(timer.status).toBe('cancelled');
    const runner = new JobRunner(w.db, { clock: () => new Date(Date.now() + 10 * 60_000) });
    registerVotingJobs(runner, w.app.hub!, w.db, () => new Date(Date.now() + 10 * 60_000));
    await runner.tick();
    expect(await w.db.select().from(awards).where(eq(awards.eventId, w.eventId))).toHaveLength(6);
  });

  it('reveal: per gift and all-at-once, giver appears only after revealedAt, idempotent, no way back', async () => {
    expect((await call('POST', '/phase', { body: { to: 'reveal' } })).statusCode).toBe(200);
    const target = byGiver[2]!;
    const r1 = await call('POST', `/reveal/gifts/${target.id}`);
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toMatchObject({ giftId: target.id, status: 'revealed' });
    await sleep(300);
    const gallery = latest(displayMsgs, 'pub', 'giftList') as {
      gifts: Array<{ giftId: string; giver?: { displayName: string } }>;
    };
    expect(gallery.gifts.find((g) => g.giftId === target.id)!.giver!.displayName).toBe('Sofia');
    expect(gallery.gifts.filter((g) => g.giver)).toHaveLength(1); // everyone else still hidden
    const text = JSON.stringify(latest(displayMsgs, 'pub', 'giftList'));
    for (const nm of NAMES.filter((x) => x !== 'Sofia')) expect(text).not.toContain(nm);

    const r2 = await call('POST', `/reveal/gifts/${target.id}`);
    expect(r2.json().revealedAt).toBe(r1.json().revealedAt); // idempotent

    expect((await call('POST', '/reveal/all')).json()).toEqual({ revealed: 7 });
    expect((await call('POST', '/reveal/all')).json()).toEqual({ revealed: 0 });
    await sleep(300);
    const all = latest(displayMsgs, 'pub', 'giftList') as { gifts: Array<{ giver?: unknown }> };
    expect(all.gifts.every((g) => g.giver)).toBe(true);

    expect((await call('DELETE', `/reveal/gifts/${target.id}`)).statusCode).toBe(404); // no un-reveal endpoint
    expect((await call('POST', '/phase', { body: { to: 'voting' } })).json().error.code).toBe(
      'backstep_after_reveal',
    );
  });

  it('organizer roster is masked; reactions switch shows in the organizer state', async () => {
    const res = await call('GET', '/participants');
    const list = res.json().participants as Array<Record<string, unknown>>;
    expect(list).toHaveLength(8);
    for (const p of list)
      expect(Object.keys(p).sort()).toEqual([
        'displayName',
        'participantId',
        'reactionsMuted',
        'status',
      ]);
    expect(JSON.stringify(res.json())).not.toMatch(/@|email|xp|session/i);
    expect(
      (await call('GET', '/participants', { cookie: w.organizerCookie('stranger', 's') }))
        .statusCode,
    ).toBe(403);

    const mute = await call('POST', `/participants/${w.participantIds[3]}/mute`, {
      body: { muted: true },
    });
    expect(mute.statusCode).toBe(200);
    expect(
      (
        (await call('GET', '/participants')).json().participants as Array<{
          participantId: string;
          reactionsMuted: boolean;
        }>
      ).find((p) => p.participantId === w.participantIds[3])!.reactionsMuted,
    ).toBe(true);

    const org = async () =>
      (await call('GET', '/organizer-state')).json().eventState.organizer.reactionsEnabled;
    expect(await org()).toBe(true);
    await call('POST', '/reactions/settings', { body: { enabled: false } });
    expect(await org()).toBe(false);
    await call('POST', '/reactions/settings', { body: { enabled: true } });
    expect(await org()).toBe(true);
  });
});

describe('voting timer (durable autoclose)', () => {
  it('the autoclose job closes + locks voting at the deadline even if nobody clicks close', async () => {
    const w = await createWorld();
    try {
      const byGiver = await registerAllGifts(w);
      const owner = w.organizerCookie('demo-owner', 'sess-o');
      const post = (url: string, body: unknown) =>
        w.app.inject({
          method: 'POST',
          url: `/api/events/${w.eventId}${url}`,
          payload: body as object,
          headers: {
            cookie: owner,
            'idempotency-key': `t-${url.length}-${Math.random()}-xxxxxxxx`,
          },
        });
      await post('/phase', { to: 'gift_opening' });
      await w.db
        .update(gifts)
        .set({ status: 'opened', openedAt: new Date() })
        .where(eq(gifts.eventId, w.eventId));
      expect((await post('/voting/open', { durationMinutes: 1 })).statusCode).toBe(200);

      const display = w.client(await w.displayCookie());
      await connected(display);
      const msgs: Msg[] = [];
      display.on('delta', (m: Msg) => msgs.push(m));
      display.emit('subscribe', {});
      await sleep(250);

      const clock = () => new Date(Date.now() + 2 * 60_000);
      const runner = new JobRunner(w.db, { clock });
      registerVotingJobs(runner, w.app.hub!, w.db, clock);
      await runner.tick();
      await sleep(300);

      const [e] = await w.db.select().from(events).where(eq(events.id, w.eventId));
      expect(e!.votingClosedAt).not.toBeNull();
      expect(await w.db.select().from(awards).where(eq(awards.eventId, w.eventId))).toHaveLength(6);
      const scene = [...msgs].reverse().find((m) => m.surface === 'scene')!.payload;
      expect(scene).toMatchObject({ scene: 'voting', closed: true });
      void byGiver;
    } finally {
      await w.close();
    }
  });
});
