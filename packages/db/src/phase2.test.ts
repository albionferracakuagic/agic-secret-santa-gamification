import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from './testing.js';
import {
  anonymizeParticipant,
  createEvent,
  EventError,
  removeParticipant,
  revealAllGifts,
  revealGift,
} from './index.js';
import {
  MISSION_ANNOUNCE_JOB,
  advanceGameAuto,
  assignMissions,
  claimMissionAnnouncements,
  clueQueue,
  createGame,
  decideBingoMark,
  decideClue,
  decideMission,
  gameAction,
  gameView,
  guessState,
  markBingo,
  missionMasterResult,
  myGameState,
  myMissions,
  ownClues,
  pendingBingoMarks,
  presentSpotlight,
  setGuess,
  setMissionOptOut,
  settleGuesses,
  spotlightView,
  submitAnswer,
  submitClue,
  submitMission,
  swapMission,
  organizerMissions,
} from './index.js';
import * as s from './schema.js';

const NOW = new Date('2026-12-24T20:00:00Z');
const at = (sec: number) => new Date(NOW.getTime() + sec * 1000);
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: unknown) => (e instanceof EventError ? e.code : `other:${String(e)}`),
  );

let db: TestDb;
let eventId: string;
let ids: string[];
let giftIds: string[];
const NAMES = ['Zoe', 'Anna', 'Marco', 'Bruno', 'Carla', 'Dario', 'Elena', 'Fabio'];

async function setup(n = 8, features = { guessSanta: true, missions: true }) {
  db = await createTestDb();
  await db.insert(s.user).values({ id: 'owner', name: 'O', email: 'o@example.test' });
  const e = await createEvent(db, {
    ownerId: 'owner',
    now: NOW,
    input: {
      name: 'P2',
      startsAt: '2026-12-24T19:00:00Z',
      timezone: 'Europe/Rome',
      defaultLocale: 'en',
    },
  });
  eventId = e.id;
  await db
    .update(s.events)
    .set({
      phase: 'games',
      revealStartedAt: NOW,
      settings: { ...e.settings, features: { ...e.settings.features, ...features } },
    })
    .where(eq(s.events.id, eventId));
  ids = (
    await db
      .insert(s.participants)
      .values(
        NAMES.slice(0, n).map((displayName) => ({
          eventId,
          displayName,
          status: 'active' as const,
          source: 'import' as const,
        })),
      )
      .returning()
  ).map((p) => p.id);
  giftIds = (
    await db
      .insert(s.gifts)
      .values(
        ids.map((giverId, i) => ({
          eventId,
          giverId,
          aliasNo: i + 1,
          name: `Present Number ${i + 1}`,
          status: 'opened' as const,
        })),
      )
      .returning()
  ).map((g) => g.id);
}
const setPhase = (phase: (typeof s.events.$inferInsert)['phase']) =>
  db.update(s.events).set({ phase }).where(eq(s.events.id, eventId));
const xp = async (pid: string) =>
  (await db.select().from(s.xpLedger).where(eq(s.xpLedger.participantId, pid))).reduce(
    (a, r) => a + r.amount,
    0,
  );

