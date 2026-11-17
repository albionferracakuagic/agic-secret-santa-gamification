import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  events,
  gifts,
  participantAchievements,
  participants,
  santaGuesses,
  scheduledJobs,
  xpLedger,
} from '@santa/db';
import { scanForbidden } from '@santa/contracts';
import { connected, createWorld, insertSecondEvent, sleep, type World } from '../testing/world.js';
import { JobRunner } from '../jobs/runner.js';
import { registerPhase2Jobs } from '../realtime/phase2.js';

type Msg = {
  stream: string;
  surface?: string;
  payload?: Record<string, unknown>;
  data?: Record<string, unknown>;
};

let w: World;
let n = 0;
let now = new Date('2026-12-24T20:00:00Z');
const tick = (sec: number) => (now = new Date(now.getTime() + sec * 1000));
const OWNER = () => w.organizerCookie('demo-owner', 'sess-o');
let giftIds: string[];
let cookies: string[];

const call = (
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  o: { cookie?: string; body?: unknown } = {},
) =>
  w.app.inject({
    method,
    url: url.startsWith('/api/') ? url : `/api/events/${w.eventId}${url}`,
    ...(o.body === undefined ? {} : { payload: o.body as object }),
    headers: { 'idempotency-key': `p2-${++n}-xxxxxxxx`, cookie: o.cookie ?? OWNER() },
  });

const setPhase = (phase: 'gift_opening' | 'games' | 'reveal' | 'awards') =>
  w.db
    .update(events)
    .set({ phase, revealStartedAt: new Date('2026-12-24T19:00:00Z') })
    .where(eq(events.id, w.eventId));

