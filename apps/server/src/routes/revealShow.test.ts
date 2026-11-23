import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  REVEAL_CHOICE_CLOSE_JOB,
  auditLog,
  closeShowChoice,
  enqueueJob,
  events,
  gifts,
  saveOwnGift,
  showChoiceBallots,
  showChoiceRounds,
  voteShowChoice,
} from '@santa/db';
import { scanForbidden } from '@santa/contracts';
import { JobRunner } from '../jobs/runner.js';
import { registerRevealJobs } from '../realtime/reveal.js';
import { connected, createWorld, insertSecondEvent, sleep, type World } from '../testing/world.js';

type Msg = { stream: string; surface?: string; payload?: unknown; data?: Record<string, unknown> };
type Choice = { status: string; round: number; endsAt: string; result: string | null } | null;
type RevealScene = {
  scene: 'reveal';
  reveal: {
    current: { stage: string } | null;
    lights?: number;
    choice?: Choice;
    effect?: string | null;
  };
};

describe('reveal show extras over the wire: Light the Tree + Snowstorm vs Sleigh Bells', () => {
  let w: World;
  let n = 0;
  let giftIds: string[];
  const guest: string[] = [];
  const org = (method: 'GET' | 'POST', url: string, cookie?: string) =>
    w.app.inject({
      method,
      url: `/api/events/${w.eventId}${url}`,
      headers: {
        'idempotency-key': `rs-${++n}-xxxxxxxx`,
        cookie: cookie ?? w.organizerCookie('demo-owner', 'sess-o'),
      },
    });
  const me = (i: number, method: 'GET' | 'POST', url: string, body?: unknown) =>
    w.app.inject({
      method,
      url: `/api/me${url}`,
      ...(body === undefined ? {} : { payload: body as object }),
      headers: { 'idempotency-key': `rsm-${++n}-xxxxxxxx`, cookie: guest[i]! },
    });
  const runnerAt = (offsetMs: number) => {
    const clock = () => new Date(Date.now() + offsetMs);
    const r = new JobRunner(w.db, { clock });
    registerRevealJobs(r, w.app.hub!, w.db, clock);
    return r;
  };
  let displayMsgs: Msg[];
  let guestMsgs: Msg[];
  const scenes = (msgs: Msg[]) =>
    msgs.flatMap((m) =>
      m.surface === 'scene' ? [m.payload] : m.data?.['scene'] ? [m.data['scene']] : [],
    ) as RevealScene[];
  const lastScene = (msgs: Msg[]) => scenes(msgs).at(-1)!;
  const vote = (i: number, round: number, choice: string) =>
    me(i, 'POST', '/reveal/choice', { round, choice });

  beforeAll(async () => {
    w = await createWorld();
    for (let i = 0; i < 8; i++) {
      await saveOwnGift(w.db, {
        participantId: w.participantIds[i]!,
        name: `Gift of ${i}`,
        description: null,
        now: new Date(),
      });
      guest.push(await w.guestCookie(i));
    }
    const rows = await w.db.select().from(gifts).where(eq(gifts.eventId, w.eventId));
    giftIds = w.participantIds.map((id) => rows.find((g) => g.giverId === id)!.id);
    const t0 = Date.now() - 600_000;
    for (const [k, id] of giftIds.entries())
      await w.db
        .update(gifts)
        .set({ status: 'opened', openedAt: new Date(t0 + k * 1000) })
        .where(eq(gifts.id, id));
    await w.db
      .update(events)
      .set({ phase: 'voting', giftOpeningStartedAt: new Date(t0), votingClosedAt: new Date() })
      .where(eq(events.id, w.eventId));
    const display = w.client(await w.displayCookie());
    const g0 = w.client(guest[0]!);
    await Promise.all([connected(display), connected(g0)]);
    displayMsgs = [];
    guestMsgs = [];
    for (const [s, sink] of [
      [display, displayMsgs],
      [g0, guestMsgs],
    ] as const) {
      s.on('snapshot', (m: Msg) => sink.push(m));
      s.on('delta', (m: Msg) => sink.push(m));
      s.emit('subscribe', {});
    }
    await sleep(400);
  }, 60_000);
  afterAll(async () => {
    await w.close();
  });

  it('before the reveal phase: taps and choice are refused', async () => {
    expect((await me(0, 'POST', `/reveal/gifts/${giftIds[0]}/light`)).json().error.code).toBe(
      'invalid_step',
    );
    const r = await org('POST', '/reveal/choice');
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('reveal_not_started');
  });

  it('reveal phase: empty extras on the stage; a drumroll blocks the choice; unrevealed gifts cannot be lit', async () => {
    expect((await org('POST', '/phase')).statusCode).toBe(400); // sanity: body required
    expect(
      (
        await w.app.inject({
          method: 'POST',
          url: `/api/events/${w.eventId}/phase`,
          payload: { to: 'reveal' },
          headers: {
            'idempotency-key': `rs-${++n}-xxxxxxxx`,
            cookie: w.organizerCookie('demo-owner', 's'),
          },
        })
      ).statusCode,
    ).toBe(200);
    await sleep(300);
    expect(lastScene(displayMsgs).reveal).toMatchObject({ lights: 0, choice: null, effect: null });
    expect((await org('POST', '/reveal/next')).statusCode).toBe(200); // gift 0 on stage, drumroll
    const busy = await org('POST', '/reveal/choice');
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error.code).toBe('stage_busy');
    const tap = await me(1, 'POST', `/reveal/gifts/${giftIds[0]}/light`);
    expect(tap.statusCode).toBe(409);
    expect(tap.json().error.code).toBe('gift_not_revealed');
    expect(await runnerAt(6_000).tick()).toBe(1); // unveil
  });

  it('Light the Tree: one tap per participant per gift, cumulative durable total, own state private', async () => {
    const r1 = await me(1, 'POST', `/reveal/gifts/${giftIds[0]}/light`);
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toEqual({ giftId: giftIds[0], lit: true, lights: 1 });
    expect((await me(1, 'POST', `/reveal/gifts/${giftIds[0]}/light`)).json().lights).toBe(1); // repeat: no-op
    expect((await me(2, 'POST', `/reveal/gifts/${giftIds[0]}/light`)).json().lights).toBe(2);
    expect((await me(3, 'POST', `/reveal/gifts/${giftIds[0]}/light`)).json().lights).toBe(3);
    // other event / unknown gift: indistinguishable refusal
    const other = await insertSecondEvent(w.db, 'rs-outsider');
    const foreign = await w.app.inject({
      method: 'POST',
      url: `/api/me/reveal/gifts/${giftIds[0]}/light`,
      headers: { 'idempotency-key': 'rs-foreign-xxxxxxxx', cookie: other.cookie },
    });
    expect(foreign.statusCode).toBe(409);
    expect(
      await w.app
        .inject({
          method: 'POST',
          url: `/api/me/reveal/gifts/${giftIds[0]}/light`,
          headers: { 'idempotency-key': 'rs-anon-xxxxxxxx' },
        })
        .then((r) => r.statusCode),
    ).toBe(401);

    await sleep(1_400); // coalesced scene push (<= 1/s)
    expect(lastScene(displayMsgs).reveal.lights).toBe(3);
    expect(lastScene(guestMsgs).reveal.lights).toBe(3);
    expect((await me(1, 'GET', '/reveal/show')).json()).toEqual({
      litGiftIds: [giftIds[0]],
      choice: null,
    });
    expect((await me(4, 'GET', '/reveal/show')).json()).toEqual({ litGiftIds: [], choice: null });
    // who lit is never on a public/participant stream
    expect(
      scanForbidden([displayMsgs, guestMsgs], { keys: ['litGiftIds', 'lighters', 'lightsByGift'] }),
    ).toEqual([]);

    // durable: a reconnecting display gets the total from its snapshot
    const d2 = w.client(await w.displayCookie());
    await connected(d2);
    const snap = new Promise<Msg>((res) => d2.once('snapshot', res));
    d2.emit('subscribe', {});
    expect(((await snap).data!['scene'] as RevealScene).reveal.lights).toBe(3);
  });

  it('choice round: 10 s server deadline, one final vote, no live tally anywhere, server closes with the winner', async () => {
    const before = Date.now();
    const start = await org('POST', '/reveal/choice');
    expect(start.statusCode).toBe(200);
    const st = start.json();
    expect(st).toMatchObject({
      lights: 3,
      effect: null,
      choice: { status: 'open', round: 1, result: null },
    });
    const ends = Date.parse(st.choice.endsAt);
    expect(ends - before).toBeGreaterThanOrEqual(9_900);
    expect(ends - before).toBeLessThan(11_500);
    expect((await org('POST', '/reveal/choice')).json().error.code).toBe('choice_open');

    await sleep(300); // the start push itself
    const pushesBefore = scenes(displayMsgs).length;
    const picks = [
      'snowstorm',
      'snowstorm',
      'snowstorm',
      'sleigh_bells',
      'snowstorm',
      'sleigh_bells',
    ];
    for (const [i, c] of picks.entries()) {
      const r = await vote(i, 1, c);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ round: 1, choice: c });
    }
    expect((await vote(0, 1, 'sleigh_bells')).json().error.code).toBe('already_submitted');
    expect((await vote(6, 2, 'snowstorm')).json().error.code).toBe('round_not_open');
    expect((await vote(6, 1, 'blizzard')).statusCode).toBe(400);
    expect((await me(3, 'GET', '/reveal/show')).json().choice).toEqual({
      round: 1,
      myChoice: 'sleigh_bells',
    });
    expect((await me(7, 'GET', '/reveal/show')).json().choice).toEqual({
      round: 1,
      myChoice: null,
    });
    // organizers get no tally either
    expect((await org('GET', '/reveal/show')).json()).toEqual(st);
    await sleep(1_200);
    // votes push nothing; every pushed open round is result-free and count-free
    expect(scenes(displayMsgs).length).toBe(pushesBefore);
    for (const s of scenes([...displayMsgs, ...guestMsgs]))
      if (s.reveal?.choice?.status === 'open') expect(s.reveal.choice.result).toBeNull();
    expect(
      scanForbidden([displayMsgs, guestMsgs], {
        keys: [
          'myChoice',
          'voterId',
          'ballots',
          'tally',
          'litGiftIds',
        ] /* `votes`/`counts` are legit existing keys */,
      }),
    ).toEqual([]);

    // a vote after the deadline is refused even before the close job runs
    await expect(
      voteShowChoice(w.db, {
        eventId: w.eventId,
        participantId: w.participantIds[7]!,
        round: 1,
        choice: 'sleigh_bells',
        now: new Date(ends),
      }),
    ).rejects.toMatchObject({ code: 'round_not_open' });

    expect(await runnerAt(5_000).tick()).toBe(0); // not due
    expect(await runnerAt(11_500).tick()).toBe(1);
    await sleep(300);
    for (const msgs of [displayMsgs, guestMsgs])
      expect(lastScene(msgs).reveal).toMatchObject({
        choice: { status: 'closed', round: 1, result: 'snowstorm' },
        effect: 'snowstorm',
      });
    // only the outcome survives; ballots are gone
    expect(await w.db.select().from(showChoiceBallots)).toEqual([]);
    expect((await me(0, 'GET', '/reveal/show')).json().choice).toBeNull();
    const audit = await w.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'reveal.choice.close'));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toMatch(/snowstorm|sleigh/);

    // at-least-once: duplicate delivery is a no-op
    const [round] = await w.db.select().from(showChoiceRounds);
    await enqueueJob(w.db, {
      eventId: w.eventId,
      kind: REVEAL_CHOICE_CLOSE_JOB,
      runAt: new Date(Date.now() - 1000),
      payload: { roundId: round!.id },
    });
    const pushes = scenes(displayMsgs).length;
    expect(await runnerAt(12_000).tick()).toBe(1);
    await sleep(200);
    expect(scenes(displayMsgs).length).toBe(pushes);
  });

  const playRound = async (round: number, picks: string[]) => {
    expect((await org('POST', '/reveal/choice')).json().choice).toMatchObject({
      status: 'open',
      round,
    });
    for (const [i, c] of picks.entries()) expect((await vote(i, round, c)).statusCode).toBe(200);
    const [r] = await w.db
      .select()
      .from(showChoiceRounds)
      .where(eq(showChoiceRounds.roundNo, round));
    expect(
      (
        await closeShowChoice(w.db, {
          eventId: w.eventId,
          roundId: r!.id,
          now: new Date(Date.now() + 10_500),
        })
      ).changed,
    ).toBe(true);
    return (await org('GET', '/reveal/show')).json();
  };

  it('below the 5-voter floor, ties and empty rounds all end in a neutral `none` (no effect)', async () => {
    expect(
      await playRound(2, ['sleigh_bells', 'sleigh_bells', 'sleigh_bells', 'sleigh_bells']),
    ).toMatchObject({
      choice: { status: 'closed', round: 2, result: 'none' },
      effect: null,
    });
    expect(
      await playRound(3, [
        'snowstorm',
        'snowstorm',
        'snowstorm',
        'sleigh_bells',
        'sleigh_bells',
        'sleigh_bells',
      ]),
    ).toMatchObject({ choice: { result: 'none' }, effect: null });
    expect(await playRound(4, [])).toMatchObject({ choice: { result: 'none' }, effect: null });
    expect(
      await playRound(5, [
        'sleigh_bells',
        'sleigh_bells',
        'sleigh_bells',
        'snowstorm',
        'sleigh_bells',
      ]),
    ).toMatchObject({ choice: { result: 'sleigh_bells' }, effect: 'sleigh_bells' });
  });

  it('organizer cancel: early close with no effect; ballots discarded; the pending job is a no-op', async () => {
    expect((await org('POST', '/reveal/choice')).statusCode).toBe(200);
    for (let i = 0; i < 6; i++) await vote(i, 6, 'snowstorm');
    const c = await org('POST', '/reveal/choice/cancel');
    expect(c.statusCode).toBe(200);
    expect(c.json()).toMatchObject({
      choice: { status: 'closed', round: 6, result: 'none' },
      effect: null,
    });
    expect(await w.db.select().from(showChoiceBallots)).toEqual([]);
    expect((await vote(6, 6, 'snowstorm')).json().error.code).toBe('round_not_open');
    expect((await org('POST', '/reveal/choice/cancel')).json().error.code).toBe('round_not_open');
    await sleep(300);
    expect(lastScene(displayMsgs).reveal.choice).toMatchObject({ round: 6, result: 'none' });
  });

  it('a side presentation (spotlight) owns the screen: no choice round until it is hidden', async () => {
    const hdr = (k: string) => ({
      'idempotency-key': `rs-sp-${k}-xxxxxxxx`,
      cookie: w.organizerCookie('demo-owner', 'sess-o'),
    });
    const shown = await w.app.inject({
      method: 'POST',
      url: `/api/events/${w.eventId}/presentations`,
      headers: hdr('show'),
      payload: { kind: 'santa_detective' },
    });
    expect(shown.statusCode).toBe(200);
    const busy = await org('POST', '/reveal/choice');
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error.code).toBe('stage_busy');
    const hidden = await w.app.inject({
      method: 'DELETE',
      url: `/api/events/${w.eventId}/presentations`,
      headers: hdr('hide'),
    });
    expect(hidden.statusCode).toBe(200);
    const ok = await org('POST', '/reveal/choice');
    expect(ok.statusCode).toBe(200);
    expect((await org('POST', '/reveal/choice/cancel')).statusCode).toBe(200);
  });

  it('authorization: participants and non-members cannot run the choice', async () => {
    const asGuest = await w.app.inject({
      method: 'POST',
      url: `/api/events/${w.eventId}/reveal/choice`,
      headers: { 'idempotency-key': 'rs-guest-xxxxxxxx', cookie: guest[1]! },
    });
    expect([401, 403]).toContain(asGuest.statusCode);
    expect(
      (await org('POST', '/reveal/choice', w.organizerCookie('stranger', 's'))).statusCode,
    ).toBe(403);
    expect((await org('GET', '/reveal/show', w.organizerCookie('stranger', 's'))).statusCode).toBe(
      403,
    );
    const anon = await w.app.inject({ method: 'GET', url: '/api/me/reveal/show' });
    expect(anon.statusCode).toBe(401);
  });

  it('existing reactions still work during the reveal show', async () => {
    const g = w.client(guest[5]!);
    await connected(g);
    g.emit('subscribe', {});
    await sleep(200);
    const got: unknown[] = [];
    const d = w.client(await w.displayCookie());
    await connected(d);
    d.on('reaction', (m) => got.push(m));
    d.emit('subscribe', {});
    await sleep(200);
    g.emit('reaction.send', { kind: 'love' });
    await sleep(1_500);
    expect(got.length).toBeGreaterThanOrEqual(1);
  });
});