describe('Guess Your Secret Santa (FR-025..027)', () => {
  beforeEach(() => setup());

  it('guesses are editable until reveal and only against active participants but self', async () => {
    const guesser = ids[1]!; // Anna
    const state = await guessState(db, guesser, NOW);
    expect(state.suspects.map((x) => x.displayName)).toEqual([
      'Bruno',
      'Carla',
      'Dario',
      'Elena',
      'Fabio',
      'Marco',
      'Zoe',
    ]);
    expect(state.gifts.find((g) => g.giftId === giftIds[1])!.state).toBe('own');
    expect(
      await code(
        setGuess(db, { participantId: guesser, giftId: giftIds[1]!, suspectId: ids[0]!, now: NOW }),
      ),
    ).toBe('own_gift');
    expect(
      await code(
        setGuess(db, { participantId: guesser, giftId: giftIds[0]!, suspectId: guesser, now: NOW }),
      ),
    ).toBe('invalid_suspect');
    await setGuess(db, {
      participantId: guesser,
      giftId: giftIds[0]!,
      suspectId: ids[2]!,
      now: NOW,
    });
    await setGuess(db, {
      participantId: guesser,
      giftId: giftIds[0]!,
      suspectId: ids[3]!,
      now: at(5),
    });
    const mine = await guessState(db, guesser, NOW);
    expect(mine.gifts.find((g) => g.giftId === giftIds[0])!.myGuess).toBe(ids[3]);
    expect(await db.select().from(s.santaGuesses)).toHaveLength(1);
    // somebody else sees none of it
    const other = await guessState(db, ids[4]!, NOW);
    expect(other.gifts.every((g) => g.myGuess === null && g.result === null)).toBe(true);
    await revealGift(db, { eventId, giftId: giftIds[0]!, actor: 'owner', now: at(10) });
    expect(
      await code(
        setGuess(db, {
          participantId: guesser,
          giftId: giftIds[0]!,
          suspectId: ids[2]!,
          now: at(11),
        }),
      ),
    ).toBe('guess_closed');
  });

  it('feature flag and phase gate the screen', async () => {
    await db.update(s.events).set({ phase: 'registration' }).where(eq(s.events.id, eventId));
    expect(
      await code(
        setGuess(db, { participantId: ids[1]!, giftId: giftIds[0]!, suspectId: ids[2]!, now: NOW }),
      ),
    ).toBe('guess_closed');
    await setup(8, { guessSanta: false, missions: false });
    expect((await guessState(db, ids[1]!, NOW)).enabled).toBe(false);
    expect(
      await code(
        setGuess(db, { participantId: ids[1]!, giftId: giftIds[0]!, suspectId: ids[2]!, now: NOW }),
      ),
    ).toBe('feature_disabled');
  });

  it('reveal settles results with a playful payload; XP once, non-qualifying; wrong guess costs nothing', async () => {
    const [anna, marco] = [ids[1]!, ids[2]!];
    await setGuess(db, { participantId: anna, giftId: giftIds[0]!, suspectId: ids[0]!, now: NOW }); // right (Zoe)
    await setGuess(db, { participantId: marco, giftId: giftIds[0]!, suspectId: ids[3]!, now: NOW }); // wrong
    expect((await guessState(db, anna, NOW)).gifts[0]!.result).toBeNull(); // nothing before the reveal
    await revealGift(db, { eventId, giftId: giftIds[0]!, actor: 'owner', now: at(1) });
    const settled = await settleGuesses(db, eventId, at(2));
    expect(settled.map((x) => [x.guesserId, x.correct, x.xp])).toEqual(
      expect.arrayContaining([
        [anna, true, 20],
        [marco, false, 0],
      ]),
    );
    expect(await settleGuesses(db, eventId, at(3))).toEqual([]); // idempotent
    expect((await guessState(db, anna, at(3))).gifts[0]!.result).toEqual({
      outcome: 'correct',
      cue: 'confetti',
      xp: 20,
    });
    expect((await guessState(db, marco, at(3))).gifts[0]!.result).toEqual({
      outcome: 'incorrect',
      cue: 'wink',
      xp: 0,
    });
    expect(await xp(anna)).toBe(20);
    expect(await xp(marco)).toBe(0);
    const ledger = await db.select().from(s.xpLedger).where(eq(s.xpLedger.participantId, anna));
    expect(ledger.every((r) => !r.qualifying)).toBe(true);
  });

  it('Santa Detective / Invisible Santa go through canPublish (>=5 guessers, top-N, no totals)', async () => {
    // guessers 1..4 only -> floor not met
    for (const [i, g] of ids.slice(1, 5).entries())
      await setGuess(db, {
        participantId: g,
        giftId: giftIds[0]!,
        suspectId: i === 0 ? ids[0]! : ids[7]!,
        now: NOW,
      });
    await setPhase('reveal');
    await revealAllGifts(db, { eventId, actor: 'owner', now: at(1) });
    const low = await presentSpotlight(db, {
      eventId,
      kind: 'santa_detective',
      actor: 'owner',
      now: at(2),
    });
    expect(low).toMatchObject({
      published: false,
      reason: 'insufficient_voters',
      announcements: [],
    });
    expect(await spotlightView(db, eventId)).toMatchObject({
      message: 'christmas_magic',
      entries: [],
    });

    // 7 guessers, spread of correct counts
    await setup();
    const gifts = giftIds;
    const guess = (g: number, gift: number, suspect: number) =>
      setGuess(db, {
        participantId: ids[g]!,
        giftId: gifts[gift]!,
        suspectId: ids[suspect]!,
        now: NOW,
      });
    // gift 0 (Zoe), 1 (Anna), 2 (Marco)
    await guess(3, 0, 0);
    await guess(3, 1, 1);
    await guess(3, 2, 2); // Bruno 3 correct
    await guess(4, 0, 0);
    await guess(4, 1, 1); // Carla 2
    await guess(5, 0, 0); // Dario 1
    await guess(6, 0, 7); // Elena 0 (wrong)
    await guess(7, 3, 6); // Fabio guessed on Bruno's gift -> wrong
    await guess(0, 2, 7); // Zoe wrong on Marco's gift... counts a guesser
    await setPhase('reveal');
    await revealAllGifts(db, { eventId, actor: 'owner', now: at(1) });
    const res = await presentSpotlight(db, {
      eventId,
      kind: 'santa_detective',
      actor: 'owner',
      now: at(2),
    });
    expect(res).toMatchObject({ published: true, reason: null });
    const v = (await spotlightView(db, eventId))!;
    expect(v.kind).toBe('santa_detective');
    // 3 eligible guessers -> hiddenMin keeps two of them hidden: only the winner is shown\n    expect(v.entries.map((e) => [e.person.displayName, e.rank])).toEqual([['Bruno', 1]]);
    expect(JSON.stringify(v.entries)).not.toMatch(/score|total|correct/);
    expect(res.announcements).toEqual([
      { scope: 'pub', participantId: ids[3]!, key: 'santa_detective' },
    ]);
    const ach = await db
      .select()
      .from(s.participantAchievements)
      .where(eq(s.participantAchievements.key, 'santa_detective'));
    expect(ach.map((a) => a.participantId)).toEqual([ids[3]!]);
    // repeating the presentation is idempotent (achievement once)
    expect(
      (await presentSpotlight(db, { eventId, kind: 'santa_detective', actor: 'owner', now: at(3) }))
        .announcements,
    ).toEqual([]);
    // invisible santa: gifts 3 (Bruno, only wrong guesses by Fabio) and 4 none... Elena/Fabio fooled
    const inv = await presentSpotlight(db, {
      eventId,
      kind: 'invisible_santa',
      actor: 'owner',
      now: at(4),
    });
    expect(inv.published).toBe(false); // only one eligible entry: hiddenMin keeps the tail hidden
  });
});