describe('Phase 2 API: guesses, clues, missions, games, presentations, certificates', () => {
  let display: ReturnType<World['client']>;
  let anna: ReturnType<World['client']>; // participant 1 (guesser)
  let bob: ReturnType<World['client']>; // participant 2 (another player)
  const dSeen: Msg[] = [];
  const aSeen: Msg[] = [];
  const bSeen: Msg[] = [];

  const surfaces = (seen: Msg[], surface: string) =>
    seen.filter((m) => m.surface === surface).map((m) => m.payload!);

  beforeAll(async () => {
    w = await createWorld({ clock: () => now });
    const [ev] = await w.db.select().from(events).where(eq(events.id, w.eventId));
    await w.db
      .update(events)
      .set({
        phase: 'gift_opening',
        settings: {
          ...ev!.settings,
          features: { ...ev!.settings.features, guessSanta: true, missions: true },
        },
      })
      .where(eq(events.id, w.eventId));
    giftIds = (
      await w.db
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
        .returning()
    ).map((g) => g.id);
    cookies = await Promise.all(w.participantIds.map((_, i) => w.guestCookie(i)));
    display = w.client(await w.displayCookie());
    anna = w.client(cookies[1]!);
    bob = w.client(cookies[2]!);
    for (const [c, seen] of [
      [display, dSeen],
      [anna, aSeen],
      [bob, bSeen],
    ] as const) {
      await connected(c);
      c.on('snapshot', (m: Msg) => seen.push(m));
      c.on('delta', (m: Msg) => seen.push(m));
      c.emit('subscribe', {});
    }
    await sleep(400);
  }, 60_000);
  afterAll(async () => {
    await w.close();
  });

  /* ---------------------------------------------------------------- guesses */

  it('guess screen: suspects alphabetical without self; one editable guess; own data only', async () => {
    const r = await call('GET', '/api/me/guess', { cookie: cookies[1]! });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.enabled).toBe(true);
    // participant 1 is Marco: everybody else, alphabetical, never himself
    expect(body.suspects.map((s: { displayName: string }) => s.displayName)).toEqual([
      'Chiara',
      'Davide',
      'Elena',
      'Giulia',
      'Luca',
      'Paolo',
      'Sofia',
    ]);
    expect(
      body.suspects.some((s: { participantId: string }) => s.participantId === w.participantIds[1]),
    ).toBe(false);

    const own = await call('PUT', `/api/me/guesses/${giftIds[1]}`, {
      cookie: cookies[1]!,
      body: { suspectId: w.participantIds[0] },
    });
    expect(own.statusCode).toBe(422);
    expect(own.json().error.code).toBe('own_gift');
    const self = await call('PUT', `/api/me/guesses/${giftIds[0]}`, {
      cookie: cookies[1]!,
      body: { suspectId: w.participantIds[1] },
    });
    expect(self.json().error.code).toBe('invalid_suspect');
    const bad = await call('PUT', `/api/me/guesses/${giftIds[0]}`, {
      cookie: cookies[1]!,
      body: { suspectId: 'nope', extra: 1 },
    });
    expect(bad.statusCode).toBe(400);
    const ok = await call('PUT', `/api/me/guesses/${giftIds[0]}`, {
      cookie: cookies[1]!,
      body: { suspectId: w.participantIds[0] },
    });
    expect(ok.statusCode).toBe(200);
    await call('PUT', `/api/me/guesses/${giftIds[0]}`, {
      cookie: cookies[1]!,
      body: { suspectId: w.participantIds[3] },
    });
    // bob (a different guesser) never sees anna's guess; guess state is per-caller
    const bobState = (await call('GET', '/api/me/guess', { cookie: cookies[2]! })).json();
    expect(bobState.gifts.every((g: { myGuess: string | null }) => g.myGuess === null)).toBe(true);
    const annaState = (await call('GET', '/api/me/guess', { cookie: cookies[1]! })).json();
    expect(annaState.gifts.find((g: { giftId: string }) => g.giftId === giftIds[0]).myGuess).toBe(
      w.participantIds[3],
    );
    // organizer / display sessions cannot read guess state
    expect((await call('GET', '/api/me/guess', { cookie: OWNER() })).statusCode).toBe(401);
    expect(
      (await call('GET', '/api/me/guess', { cookie: await w.displayCookie() })).statusCode,
    ).toBe(401);
    expect(scanForbidden(annaState, { keys: ['giverId', 'guesserId'] })).toEqual([]);
  });

  it('other-event participants cannot guess on this event', async () => {
    const other = await insertSecondEvent(w.db);
    const r = await call('PUT', `/api/me/guesses/${giftIds[0]}`, {
      cookie: other.cookie,
      body: { suspectId: w.participantIds[0] },
    });
    expect([404, 409]).toContain(r.statusCode);
    expect((await w.db.select().from(santaGuesses)).every((g) => g.eventId === w.eventId)).toBe(
      true,
    );
  });

  it('clues: filter + moderation queue; approval is announced anonymously on the public stream', async () => {
    const giver = cookies[2]!; // bob gave gift 3
    const rejected = await call('POST', '/api/me/clues', {
      cookie: giver,
      body: { text: 'it is me, haha' },
    });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json().error.code).toBe('clue_not_allowed');
    const sent = await call('POST', '/api/me/clues', {
      cookie: giver,
      body: { text: 'Loves long winter walks' },
    });
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toMatchObject({ status: 'pending' });
    const before = dSeen.length;
    // pending clue is not public anywhere
    expect(
      (await call('GET', '/api/me/guess', { cookie: cookies[1]! })).json().gifts[2].clues,
    ).toEqual([]);

    const queue = (await call('GET', '/clues')).json();
    expect(queue.clues).toHaveLength(1);
    expect(queue.clues[0]).toMatchObject({
      alias: 'Gift 3',
      text: 'Loves long winter walks',
      status: 'pending',
    });
    expect(
      scanForbidden(queue, {
        values: [w.participantIds[2]!],
        keys: ['giverId', 'authorId', 'participantId'],
      }),
    ).toEqual([]);
    expect((await call('GET', '/clues', { cookie: giver })).statusCode).toBe(401); // participants cannot moderate

    const dec = await call('POST', `/clues/${queue.clues[0].clueId}`, {
      body: { action: 'approve' },
    });
    expect(dec.json()).toMatchObject({ status: 'approved' });
    await sleep(300);
    const ann = surfaces(dSeen.slice(before), 'announcement').find((p) => p['type'] === 'clue')!;
    expect(ann).toMatchObject({ type: 'clue', alias: 'Gift 3', text: 'Loves long winter walks' });
    expect(scanForbidden(ann, { values: [w.participantIds[2]!] })).toEqual([]);
    expect(
      (await call('GET', '/api/me/guess', { cookie: cookies[1]! })).json().gifts[2].clues,
    ).toHaveLength(1);
  });

  it('reveal settles guesses: the guesser gets a playful result on THEIR stream only; XP non-qualifying', async () => {
    await setPhase('reveal');
    const aBefore = aSeen.length;
    const bBefore = bSeen.length;
    const dBefore = dSeen.length;
    // anna guessed gift 1's giver wrongly (Luca instead of Giulia): playful, no penalty
    const r = await call('POST', `/reveal/gifts/${giftIds[0]}`);
    expect(r.statusCode).toBe(200);
    await sleep(400);
    const mine = surfaces(aSeen.slice(aBefore), 'announcement').find(
      (p) => p['type'] === 'guess_result',
    )!;
    expect(mine).toMatchObject({
      type: 'guess_result',
      alias: 'Gift 1',
      outcome: 'incorrect',
      cue: 'wink',
      xp: 0,
    });
    for (const seen of [bSeen.slice(bBefore), dSeen.slice(dBefore)])
      expect(surfaces(seen, 'announcement').some((p) => p['type'] === 'guess_result')).toBe(false);
    const state = (await call('GET', '/api/me/guess', { cookie: cookies[1]! })).json();
    expect(state.gifts[0]).toMatchObject({
      state: 'revealed',
      result: { outcome: 'incorrect', cue: 'wink', xp: 0 },
    });
    expect(
      await call('PUT', `/api/me/guesses/${giftIds[0]}`, {
        cookie: cookies[1]!,
        body: { suspectId: w.participantIds[0] },
      }).then((x) => x.json().error.code),
    ).toBe('guess_closed');

    // bob guesses gift 2 right, then it is revealed: +20 XP, non-qualifying
    await setPhase('gift_opening');
    await call('PUT', `/api/me/guesses/${giftIds[1]}`, {
      cookie: cookies[2]!,
      body: { suspectId: w.participantIds[1] },
    });
    await setPhase('reveal');
    await call('POST', `/reveal/gifts/${giftIds[1]}`);
    await sleep(300);
    const ledger = await w.db
      .select()
      .from(xpLedger)
      .where(
        and(
          eq(xpLedger.participantId, w.participantIds[2]!),
          eq(xpLedger.activity, 'guess_correct'),
        ),
      );
    expect(ledger).toEqual([expect.objectContaining({ amount: 20, qualifying: false })]);
    const bobWon = surfaces(bSeen, 'announcement').find(
      (p) => p['type'] === 'guess_result' && p['outcome'] === 'correct',
    );
    expect(bobWon).toMatchObject({ cue: 'confetti', xp: 20 });
  });

  /* ---------------------------------------------------------------- missions */

  it('missions: private to the participant; display learns only that a secret mission was completed', async () => {
    await setPhase('gift_opening');
    const assign = await call('POST', '/missions/assign', { body: {} });
    expect(assign.json()).toEqual({ assigned: 8, participants: 8 });
    const mine = (await call('GET', '/api/me/missions', { cookie: cookies[3]! })).json();
    expect(mine.missions).toHaveLength(1);
    expect(mine.missions[0].title.en).toBeTruthy();
    // nobody else sees it; organizer view is counts only
    const org = (await call('GET', '/missions')).json();
    expect(org.counts).toEqual({ assigned: 8, submitted: 0, verified: 0 });
    expect(org.pending).toEqual([]);
    expect(scanForbidden(org, { keys: ['title', 'missionKey', 'description'] })).toEqual([]);
    expect((await call('GET', '/api/me/missions', { cookie: OWNER() })).statusCode).toBe(401);
    const stranger = await call(
      'POST',
      `/api/me/missions/${mine.missions[0].assignmentId}/submit`,
      { cookie: cookies[4]!, body: {} },
    );
    expect(stranger.statusCode).toBe(404);

    const dBefore = dSeen.length;
    const done = await call('POST', `/api/me/missions/${mine.missions[0].assignmentId}/submit`, {
      cookie: cookies[3]!,
      body: { note: 'did it' },
    });
    expect(done.json()).toMatchObject({ status: 'verified', completed: true, xpAwarded: true });
    await sleep(300);
    // nothing public at completion time (no timing correlation)
    expect(dSeen.slice(dBefore)).toEqual([]);
    // the generic announcement arrives later, from the durable job, with no person/mission/count
    const runner = new JobRunner(w.db, { clock: () => now });
    registerPhase2Jobs(runner, w.app.hub!, w.db, () => now);
    const [job] = await w.db
      .select()
      .from(scheduledJobs)
      .where(eq(scheduledJobs.kind, 'mission.announce'));
    expect(job).toBeTruthy();
    tick(60);
    await runner.tick();
    await sleep(300);
    const generic = surfaces(dSeen.slice(dBefore), 'announcement');
    expect(generic).toEqual([{ type: 'mission_completed', at: now.toISOString() }]);
    expect(
      scanForbidden(generic, {
        values: [w.participantIds[3]!, mine.missions[0].assignmentId],
        keys: ['person', 'key'],
      }),
    ).toEqual([]);
    // opt-out
    const off = await call('POST', '/api/me/missions/opt-out', {
      cookie: cookies[5]!,
      body: { optOut: true },
    });
    expect(off.json()).toEqual({ optedOut: true });
    expect(
      (await call('GET', '/api/me/missions', { cookie: cookies[5]! })).json().missions,
    ).toEqual([]);
  });

  /* ---------------------------------------------------------------- games */

  it('trivia over HTTP: scene to the display, answers hidden until close, durable timers, privacy of own state', async () => {
    await setPhase('games');
    const created = await call('POST', '/games', {
      body: {
        kind: 'trivia',
        config: { rounds: 1, introSeconds: 2, roundSeconds: 10, revealSeconds: 2 },
      },
    });
    expect(created.statusCode).toBe(201);
    const { gameId } = created.json();
    expect(
      (await call('POST', '/games', { cookie: cookies[1]!, body: { kind: 'trivia' } })).statusCode,
    ).toBe(401);
    expect(
      (await call('POST', `/games/${gameId}`, { body: { action: 'start' } })).json(),
    ).toMatchObject({ status: 'intro' });
    await sleep(300);
    const scene = surfaces(dSeen, 'scene').at(-1)!;
    expect(scene).toMatchObject({ scene: 'game', game: { kind: 'trivia', status: 'intro' } });

    const runner = new JobRunner(w.db, { clock: () => now });
    registerPhase2Jobs(runner, w.app.hub!, w.db, () => now);
    tick(3);
    await runner.tick(); // intro timer -> round opens
    await sleep(300);
    const open = surfaces(dSeen, 'scene').at(-1) as {
      game: {
        status: string;
        round: { options: Array<{ id: string }>; correctOptionIds: unknown };
      };
    };
    expect(open.game.status).toBe('round_open');
    expect(open.game.round.correctOptionIds).toBeNull(); // the answer is not in any pre-close payload
    expect(scanForbidden(open, { keys: ['correctIds', 'giftId', 'score', 'points'] })).toEqual([]);

    const answerId = open.game.round.options[0]!.id;
    const a1 = await call('POST', '/api/me/game/answers', {
      cookie: cookies[1]!,
      body: { answerId },
    });
    expect(a1.statusCode).toBe(200);
    expect(
      (
        await call('POST', '/api/me/game/answers', { cookie: cookies[1]!, body: { answerId } })
      ).json().error.code,
    ).toBe('already_submitted');
    expect(
      (
        await call('POST', '/api/me/game/answers', {
          cookie: cookies[2]!,
          body: { answerId: 'zzz' },
        })
      ).json().error.code,
    ).toBe('invalid_answer');
    await call('POST', '/api/me/game/answers', { cookie: cookies[2]!, body: { answerId } });
    const myState = (await call('GET', '/api/me/game', { cookie: cookies[1]! })).json();
    expect(myState.me).toMatchObject({ submitted: true, answerId });
    expect((await call('GET', '/api/me/game', { cookie: cookies[3]! })).json().me).toMatchObject({
      submitted: false,
      answerId: null,
    });
    await sleep(1300); // coalesced submission counter push
    const counted = surfaces(dSeen, 'scene').at(-1) as {
      game: { round: { submissionCount: number } };
    };
    expect(counted.game.round.submissionCount).toBe(2);

    tick(11);
    await runner.tick(); // round timer -> closed (answer revealed)
    await sleep(300);
    const closed = surfaces(dSeen, 'scene').at(-1) as {
      game: { status: string; round: { correctOptionIds: string[] } };
    };
    expect(closed.game.status).toBe('round_closed');
    expect(closed.game.round.correctOptionIds).toHaveLength(1);
    tick(3);
    await runner.tick(); // reveal ends -> results
    await sleep(300);
    const res = surfaces(dSeen, 'scene').at(-1) as {
      game: { status: string; results: { message: string | null } };
    };
    expect(res.game.status).toBe('results');
    expect(res.game.results.message).toBe('christmas_magic'); // 2 players < the 5-player floor
    expect(
      await call('POST', `/games/${gameId}`, { body: { action: 'finish' } }).then(
        (r) => r.json().status,
      ),
    ).toBe('finished');
    await sleep(300);
    expect(surfaces(dSeen, 'scene').at(-1)).toMatchObject({ scene: 'phase', phase: 'games' });
  });

  /* ---------------------------------------------------------------- presentations */

  it('presentations: canPublish gate, neutral fallback, organizer-only reason', async () => {
    await setPhase('reveal');
    const r = await call('POST', '/presentations', { body: { kind: 'santa_detective' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      kind: 'santa_detective',
      published: false,
      reason: 'insufficient_voters',
      achievementsUnlocked: 0,
    });
    await sleep(300);
    const spot = surfaces(dSeen, 'scene').at(-1)!;
    expect(spot).toMatchObject({
      scene: 'spotlight',
      spotlight: { kind: 'santa_detective', message: 'christmas_magic', entries: [] },
    });
    expect(JSON.stringify(spot)).not.toContain('insufficient'); // reason never leaves the organizer response
    expect(
      (
        await call('POST', '/presentations', {
          cookie: cookies[1]!,
          body: { kind: 'santa_detective' },
        })
      ).statusCode,
    ).toBe(401);
    expect((await call('POST', '/presentations', { body: { kind: 'bogus' } })).statusCode).toBe(
      400,
    );
    await setPhase('games');
    expect(
      (await call('POST', '/presentations', { body: { kind: 'santa_detective' } })).json().error
        .code,
    ).toBe('presentation_not_available');
    expect((await call('DELETE', '/presentations')).json()).toEqual({ hidden: true });
  });

  /* ---------------------------------------------------------------- certificates (FR-041) */

  it("certificates: PNG for an unlocked achievement only, EN/IT, never someone else's", async () => {
    await w.db.insert(participantAchievements).values({
      eventId: w.eventId,
      participantId: w.participantIds[1]!,
      key: 'santa_detective',
      source: 'test',
    });
    const list = (await call('GET', '/api/me/certificates', { cookie: cookies[1]! })).json();
    expect(list.certificates).toContainEqual({
      key: 'santa_detective',
      title: { en: 'Santa Detective', it: 'Detective di Babbo Natale' },
      url: '/api/me/achievements/santa_detective/certificate.png',
    });
    const others = (await call('GET', '/api/me/certificates', { cookie: cookies[2]! })).json();
    expect(others.certificates.map((c: { key: string }) => c.key)).not.toContain('santa_detective');
    const en = await call('GET', '/api/me/achievements/santa_detective/certificate.png?locale=en', {
      cookie: cookies[1]!,
    });
    expect(en.statusCode).toBe(200);
    expect(en.headers['content-type']).toBe('image/png');
    expect(en.headers['cache-control']).toBe('no-store');
    const png = en.rawPayload;
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(850);
    const it = await call('GET', '/api/me/achievements/santa_detective/certificate.png?locale=it', {
      cookie: cookies[1]!,
    });
    expect(it.rawPayload.equals(png)).toBe(false);
    // not yours / not unlocked / unknown: the same 404
    for (const [cookie, key] of [
      [cookies[2]!, 'santa_detective'],
      [cookies[1]!, 'legendary_santa'],
      [cookies[1]!, 'nope'],
    ] as const)
      expect(
        (await call('GET', `/api/me/achievements/${key}/certificate.png`, { cookie })).statusCode,
      ).toBe(404);
    expect(
      (
        await call('GET', '/api/me/achievements/santa_detective/certificate.png', {
          cookie: OWNER(),
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await call('GET', '/api/me/achievements/santa_detective/certificate.png?locale=fr', {
          cookie: cookies[1]!,
        })
      ).statusCode,
    ).toBe(400);
    // the unlocked achievement is the only thing an owner can render: removing the row removes access
    await w.db.delete(participantAchievements);
    expect(
      (
        await call('GET', '/api/me/achievements/santa_detective/certificate.png', {
          cookie: cookies[1]!,
        })
      ).statusCode,
    ).toBe(404);
  }, 30_000);

  it('removed participants lose every Phase 2 route immediately', async () => {
    await w.db
      .update(participants)
      .set({ status: 'removed' })
      .where(eq(participants.id, w.participantIds[6]!));
    for (const [m, u] of [
      ['GET', '/api/me/guess'],
      ['GET', '/api/me/missions'],
      ['GET', '/api/me/game'],
      ['GET', '/api/me/certificates'],
    ] as const)
      expect((await call(m, u, { cookie: cookies[6]! })).statusCode).toBe(401);
  });
});