describe('Giver clues (FR-025)', () => {
  beforeEach(() => setup());

  it('anonymous clues: keyword filter, 3 per gift, moderated queue never names the author', async () => {
    const giver = ids[2]!; // Marco
    expect(
      await code(submitClue(db, { participantId: giver, text: 'it is me, Marco', now: NOW })),
    ).toBe('clue_not_allowed');
    expect(await code(submitClue(db, { participantId: giver, text: 'you idiot', now: NOW }))).toBe(
      'clue_not_allowed',
    );
    const c1 = await submitClue(db, {
      participantId: giver,
      text: 'Loves hiking in the mountains',
      now: NOW,
    });
    await submitClue(db, { participantId: giver, text: 'Always brings snacks', now: NOW });
    await submitClue(db, { participantId: giver, text: 'Plays the guitar', now: NOW });
    expect(
      await code(submitClue(db, { participantId: giver, text: 'A fourth clue here', now: NOW })),
    ).toBe('clue_limit');
    expect((await ownClues(db, giver)).map((c) => c.status)).toEqual([
      'pending',
      'pending',
      'pending',
    ]);
    expect(await ownClues(db, ids[3]!)).toEqual([]);

    const queue = await clueQueue(db, eventId);
    expect(queue).toHaveLength(3);
    expect(Object.keys(queue[0]!).sort()).toEqual(['alias', 'clueId', 'giftId', 'status', 'text']);
    expect(JSON.stringify(queue)).not.toContain(giver);

    // pending clues are invisible to guessers until approved
    expect((await guessState(db, ids[4]!, NOW)).gifts[2]!.clues).toEqual([]);
    const ok = await decideClue(db, {
      eventId,
      clueId: c1.clueId,
      action: 'approve',
      actor: 'owner',
      now: NOW,
    });
    expect(ok).toMatchObject({ status: 'approved', alias: 'Gift 3' });
    expect(
      await code(
        decideClue(db, { eventId, clueId: c1.clueId, action: 'reject', actor: 'owner', now: NOW }),
      ),
    ).toBe('clue_not_pending');
    expect((await guessState(db, ids[4]!, NOW)).gifts[2]!.clues.map((c) => c.text)).toEqual([
      'Loves hiking in the mountains',
    ]);
    // rejected clues free a slot
    const rej = (await clueQueue(db, eventId)).find((c) => c.status === 'pending')!;
    await decideClue(db, {
      eventId,
      clueId: rej.clueId,
      action: 'reject',
      actor: 'owner',
      now: NOW,
    });
    await submitClue(db, { participantId: giver, text: 'A replacement clue', now: NOW });
    // audit holds no clue text / author
    const audit = await db.select().from(s.auditLog);
    expect(JSON.stringify(audit)).not.toContain('hiking');
  });
});

describe('Secret missions (FR-028..030)', () => {
  beforeEach(() => setup());

  it('random assignment is private, idempotent and respects opt-out', async () => {
    await setMissionOptOut(db, { participantId: ids[7]!, optOut: true });
    const r = await assignMissions(db, { eventId, actor: 'owner', now: NOW });
    expect(r).toEqual({ assigned: 7, participants: 7 });
    expect(await assignMissions(db, { eventId, actor: 'owner', now: NOW })).toEqual({
      assigned: 0,
      participants: 0,
    });
    expect((await myMissions(db, ids[7]!)).missions).toEqual([]);
    const mine = await myMissions(db, ids[0]!);
    expect(mine.missions).toHaveLength(1);
    expect(mine.missions[0]).toMatchObject({ status: 'assigned', completed: false, swapsLeft: 1 });
    // organizer sees counts only, no mission texts of unsubmitted assignments
    const org = await organizerMissions(db, eventId);
    expect(org.counts).toEqual({ assigned: 7, submitted: 0, verified: 0 });
    expect(org.pending).toEqual([]);
    // audit has counts only
    expect(JSON.stringify(await db.select().from(s.auditLog))).not.toMatch(/missionKey|compliment/);
  });

  it('opting out cancels unsubmitted missions; opting in tops up again', async () => {
    await assignMissions(db, { eventId, actor: 'owner', now: NOW });
    await setMissionOptOut(db, { participantId: ids[0]!, optOut: true });
    expect((await myMissions(db, ids[0]!)).missions).toEqual([]);
    await setMissionOptOut(db, { participantId: ids[0]!, optOut: false });
    expect((await assignMissions(db, { eventId, actor: 'owner', now: NOW })).assigned).toBe(1);
  });

  it('honor completion: XP once (non-qualifying), generic announcement only', async () => {
    await assignMissions(db, { eventId, actor: 'owner', now: NOW });
    const a = (await myMissions(db, ids[0]!)).missions[0]!;
    const r = await submitMission(db, {
      participantId: ids[0]!,
      assignmentId: a.assignmentId,
      note: 'done',
      now: NOW,
    });
    expect(r).toMatchObject({ status: 'verified', completed: true, xpAwarded: true });
    expect(
      await code(
        submitMission(db, { participantId: ids[0]!, assignmentId: a.assignmentId, now: NOW }),
      ),
    ).toBe('mission_not_pending');
    expect(
      await code(
        submitMission(db, { participantId: ids[1]!, assignmentId: a.assignmentId, now: NOW }),
      ),
    ).toBe('not_found');
    expect(await xp(ids[0]!)).toBe(30);
    expect(
      (await db.select().from(s.xpLedger).where(eq(s.xpLedger.participantId, ids[0]!)))[0]!
        .qualifying,
    ).toBe(false);
    const jobs = await db
      .select()
      .from(s.scheduledJobs)
      .where(eq(s.scheduledJobs.kind, MISSION_ANNOUNCE_JOB));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toEqual({});
    const delay = jobs[0]!.runAt.getTime() - NOW.getTime();
    expect(delay).toBeGreaterThanOrEqual(10_000);
    expect(delay).toBeLessThan(40_000);
    expect(await claimMissionAnnouncements(db, eventId, at(60))).toBe(1);
    expect(await claimMissionAnnouncements(db, eventId, at(61))).toBe(0);
  });

  it('organizer verification: submit -> verify / reject / reassign; swap is limited', async () => {
    const [ev] = await db.select().from(s.events).where(eq(s.events.id, eventId));
    await db
      .update(s.events)
      .set({
        settings: {
          ...ev!.settings,
          phase2: { ...ev!.settings.phase2, missionVerification: 'organizer' },
        },
      })
      .where(eq(s.events.id, eventId));
    await assignMissions(db, { eventId, actor: 'owner', now: NOW });
    const [m0, m1, m2] = await Promise.all(
      [0, 1, 2].map(async (i) => (await myMissions(db, ids[i]!)).missions[0]!),
    );
    const sub = await submitMission(db, {
      participantId: ids[0]!,
      assignmentId: m0!.assignmentId,
      note: 'told a joke',
      now: NOW,
    });
    expect(sub).toMatchObject({ status: 'submitted', completed: false, xpAwarded: false });
    await submitMission(db, { participantId: ids[1]!, assignmentId: m1!.assignmentId, now: NOW });
    await submitMission(db, { participantId: ids[2]!, assignmentId: m2!.assignmentId, now: NOW });
    const org = await organizerMissions(db, eventId);
    expect(org.pending).toHaveLength(3);
    expect(org.pending.find((p) => p.assignmentId === m0!.assignmentId)).toMatchObject({
      displayName: 'Zoe',
      note: 'told a joke',
    });
    expect(await xp(ids[0]!)).toBe(0);
    expect(
      await decideMission(db, {
        eventId,
        assignmentId: m0!.assignmentId,
        action: 'verify',
        actor: 'owner',
        now: NOW,
      }),
    ).toMatchObject({ status: 'verified' });
    expect(await xp(ids[0]!)).toBe(30);
    expect(
      await decideMission(db, {
        eventId,
        assignmentId: m1!.assignmentId,
        action: 'reject',
        actor: 'owner',
        now: NOW,
      }),
    ).toMatchObject({ status: 'rejected' });
    expect(
      await decideMission(db, {
        eventId,
        assignmentId: m2!.assignmentId,
        action: 'reassign',
        actor: 'owner',
        now: NOW,
      }),
    ).toMatchObject({ status: 'cancelled' });
    const after = (await myMissions(db, ids[2]!)).missions;
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ status: 'assigned' });
    expect(after[0]!.assignmentId).not.toBe(m2!.assignmentId);
    expect(
      await code(
        decideMission(db, {
          eventId,
          assignmentId: m0!.assignmentId,
          action: 'verify',
          actor: 'owner',
          now: NOW,
        }),
      ),
    ).toBe('mission_not_pending');
    // participant swap: once
    const swapped = await swapMission(db, {
      participantId: ids[3]!,
      assignmentId: (await myMissions(db, ids[3]!)).missions[0]!.assignmentId,
    });
    expect(swapped.swapsLeft).toBe(0);
    expect(
      await code(swapMission(db, { participantId: ids[3]!, assignmentId: swapped.assignmentId })),
    ).toBe('swap_unavailable');
  });

  it('Mission Master is published only with >=5 completers, via canPublish', async () => {
    await assignMissions(db, { eventId, actor: 'owner', perParticipant: 3, now: NOW });
    const complete = async (i: number, n: number) => {
      const ms = (await myMissions(db, ids[i]!)).missions.slice(0, n);
      for (const m of ms)
        await submitMission(db, { participantId: ids[i]!, assignmentId: m.assignmentId, now: NOW });
    };
    for (const [i, n] of [
      [0, 3],
      [1, 2],
      [2, 1],
      [3, 1],
    ] as const)
      await complete(i, n);
    const [ev] = await db.select().from(s.events).where(eq(s.events.id, eventId));
    expect(await missionMasterResult(db, ev!)).toMatchObject({
      ok: false,
      reason: 'insufficient_voters',
    });
    await complete(4, 1);
    await complete(5, 1);
    const ok = await missionMasterResult(db, ev!);
    expect(ok.ok && ok.entries.map((e) => [e.entryId, e.rank])).toEqual([
      [ids[0], 1],
      [ids[1], 2],
    ]);
    const shown = await presentSpotlight(db, {
      eventId,
      kind: 'mission_master',
      actor: 'owner',
      now: NOW,
    });
    expect(shown).toMatchObject({ published: true });
    expect(await spotlightView(db, eventId)).toMatchObject({ kind: 'mission_master' });
  });
});

describe('Mini-games (FR-031/032)', () => {
  beforeEach(() => setup());
  const A = (sec: number) => at(sec);

  async function runTrivia(players: number, correctFirst = true) {
    const { gameId } = await createGame(db, {
      eventId,
      actor: 'owner',
      kind: 'trivia',
      now: A(0),
      config: { rounds: 2, introSeconds: 3, roundSeconds: 10, revealSeconds: 2 },
    });
    await gameAction(db, { eventId, gameId, action: 'start', actor: 'owner', now: A(0) });
    const [g0] = await db.select().from(s.miniGames).where(eq(s.miniGames.id, gameId));
    expect(g0!.status).toBe('intro');
    const version = g0!.stepVersion;
    const stepTo = async (sec: number) => {
      const [g] = await db.select().from(s.miniGames).where(eq(s.miniGames.id, gameId));
      const r = await advanceGameAuto(db, { gameId, version: g!.stepVersion, now: A(sec) });
      return r;
    };
    expect((await advanceGameAuto(db, { gameId, version: version + 5, now: A(100) })).moved).toBe(
      false,
    ); // stale
    expect((await advanceGameAuto(db, { gameId, version, now: A(1) })).moved).toBe(false); // early
    expect((await stepTo(3)).moved).toBe(true); // intro -> round 0 opens at t=3
    for (let round = 0; round < 2; round++) {
      const open = 3 + round * 12;
      const spec = (
        await db
          .select()
          .from(s.gameRounds)
          .where(and(eq(s.gameRounds.gameId, gameId), eq(s.gameRounds.idx, round)))
      )[0]!.spec as { correctIds: string[]; options: Array<{ id: string }> };
      for (const [i, pid] of ids.slice(0, players).entries()) {
        const right = correctFirst ? i < players - 2 : false;
        const answerId = right
          ? spec.correctIds[0]!
          : spec.options.find((o) => !spec.correctIds.includes(o.id))!.id;
        await submitAnswer(db, { participantId: pid, answerId, now: A(open + 1 + i * 0.5) });
      }
      expect((await stepTo(open + 10)).moved).toBe(true); // round closes
      expect((await stepTo(open + 12)).moved).toBe(true); // reveal ends: next round or results
    }
    return gameId;
  }

  it('games run only in the games phase; one game on screen at a time', async () => {
    await setPhase('voting');
    expect(await code(createGame(db, { eventId, actor: 'owner', kind: 'trivia', now: A(0) }))).toBe(
      'not_in_games_phase',
    );
    await setPhase('games');
    const a = await createGame(db, { eventId, actor: 'owner', kind: 'trivia', now: A(0) });
    const b = await createGame(db, { eventId, actor: 'owner', kind: 'speed', now: A(0) });
    await gameAction(db, { eventId, gameId: a.gameId, action: 'start', actor: 'owner', now: A(0) });
    expect(
      await code(
        gameAction(db, { eventId, gameId: b.gameId, action: 'start', actor: 'owner', now: A(1) }),
      ),
    ).toBe('game_active');
    await gameAction(db, {
      eventId,
      gameId: a.gameId,
      action: 'cancel',
      actor: 'owner',
      now: A(2),
    });
    expect(await gameView(db, eventId, A(2))).toBeNull();
    await gameAction(db, { eventId, gameId: b.gameId, action: 'start', actor: 'owner', now: A(3) });
  });

  it('trivia: durable timers drive intro -> rounds -> results; canPublish winners, XP and badges', async () => {
    const gameId = await runTrivia(8);
    const v = (await gameView(db, eventId, A(40)))!;
    expect(v.status).toBe('results');
    // 8 players, top-3 via canPublish: a rank-1 tie of 6 would be shown whole only if hiddenMin holds
    expect(v.results).toBeTruthy();
    expect(JSON.stringify(v.results)).not.toMatch(/score|points|total/i);
    const [row] = await db.select().from(s.miniGames).where(eq(s.miniGames.id, gameId));
    expect(row!.status).toBe('results');
    // everyone who played got participation XP + Game Night, once
    for (const pid of ids) {
      expect(
        (
          await db
            .select()
            .from(s.xpLedger)
            .where(
              and(
                eq(s.xpLedger.participantId, pid),
                eq(s.xpLedger.rewardKey, `game:${gameId}:play`),
              ),
            )
        ).length,
      ).toBe(1);
    }
    const night = await db
      .select()
      .from(s.participantAchievements)
      .where(eq(s.participantAchievements.key, 'game_night'));
    expect(night).toHaveLength(8);
    await gameAction(db, { eventId, gameId, action: 'finish', actor: 'owner', now: A(41) });
    expect(await gameView(db, eventId, A(42))).toBeNull();
  });

  it('floor: with fewer than 5 players the winners are the neutral fallback and no winner XP exists', async () => {
    const gameId = await runTrivia(4);
    const v = (await gameView(db, eventId, A(40)))!;
    expect(v.results).toEqual({ message: 'christmas_magic', entries: [] });
    expect(
      (
        await db
          .select()
          .from(s.xpLedger)
          .where(eq(s.xpLedger.rewardKey, `game:${gameId}:win`))
      ).length,
    ).toBe(0);
    expect(
      (
        await db
          .select()
          .from(s.participantAchievements)
          .where(eq(s.participantAchievements.key, 'game_champion'))
      ).length,
    ).toBe(0);
  });

  it('answers: one per round, never before/after the window, own feedback only, no negative outcome', async () => {
    const { gameId } = await createGame(db, {
      eventId,
      actor: 'owner',
      kind: 'trivia',
      now: A(0),
      config: { rounds: 1, roundSeconds: 10 },
    });
    expect(await code(submitAnswer(db, { participantId: ids[0]!, answerId: '0', now: A(1) }))).toBe(
      'game_not_active',
    );
    await gameAction(db, { eventId, gameId, action: 'start', actor: 'owner', now: A(0) });
    expect(await code(submitAnswer(db, { participantId: ids[0]!, answerId: '0', now: A(1) }))).toBe(
      'round_not_open',
    );
    await gameAction(db, { eventId, gameId, action: 'next', actor: 'owner', now: A(2) }); // round 0 open until t=12
    expect(
      await code(submitAnswer(db, { participantId: ids[0]!, answerId: 'zzz', now: A(3) })),
    ).toBe('invalid_answer');
    await submitAnswer(db, { participantId: ids[0]!, answerId: '0', now: A(3) });
    expect(await code(submitAnswer(db, { participantId: ids[0]!, answerId: '1', now: A(4) }))).toBe(
      'already_submitted',
    );
    expect(
      await code(submitAnswer(db, { participantId: ids[1]!, answerId: '1', now: A(13) })),
    ).toBe('round_not_open');
    const live = (await gameView(db, eventId, A(5)))!;
    expect(live.round).toMatchObject({ submissionCount: 1, correctOptionIds: null }); // answer hidden while open
    expect((await myGameState(db, ids[0]!, A(5))).me).toMatchObject({
      submitted: true,
      answerId: '0',
    });
    expect((await myGameState(db, ids[1]!, A(5))).me).toMatchObject({
      submitted: false,
      answerId: null,
    });
    await gameAction(db, { eventId, gameId, action: 'next', actor: 'owner', now: A(6) });
    const closed = (await gameView(db, eventId, A(7)))!;
    expect(closed.round!.correctOptionIds).toHaveLength(1);
    const mine = (await myGameState(db, ids[0]!, A(7))).me!;
    expect(['correct', 'incorrect']).toContain(mine.lastRound!.outcome);
    expect(mine.lastRound!.cue).toMatch(/confetti|wink/);
    expect((await myGameState(db, ids[1]!, A(7))).me!.lastRound).toMatchObject({
      outcome: 'none',
      points: 0,
    });
  });

  it('speed: early taps are ignored, order after GO decides, GO time is hidden until it happens', async () => {
    const { gameId } = await createGame(db, {
      eventId,
      actor: 'owner',
      kind: 'speed',
      now: A(0),
      config: { rounds: 1, roundSeconds: 20 },
    });
    await gameAction(db, { eventId, gameId, action: 'start', actor: 'owner', now: A(0) });
    await gameAction(db, { eventId, gameId, action: 'next', actor: 'owner', now: A(0) });
    const [r] = await db.select().from(s.gameRounds).where(eq(s.gameRounds.gameId, gameId));
    const go = r!.opensAt!;
    expect(go.getTime()).toBeGreaterThan(A(0).getTime());
    expect((await gameView(db, eventId, A(0)))!.round!.opensAt).toBeNull();
    expect(
      await code(
        submitAnswer(db, {
          participantId: ids[0]!,
          answerId: 'tap',
          now: new Date(go.getTime() - 1),
        }),
      ),
    ).toBe('round_not_open');
    await submitAnswer(db, {
      participantId: ids[1]!,
      answerId: 'tap',
      now: new Date(go.getTime() + 300),
    });
    await submitAnswer(db, {
      participantId: ids[0]!,
      answerId: 'tap',
      now: new Date(go.getTime() + 100),
    });
    expect((await gameView(db, eventId, new Date(go.getTime() + 1)))!.round!.opensAt).toBe(
      go.toISOString(),
    );
    await gameAction(db, {
      eventId,
      gameId,
      action: 'next',
      actor: 'owner',
      now: new Date(go.getTime() + 1000),
    });
    const pts = await db.select().from(s.gameScores).where(eq(s.gameScores.gameId, gameId));
    expect(Object.fromEntries(pts.map((p) => [p.participantId, p.score]))).toEqual({
      [ids[0]!]: 100,
      [ids[1]!]: 90,
    });
  });

  it('guess the gift: hint round with gift-alias options; needs two opened gifts', async () => {
    const { gameId } = await createGame(db, {
      eventId,
      actor: 'owner',
      kind: 'guess_the_gift',
      now: A(0),
      config: { rounds: 2 },
    });
    await gameAction(db, { eventId, gameId, action: 'start', actor: 'owner', now: A(0) });
    await gameAction(db, { eventId, gameId, action: 'next', actor: 'owner', now: A(1) });
    const v = (await gameView(db, eventId, A(2)))!;
    expect(v.round!.options).toHaveLength(4);
    expect(v.round!.options[0]!.label['en']).toMatch(/^Gift \d$/);
    expect(v.round!.prompt['en']).toMatch(/hint/i);
    await db.delete(s.miniGames);
    await db.update(s.gifts).set({ hidden: true }).where(eq(s.gifts.id, giftIds[0]!));
    await db.update(s.gifts).set({ hidden: true }).where(eq(s.gifts.id, giftIds[1]!));
    for (const g of giftIds.slice(2, 7))
      await db.update(s.gifts).set({ hidden: true }).where(eq(s.gifts.id, g));
    expect(
      await code(createGame(db, { eventId, actor: 'owner', kind: 'guess_the_gift', now: A(0) })),
    ).toBe('not_enough_gifts');
  });

  it('bingo: generated cards, organizer-confirmed marks only, lines score extra, private card', async () => {
    const { gameId } = await createGame(db, {
      eventId,
      actor: 'owner',
      kind: 'bingo',
      now: A(0),
      config: { roundSeconds: 600 },
    });
    await gameAction(db, { eventId, gameId, action: 'start', actor: 'owner', now: A(0) });
    expect(
      await db.select().from(s.gameBingoCards).where(eq(s.gameBingoCards.gameId, gameId)),
    ).toHaveLength(8);
    await gameAction(db, { eventId, gameId, action: 'next', actor: 'owner', now: A(1) });
    const me = ids[0]!;
    expect(await code(markBingo(db, { participantId: me, cell: 12, now: A(2) }))).toBe(
      'invalid_answer',
    ); // free centre
    for (const cell of [10, 11, 13, 14])
      await markBingo(db, { participantId: me, cell, now: A(3) });
    await markBingo(db, { participantId: ids[1]!, cell: 0, now: A(3) });
    let card = (await myGameState(db, me, A(4))).me!.card!;
    expect(card.lines).toBe(0);
    expect(card.cells.filter((c) => c.mark === 'pending')).toHaveLength(4);
    const pending = await pendingBingoMarks(db, eventId, gameId);
    expect(pending).toHaveLength(5);
    expect(pending.find((m) => m.displayName === 'Zoe')!.label['en']).toBeTruthy();
    for (const m of pending.filter((x) => x.displayName === 'Zoe'))
      await decideBingoMark(db, {
        eventId,
        gameId,
        markId: m.markId,
        action: 'confirm',
        actor: 'owner',
        now: A(5),
      });
    const rej = pending.find((x) => x.displayName === 'Anna')!;
    await decideBingoMark(db, {
      eventId,
      gameId,
      markId: rej.markId,
      action: 'reject',
      actor: 'owner',
      now: A(5),
    });
    expect(await code(markBingo(db, { participantId: ids[1]!, cell: 0, now: A(6) }))).toBe(
      'invalid_answer',
    ); // stays rejected
    card = (await myGameState(db, me, A(6))).me!.card!;
    expect(card.lines).toBe(1);
    expect((await myGameState(db, ids[2]!, A(6))).me!.card!.lines).toBe(0); // own card only
    expect((await gameView(db, eventId, A(6)))!.round!.submissionCount).toBe(4);
    await gameAction(db, { eventId, gameId, action: 'show_results', actor: 'owner', now: A(7) });
    const scores = await db.select().from(s.gameScores).where(eq(s.gameScores.gameId, gameId));
    expect(scores.find((x) => x.participantId === me)!.score).toBe(4 * 10 + 50);
  });

  it('mystery santa predictions feed the guess board and score at the giver reveal', async () => {
    const { gameId } = await createGame(db, {
      eventId,
      actor: 'owner',
      kind: 'mystery_santa',
      now: A(0),
      config: { rounds: 1, roundSeconds: 30 },
    });
    await gameAction(db, { eventId, gameId, action: 'start', actor: 'owner', now: A(0) });
    await gameAction(db, { eventId, gameId, action: 'next', actor: 'owner', now: A(1) });
    const [r] = await db.select().from(s.gameRounds).where(eq(s.gameRounds.gameId, gameId));
    const target = (r!.spec as { giftId: string }).giftId;
    const v = (await gameView(db, eventId, A(2)))!;
    expect(v.round!.options).toHaveLength(8);
    expect(JSON.stringify(v)).not.toContain(target); // the gift id is not even in the payload
    expect(v.round!.correctOptionIds).toBeNull();
    const [gift] = await db.select().from(s.gifts).where(eq(s.gifts.id, target));
    const guesser = ids.find((i) => i !== gift!.giverId)!;
    const wrong = ids.find((i) => i !== gift!.giverId && i !== guesser)!;
    await submitAnswer(db, { participantId: guesser, answerId: gift!.giverId, now: A(3) }); // right
    expect(
      await code(submitAnswer(db, { participantId: gift!.giverId, answerId: wrong, now: A(3) })),
    ).toBe('own_gift');
    const g2 = await db.select().from(s.santaGuesses);
    expect(g2).toEqual([
      expect.objectContaining({
        source: 'prediction',
        guesserId: guesser,
        suspectId: gift!.giverId,
      }),
    ]);
    await gameAction(db, { eventId, gameId, action: 'show_results', actor: 'owner', now: A(4) });
    expect((await gameView(db, eventId, A(5)))!.results).toBeNull(); // deferred
    await revealGift(db, { eventId, giftId: target, actor: 'owner', now: A(6) });
    const settled = await settleGuesses(db, eventId, A(7));
    expect(settled).toEqual([
      expect.objectContaining({ guesserId: guesser, correct: true, xp: 20 }),
    ]);
  });
});

describe('Phase 2 personal data (delete-my-data / removal)', () => {
  beforeEach(() => setup());

  it('anonymising or removing a participant erases their guesses, clues, missions and game answers', async () => {
    const [a, b] = [ids[1]!, ids[2]!];
    for (const pid of [a, b]) {
      await setGuess(db, { participantId: pid, giftId: giftIds[0]!, suspectId: ids[4]!, now: NOW });
      await submitClue(db, { participantId: pid, text: 'Likes quiet evenings', now: NOW });
    }
    await assignMissions(db, { eventId, actor: 'owner', now: NOW });
    await setMissionOptOut(db, { participantId: a, optOut: true });
    const { gameId } = await createGame(db, {
      eventId,
      actor: 'owner',
      kind: 'trivia',
      now: NOW,
      config: { rounds: 1 },
    });
    await gameAction(db, { eventId, gameId, action: 'start', actor: 'owner', now: NOW });
    await gameAction(db, { eventId, gameId, action: 'next', actor: 'owner', now: at(1) });
    for (const pid of [a, b])
      await submitAnswer(db, { participantId: pid, answerId: '0', now: at(2) });

    await anonymizeParticipant(db, { participantId: a, now: at(3) });
    await removeParticipant(db, { eventId, actor: 'owner', participantId: b, now: at(3) });
    for (const table of [
      s.santaGuesses,
      s.santaClues,
      s.missionAssignments,
      s.gameSubmissions,
      s.gameScores,
    ] as const) {
      const rows = (await db.select().from(table)) as Array<Record<string, unknown>>;
      expect(rows.filter((r) => [a, b].some((id) => Object.values(r).includes(id)))).toEqual([]);
    }
    expect(await db.select().from(s.missionOptOuts)).toEqual([]);
    // the others keep theirs
    expect((await myMissions(db, ids[3]!)).missions).toHaveLength(1);
  });
});
