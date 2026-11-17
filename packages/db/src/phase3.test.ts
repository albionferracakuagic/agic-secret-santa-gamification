import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { FeaturesPatchSchema } from '@santa/contracts';
import { planPhase2Award, planAchievementAward } from '@santa/domain';
import { createTestDb, type TestDb } from './testing.js';
import {
  AUCTION_CLOSE_JOB,
  EventError,
  anonymizeParticipant,
  archiveView,
  auctionView,
  awardCustomAchievement,
  awardXp,
  closeDueAuction,
  coinBalance,
  confirmAccountLink,
  createCategory,
  createCustomAchievement,
  createEvent,
  createLinkToken,
  createPrize,
  customCategoryAchievements,
  deleteCategory,
  deleteCustomAchievement,
  dispatchOutbox,
  enqueueOutbox,
  finalizeEvent,
  grantCoins,
  hallOfFame,
  hashLinkToken,
  lifetimeProfile,
  myAuction,
  myCoins,
  organizerCategories,
  organizerCoins,
  organizerPrizes,
  placeBid,
  prizeAction,
  purgeExpiredArchives,
  unlockAchievement,
  updateFeatures,
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
const NAMES = ['Anna', 'Bruno', 'Carla', 'Dario', 'Elena', 'Fabio', 'Gina', 'Hugo'];

async function setup(
  features: Record<string, boolean> = { coins: true, auction: true, history: true },
  n = 8,
) {
  db = await createTestDb();
  await db.insert(s.user).values({ id: 'owner', name: 'O', email: 'o@example.test' });
  const e = await createEvent(db, {
    ownerId: 'owner',
    now: NOW,
    input: {
      name: 'Party',
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
          claimVerifiedAt: NOW,
        })),
      )
      .returning()
  ).map((p) => p.id);
}
const patch = (p: unknown, when = NOW) =>
  updateFeatures(db, { eventId, actor: 'owner', patch: FeaturesPatchSchema.parse(p), now: when });

describe('feature switches (organizer PATCH)', () => {
  beforeEach(() => setup({}));

  it('toggles are audited, floors cannot be reached, auction needs coins', async () => {
    expect(FeaturesPatchSchema.safeParse({ minVoters: 3 }).success).toBe(false);
    expect(FeaturesPatchSchema.safeParse({ showTotals: true }).success).toBe(false);
    expect(FeaturesPatchSchema.safeParse({}).success).toBe(false);
    expect(await code(patch({ auction: true }))).toBe('coins_disabled');
    const r = await patch({
      coins: true,
      auction: true,
      guessSanta: true,
      phase2: { missionVerification: 'organizer' },
    });
    expect(r.features).toMatchObject({
      coins: true,
      auction: true,
      guessSanta: true,
      missions: false,
      miniGames: true,
    });
    expect(r.phase2.missionVerification).toBe('organizer');
    // Phase 2 floors stay: detectiveMinGuessers is raise-only
    expect(FeaturesPatchSchema.safeParse({ phase2: { detectiveMinGuessers: 4 } }).success).toBe(
      false,
    );
    // and the merged settings are re-validated even if a patch skipped the schema
    expect(
      await code(
        updateFeatures(db, {
          eventId,
          actor: 'owner',
          patch: { phase2: { detectiveMinGuessers: 4 } },
          now: NOW,
        }),
      ),
    ).toBe('invalid_settings');
    expect((await patch({ phase2: { detectiveMinGuessers: 6 } })).phase2.detectiveMinGuessers).toBe(
      6,
    );
    const audit = await db
      .select()
      .from(s.auditLog)
      .where(eq(s.auditLog.action, 'features.update'));
    expect(audit.length).toBe(2); // rejected patches leave no trace of a change
    // the global privacy floors in settings are untouched
    const [ev] = await db.select().from(s.events).where(eq(s.events.id, eventId));
    expect(ev!.settings).toMatchObject({
      minVoters: 5,
      hiddenMin: 2,
      minTotalVotes: 5,
      showTotals: false,
    });
  });

  it('locked after completion; nothing new can be switched on during the awards', async () => {
    await db.update(s.events).set({ phase: 'awards' }).where(eq(s.events.id, eventId));
    expect(await code(patch({ coins: true }))).toBe('features_locked');
    expect((await patch({ history: true })).features.history).toBe(true);
    await db.update(s.events).set({ phase: 'completed' }).where(eq(s.events.id, eventId));
    expect(await code(patch({ history: false }))).toBe('features_locked');
  });
});

describe('Santa Coins (FR-033)', () => {
  beforeEach(() => setup());

  it('earns per rule from XP awards, idempotently, only while coins are on', async () => {
    const [a, b] = [ids[0]!, ids[1]!];
    const give = (
      pid: string,
      activity: 'game_play' | 'game_win' | 'mission_completed' | 'guess_correct',
      key: string,
    ) => awardXp(db, { eventId, participantId: pid, award: planPhase2Award(activity, 20, key) });
    await give(a, 'game_play', 'game:1:play');
    await give(a, 'game_play', 'game:1:play'); // replay
    await give(a, 'game_win', 'game:1:win');
    await give(a, 'mission_completed', 'mission:1');
    await give(a, 'guess_correct', 'guess:g1');
    await awardXp(db, {
      eventId,
      participantId: a,
      award: planAchievementAward('santa_detective', 50),
    });
    expect(await coinBalance(db, a)).toBe(2 + 10 + 10 + 5 + 10);
    expect(
      (await db.select().from(s.coinLedger).where(eq(s.coinLedger.participantId, a))).length,
    ).toBe(5);
    // participation XP (joined/voted) is not a coin source
    await awardXp(db, {
      eventId,
      participantId: b,
      award: { activity: 'joined', amount: 10, rewardKey: 'joined', qualifying: true },
    });
    expect(await coinBalance(db, b)).toBe(0);
    // organizer tunes / disables a rule
    await patch({ phase3: { coinRules: { game_play: 0, guess_correct: 7 } } });
    await give(b, 'game_play', 'game:2:play');
    await give(b, 'guess_correct', 'guess:g2');
    expect(await coinBalance(db, b)).toBe(7);
    // switching coins off stops earning
    await patch({ auction: false, coins: false });
    await give(b, 'game_win', 'game:3:win');
    expect(await coinBalance(db, b)).toBe(7);
  });

  it('organizer grants are idempotent per key, active participants only; balances are self-only', async () => {
    const r = await grantCoins(db, {
      eventId,
      actor: 'owner',
      key: 'trivia-bonus',
      amount: 25,
      now: NOW,
    });
    expect(r.granted).toBe(8);
    expect(
      (await grantCoins(db, { eventId, actor: 'owner', key: 'trivia-bonus', amount: 25, now: NOW }))
        .granted,
    ).toBe(0);
    expect(
      (
        await grantCoins(db, {
          eventId,
          actor: 'owner',
          key: 'extra',
          amount: 5,
          participantIds: [ids[0]!, ids[1]!],
          now: NOW,
        })
      ).granted,
    ).toBe(2);
    const mine = await myCoins(db, ids[0]!);
    expect(mine).toMatchObject({ enabled: true, balance: 30, held: 0 });
    expect(mine.entries.map((x) => x.reason)).toEqual(['organizer_grant', 'organizer_grant']);
    expect(await myCoins(db, ids[2]!)).toMatchObject({ balance: 25 });
    // the organizer view carries rules and one aggregate, never a balance
    const org = await organizerCoins(db, eventId);
    expect(org).toEqual({ enabled: true, rules: expect.any(Object), issued: 8 * 25 + 10 });
    expect(Object.keys(org).sort()).toEqual(['enabled', 'issued', 'rules']);
    await patch({ auction: false, coins: false });
    expect(
      await code(grantCoins(db, { eventId, actor: 'owner', key: 'late', amount: 1, now: NOW })),
    ).toBe('coins_disabled');
  });

  it('no ledger reason or API name allows buying, transferring or converting coins', async () => {
    const { COIN_REASONS } = await import('@santa/contracts');
    for (const r of COIN_REASONS)
      expect(r).not.toMatch(/purchase|buy|transfer|convert|cash|payment/);
  });
});

describe('Mystery reward auction (FR-034)', () => {
  beforeEach(async () => {
    await setup();
    await grantCoins(db, { eventId, actor: 'owner', key: 'seed', amount: 100, now: NOW });
  });
  const prize = async () =>
    (
      await createPrize(db, {
        eventId,
        actor: 'owner',
        title: { en: 'Mystery Box 1', it: 'Scatola 1' },
        reveal: { en: 'A cozy scarf', it: 'Una sciarpa' },
        minBid: 10,
        now: NOW,
      })
    ).id;
  const open = async (id: string, seconds = 60) =>
    prizeAction(db, {
      eventId,
      prizeId: id,
      action: 'open',
      durationSeconds: seconds,
      actor: 'owner',
      now: NOW,
    });

  it('bids hold coins, outbid leaders are refunded, nobody else is exposed', async () => {
    const id = await prize();
    expect(await code(placeBid(db, { participantId: ids[0]!, amount: 10, now: at(1) }))).toBe(
      'no_prize_on_stage',
    );
    await open(id);
    expect(await code(placeBid(db, { participantId: ids[0]!, amount: 9, now: at(1) }))).toBe(
      'bid_too_low',
    );
    expect(await code(placeBid(db, { participantId: ids[0]!, amount: 500, now: at(1) }))).toBe(
      'insufficient_coins',
    );
    await placeBid(db, { participantId: ids[0]!, amount: 10, now: at(2) });
    expect(await code(placeBid(db, { participantId: ids[0]!, amount: 20, now: at(3) }))).toBe(
      'already_leading',
    );
    expect(await code(placeBid(db, { participantId: ids[1]!, amount: 10, now: at(3) }))).toBe(
      'bid_too_low',
    ); // must beat 10 by the increment
    await placeBid(db, { participantId: ids[1]!, amount: 15, now: at(4) });
    expect(await coinBalance(db, ids[0]!)).toBe(100); // refunded
    expect(await coinBalance(db, ids[1]!)).toBe(85);
    expect((await myCoins(db, ids[1]!)).held).toBe(15);
    expect(await myAuction(db, ids[1]!)).toMatchObject({ you: { leading: true, myBid: 15 } });
    expect(await myAuction(db, ids[0]!)).toMatchObject({ you: { leading: false, myBid: 10 } });
    expect(await myAuction(db, ids[5]!)).toMatchObject({ you: { leading: false, myBid: null } });
    const pub = (await auctionView(db, eventId))!;
    expect(pub).toMatchObject({
      status: 'open',
      currentBid: 15,
      minNextBid: 16,
      winner: null,
      reveal: null,
    });
    // public view: price only; no bidder id, no bid count, no history, no mystery content
    expect(JSON.stringify(pub)).not.toContain(ids[1]!);
    expect(Object.keys(pub).sort()).toEqual([
      'currentBid',
      'endsAt',
      'minNextBid',
      'prizeId',
      'reveal',
      'status',
      'title',
      'winner',
    ]);
    expect(
      await code(
        prizeAction(db, {
          eventId,
          prizeId: await prize(),
          action: 'open',
          actor: 'owner',
          now: at(5),
        }),
      ),
    ).toBe('stage_busy');
  });

  it('anti-snipe extends the deadline through a durable job and stale timers are no-ops', async () => {
    const id = await prize();
    await open(id, 60); // ends at +60
    await placeBid(db, { participantId: ids[0]!, amount: 10, now: at(30) }); // not in the closing window
    let jobs = await db
      .select()
      .from(s.scheduledJobs)
      .where(eq(s.scheduledJobs.kind, AUCTION_CLOSE_JOB));
    expect(jobs).toHaveLength(1);
    const sniped = await placeBid(db, { participantId: ids[1]!, amount: 11, now: at(50) }); // 10 s left <= 15 s window
    expect(sniped.extended).toBe(true);
    expect(sniped.endsAt.getTime()).toBe(at(75).getTime());
    jobs = await db
      .select()
      .from(s.scheduledJobs)
      .where(eq(s.scheduledJobs.kind, AUCTION_CLOSE_JOB));
    expect(jobs).toHaveLength(2);
    const [stale, fresh] = jobs
      .sort((a, b) => a.runAt.getTime() - b.runAt.getTime())
      .map((j) => (j.payload as { version: number }).version);
    expect(await closeDueAuction(db, { prizeId: id, version: stale!, now: at(61) })).toBeNull(); // old timer
    expect(await closeDueAuction(db, { prizeId: id, version: fresh!, now: at(70) })).toBeNull(); // early
    const closed = (await closeDueAuction(db, { prizeId: id, version: fresh!, now: at(76) }))!;
    expect(closed.winnerId).toBe(ids[1]);
    expect(await closeDueAuction(db, { prizeId: id, version: fresh!, now: at(77) })).toBeNull(); // replay
    expect(await code(placeBid(db, { participantId: ids[2]!, amount: 20, now: at(78) }))).toBe(
      'auction_closed',
    );
    // winner pays (hold stays), the others are whole
    expect(await coinBalance(db, ids[1]!)).toBe(100 - 11);
    expect(await coinBalance(db, ids[0]!)).toBe(100);
    const view = (await auctionView(db, eventId))!;
    expect(view).toMatchObject({ status: 'closed', currentBid: 11, reveal: null });
    expect(view.winner!.displayName).toBe('Bruno');
    // the mystery stays hidden until the reveal step
    expect(
      await code(
        prizeAction(db, { eventId, prizeId: id, action: 'close', actor: 'owner', now: at(80) }),
      ),
    ).toBe('invalid_prize_state');
    await prizeAction(db, { eventId, prizeId: id, action: 'reveal', actor: 'owner', now: at(81) });
    expect((await auctionView(db, eventId))!.reveal).toEqual({
      en: 'A cozy scarf',
      it: 'Una sciarpa',
    });
    await prizeAction(db, { eventId, prizeId: id, action: 'dismiss', actor: 'owner', now: at(82) });
    expect(await auctionView(db, eventId)).toBeNull();
  });

  it('extensions are bounded; cancelling or disabling the auction refunds the leader', async () => {
    await patch({ phase3: { auction: { maxExtensions: 1 } } });
    const id = await prize();
    await open(id, 20);
    expect((await placeBid(db, { participantId: ids[0]!, amount: 10, now: at(10) })).extended).toBe(
      true,
    ); // 10 s left <= 15 s
    expect((await placeBid(db, { participantId: ids[1]!, amount: 11, now: at(30) })).extended).toBe(
      false,
    ); // limit reached
    expect(await coinBalance(db, ids[1]!)).toBe(89);
    await patch({ auction: false });
    expect(await coinBalance(db, ids[1]!)).toBe(100);
    expect(await auctionView(db, eventId)).toBeNull();
    const [row] = await db.select().from(s.auctionPrizes).where(eq(s.auctionPrizes.id, id));
    expect(row).toMatchObject({ status: 'cancelled', onStage: false });
    expect(
      await code(
        createPrize(db, {
          eventId,
          actor: 'owner',
          title: { en: 'x' },
          reveal: { en: 'y' },
          minBid: 1,
          now: NOW,
        }),
      ),
    ).toBe('auction_disabled');
  });

  it('prizes: CRUD only while draft; organizer list shows the secret content, never bidders', async () => {
    const id = await prize();
    expect((await organizerPrizes(db, eventId)).prizes[0]).toMatchObject({
      status: 'draft',
      onStage: false,
      reveal: { en: 'A cozy scarf' },
    });
    await open(id);
    await placeBid(db, { participantId: ids[0]!, amount: 10, now: at(1) });
    const list = await organizerPrizes(db, eventId);
    expect(JSON.stringify(list)).not.toContain(ids[0]!);
    expect(list.prizes[0]).toMatchObject({ currentBid: 10, winner: null });
  });
});

/** A completed event with revealed awards, achievements, a finished game and secret data that must never leak. */
async function completedEvent(opts: { xpBoard?: boolean } = {}) {
  await setup({
    coins: true,
    auction: true,
    history: true,
    ...(opts.xpBoard ? { xpBoard: true } : {}),
  });
  const gifts = await db
    .insert(s.gifts)
    .values(
      ids.map((giverId, i) => ({
        eventId,
        giverId,
        aliasNo: i + 1,
        name: `Present ${i + 1}`,
        status: 'revealed' as const,
        giverRevealedAt: NOW,
        photoKey: `gifts/${eventId}/${i}.jpg`,
      })),
    )
    .returning();
  const cats = await db
    .select()
    .from(s.votingCategories)
    .where(eq(s.votingCategories.eventId, eventId));
  // secret voting data that must never reach the archive
  for (const [i, v] of ids.entries())
    await db
      .insert(s.votes)
      .values({ categoryId: cats[0]!.id, voterId: v, eventId, giftId: gifts[(i + 1) % 8]!.id });
  await db.insert(s.awards).values([
    {
      eventId,
      boardKey: 'best_overall',
      winners: [gifts[2]!.id],
      publishable: true,
      lockedAt: NOW,
      revealedAt: NOW,
    },
    {
      eventId,
      boardKey: 'funniest',
      winners: [gifts[3]!.id],
      publishable: true,
      lockedAt: NOW,
      revealedAt: NOW,
    },
    {
      eventId,
      boardKey: 'most_creative',
      winners: [gifts[4]!.id],
      publishable: true,
      lockedAt: NOW,
    }, // never revealed
    { eventId, boardKey: 'most_thoughtful', winners: [], publishable: false, lockedAt: NOW }, // unsafe category
  ]);
  await unlockAchievement(db, {
    eventId,
    participantId: ids[2]!,
    key: 'legendary_santa',
    source: 'ceremony',
    now: NOW,
  });
  await unlockAchievement(db, {
    eventId,
    participantId: ids[0]!,
    key: 'christmas_champion',
    source: 'ceremony',
    now: NOW,
  });
  await db.insert(s.miniGames).values({
    eventId,
    kind: 'trivia',
    status: 'finished',
    title: { en: 'Trivia' },
    config: {},
    results: {
      ok: true,
      entries: [{ entryId: ids[5]!, rank: 1, tied: false }],
      unresolvedTie: false,
    },
  });
  await db
    .update(s.events)
    .set({ phase: 'completed', completedAt: NOW, revealStartedAt: NOW })
    .where(eq(s.events.id, eventId));
  return { gifts };
}

describe('history archive (FR-042)', () => {
  it('keeps PUBLIC results only: revealed locked winners, achievements, game winners, champion', async () => {
    const { gifts } = await completedEvent();
    expect(await finalizeEvent(db, eventId, at(1))).toEqual({ archived: true });
    expect(await finalizeEvent(db, eventId, at(2))).toEqual({ archived: true }); // idempotent
    const { enabled, archive } = await archiveView(
      db,
      eventId,
      at(3),
      async (k) => `https://blob.test/${k}`,
    );
    expect(enabled).toBe(true);
    const a = archive!;
    expect(a).toMatchObject({ name: 'Party', year: 2026 });
    expect(a.participants).toHaveLength(8);
    expect(a.winners.map((w) => [w.boardKey, w.giver.displayName, w.grand]).sort()).toEqual([
      ['best_overall', 'Carla', true],
      ['funniest', 'Dario', false],
    ]);
    expect(a.winners[0]!.photoUrl).toMatch(/^https:\/\/blob\.test\/gifts\//);
    expect(a.achievements.map((x) => x.key).sort()).toEqual([
      'christmas_champion',
      'legendary_santa',
    ]);
    expect(a.champion!.displayName).toBe('Anna');
    expect(a.games[0]!.winners.entries[0]!.person.displayName).toBe('Fabio');
    // nothing secret: no votes, no ids of voters/ballots, no XP/coins/guesses/missions/bids, no unrevealed award
    const json = JSON.stringify(a);
    for (const banned of [
      'voterId',
      'categoryId',
      'votes',
      '"xp"',
      'coin',
      'guess',
      'mission',
      'bid',
      'score',
      'nominee',
      gifts[4]!.id,
    ])
      expect(json).not.toContain(banned);
    expect(
      a.winners.some((w) => w.boardKey === 'most_creative' || w.boardKey === 'most_thoughtful'),
    ).toBe(false);
    // snapshot stores ids + policy output only
    const [row] = await db.select().from(s.eventArchives);
    expect(JSON.stringify(row!.snapshot)).not.toMatch(/voter|ballot|xp_ledger/);
  });

  it('respects the feature switch, anonymisation and retention', async () => {
    await completedEvent();
    await finalizeEvent(db, eventId, at(1));
    await anonymizeParticipant(db, { participantId: ids[2]!, now: at(2) });
    const a = (await archiveView(db, eventId, at(3))).archive!;
    expect(a.participants).toHaveLength(7);
    expect(a.winners.map((w) => w.boardKey)).not.toContain('best_overall'); // the giver asked to be forgotten
    // retention: archiveDays after completion the snapshot is gone
    expect(await purgeExpiredArchives(db, at(86_400 * 700))).toBe(0);
    expect((await archiveView(db, eventId, at(86_400 * 731))).archive).toBeNull();
    expect(await purgeExpiredArchives(db, at(86_400 * 731))).toBe(1);
    // switch off -> nothing is archived
    await completedEvent();
    await db
      .update(s.events)
      .set({
        settings: {
          ...(await db.select().from(s.events))[0]!.settings,
          features: { ...(await db.select().from(s.events))[0]!.settings.features, history: false },
        },
      });
    expect(await finalizeEvent(db, eventId, at(1))).toEqual({ archived: false });
    expect(await archiveView(db, eventId, at(2))).toEqual({ enabled: false, archive: null });
    // an event that is not completed has no archive
    await db.update(s.events).set({ phase: 'awards', completedAt: null });
    expect(await finalizeEvent(db, eventId, at(3))).toEqual({ archived: false });
  });
});

describe('account link, lifetime titles, Hall of Fame, seasons (FR-043/044)', () => {
  const link = async (pid: string, email: string, token: string, when = at(1)) => {
    await createLinkToken(db, {
      participantId: pid,
      email,
      tokenHash: hashLinkToken(token),
      now: when,
    });
    return confirmAccountLink(db, { tokenHash: hashLinkToken(token), now: at(2) });
  };

  it('needs a verified claim; the token is single-use, expiring and generic on failure', async () => {
    await completedEvent();
    await db
      .update(s.participants)
      .set({ claimVerifiedAt: null })
      .where(eq(s.participants.id, ids[1]!));
    expect(
      await code(
        createLinkToken(db, {
          participantId: ids[1]!,
          email: 'b@example.test',
          tokenHash: 'h1',
          now: NOW,
        }),
      ),
    ).toBe('verification_required');
    await createLinkToken(db, {
      participantId: ids[0]!,
      email: 'Anna@Example.test',
      tokenHash: hashLinkToken('tok-a'),
      now: NOW,
    });
    expect(
      await code(confirmAccountLink(db, { tokenHash: hashLinkToken('nope'), now: at(1) })),
    ).toBe('invalid_link');
    expect(
      await code(confirmAccountLink(db, { tokenHash: hashLinkToken('tok-a'), now: at(31 * 60) })),
    ).toBe('invalid_link'); // expired
    await createLinkToken(db, {
      participantId: ids[0]!,
      email: 'anna@example.test',
      tokenHash: hashLinkToken('tok-b'),
      now: at(10),
    });
    const r = await confirmAccountLink(db, { tokenHash: hashLinkToken('tok-b'), now: at(11) });
    expect(
      await code(confirmAccountLink(db, { tokenHash: hashLinkToken('tok-b'), now: at(12) })),
    ).toBe('invalid_link'); // used
    const [u] = await db.select().from(s.user).where(eq(s.user.id, r.userId));
    expect(u).toMatchObject({ email: 'anna@example.test', emailVerified: true });
    expect(
      await code(
        createLinkToken(db, {
          participantId: ids[0]!,
          email: 'x@example.test',
          tokenHash: 'h2',
          now: at(20),
        }),
      ),
    ).toBe('already_linked');
  });

  it('lifetime profile: positive titles + participation year, synced at completion and at link time', async () => {
    await completedEvent();
    const r = await link(ids[0]!, 'anna@example.test', 'tok-1'); // event already completed -> synced immediately
    const p = (await lifetimeProfile(db, r.userId)).profile!;
    expect(p).toMatchObject({
      displayName: 'Anna',
      events: 1,
      participationYears: [2026],
      totalAchievements: 1,
    });
    expect(p.titles).toEqual([
      {
        key: 'christmas_champion',
        title: { en: 'Christmas Champion', it: 'Campione di Natale' },
        eventName: 'Party',
        year: 2026,
        trophy: true,
      },
    ]);
    expect(JSON.stringify(p)).not.toMatch(/xp|vote|score|rank|last/i);
    // the same address on another roster entry joins the same account
    const r2 = await link(ids[2]!, 'ANNA@example.test', 'tok-2');
    expect(r2.userId).toBe(r.userId);
    expect((await lifetimeProfile(db, r.userId)).profile!.totalAchievements).toBe(2);
    // delete-my-data removes what that event gave the account
    await anonymizeParticipant(db, { participantId: ids[2]!, now: at(5) });
    expect((await lifetimeProfile(db, r.userId)).profile!.titles.map((t) => t.key)).toEqual([
      'christmas_champion',
    ]);
    expect(await lifetimeProfile(db, 'nobody')).toEqual({ linked: false, profile: null });
  });

  it('Hall of Fame: positive accomplishments of past events; seasonal top-N needs >= 5 linked accounts', async () => {
    await completedEvent({ xpBoard: true });
    for (const [i, pid] of ids.slice(0, 6).entries()) {
      await link(pid, `p${i}@example.test`, `tok-${i}`);
      await db
        .insert(s.xpLedger)
        .values({
          eventId,
          participantId: pid,
          activity: 'voted',
          amount: 10 * (6 - i),
          rewardKey: 'voted',
          qualifying: true,
        });
    }
    await finalizeEvent(db, eventId, at(10));
    const hof = await hallOfFame(db, eventId, at(11));
    expect(hof.enabled).toBe(true);
    expect(hof.years).toHaveLength(1);
    const kinds = hof.years[0]!.events[0]!.champions.map((c) => [
      c.kind,
      c.person.displayName,
    ]).sort();
    expect(kinds).toEqual([
      ['category_winner', 'Dario'],
      ['christmas_champion', 'Anna'],
      ['grand_champion', 'Carla'],
    ]);
    // seasonal board: 6 accounts, topN 3, hiddenMin 2 -> top 3 only, no totals, no rank outside the top
    expect(hof.seasons).toHaveLength(1);
    expect(hof.seasons[0]!.board.entries.map((e) => [e.person.displayName, e.rank])).toEqual([
      ['Anna', 1],
      ['Bruno', 2],
      ['Carla', 3],
    ]);
    expect(JSON.stringify(hof)).not.toMatch(/"xp"|"score"|"total"/);
    // below the floor (4 accounts) the board is the neutral message
    await db.delete(s.seasonXp).where(and(eq(s.seasonXp.eventId, eventId), eq(s.seasonXp.xp, 10)));
    await db.delete(s.seasonXp).where(and(eq(s.seasonXp.eventId, eventId), eq(s.seasonXp.xp, 20)));
    expect((await hallOfFame(db, eventId, at(12))).seasons[0]!.board).toEqual({
      message: 'christmas_magic',
      entries: [],
    });
  });

  it('events that did not run the XP board feed no season; a history-off event has no Hall of Fame', async () => {
    await completedEvent();
    await link(ids[0]!, 'a@example.test', 'tok-x');
    await finalizeEvent(db, eventId, at(10));
    expect(await db.select().from(s.seasonXp)).toEqual([]);
    const [ev] = await db.select().from(s.events);
    await db
      .update(s.events)
      .set({
        settings: { ...ev!.settings, features: { ...ev!.settings.features, history: false } },
      });
    expect(await hallOfFame(db, eventId, at(11))).toEqual({
      enabled: false,
      years: [],
      seasons: [],
    });
  });
});

describe('custom categories and achievements (editor)', () => {
  beforeEach(() => setup({}));

  it('categories can be added/edited/removed only before voting; key space is separate', async () => {
    await db.update(s.events).set({ phase: 'gift_registration' }).where(eq(s.events.id, eventId));
    const c = await createCategory(db, {
      eventId,
      actor: 'owner',
      key: 'c_best_wrap',
      name: { en: 'Best Wrap', it: 'Miglior Incarto' },
      now: NOW,
    });
    expect(
      await code(
        createCategory(db, {
          eventId,
          actor: 'owner',
          key: 'c_best_wrap',
          name: { en: 'Dup' },
          now: NOW,
        }),
      ),
    ).toBe('duplicate_key');
    const list = await organizerCategories(db, eventId);
    expect(list.editable).toBe(true);
    expect(list.categories.find((x) => x.key === 'c_best_wrap')).toMatchObject({
      custom: true,
      enabled: true,
    });
    const grand = list.categories.find((x) => x.key === 'best_overall')!;
    const { updateCategory } = await import('./index.js');
    expect(
      await code(
        updateCategory(db, {
          eventId,
          categoryId: grand.categoryId,
          actor: 'owner',
          patch: { enabled: false },
          now: NOW,
        }),
      ),
    ).toBe('category_in_use');
    await updateCategory(db, {
      eventId,
      categoryId: c.id,
      actor: 'owner',
      patch: { enabled: false, sort: 99 },
      now: NOW,
    });
    const builtin = list.categories.find((x) => !x.custom)!;
    expect(
      await code(
        deleteCategory(db, { eventId, categoryId: builtin.categoryId, actor: 'owner', now: NOW }),
      ),
    ).toBe('category_in_use');
    await deleteCategory(db, { eventId, categoryId: c.id, actor: 'owner', now: NOW });
    await db.update(s.events).set({ phase: 'voting' }).where(eq(s.events.id, eventId));
    expect(
      await code(
        createCategory(db, {
          eventId,
          actor: 'owner',
          key: 'c_late',
          name: { en: 'Late' },
          now: NOW,
        }),
      ),
    ).toBe('categories_locked');
    expect((await organizerCategories(db, eventId)).editable).toBe(false);
  });

  it('custom achievements: category winner mapping feeds the ceremony; manual awards are positive and idempotent', async () => {
    await db.update(s.events).set({ phase: 'gift_registration' }).where(eq(s.events.id, eventId));
    await createCategory(db, {
      eventId,
      actor: 'owner',
      key: 'c_wrap',
      name: { en: 'Wrap' },
      now: NOW,
    });
    expect(
      await code(
        createCustomAchievement(db, {
          eventId,
          actor: 'owner',
          key: 'c_bad',
          name: { en: 'Bad' },
          description: { en: 'x' },
          categoryKey: 'best_overall',
          now: NOW,
        }),
      ),
    ).toBe('invalid_category');
    const wrap = await createCustomAchievement(db, {
      eventId,
      actor: 'owner',
      key: 'c_wrap_wizard',
      name: { en: 'Wrap Wizard' },
      description: { en: 'Best wrap' },
      categoryKey: 'c_wrap',
      now: NOW,
    });
    expect(
      await code(
        createCustomAchievement(db, {
          eventId,
          actor: 'owner',
          key: 'c_wrap_wizard',
          name: { en: 'Dup' },
          description: { en: 'x' },
          now: NOW,
        }),
      ),
    ).toBe('duplicate_key');
    const manual = await createCustomAchievement(db, {
      eventId,
      actor: 'owner',
      key: 'c_helper',
      name: { en: 'Super Helper' },
      description: { en: 'Always helping' },
      now: NOW,
    });
    expect(await customCategoryAchievements(db, eventId)).toEqual({ c_wrap: 'c_wrap_wizard' });
    const { buildCeremonyScript } = await import('@santa/domain');
    const script = buildCeremonyScript(
      [{ boardKey: 'c_wrap', publishable: true, hasNominees: false }],
      {
        grandBoard: 'best_overall',
        countdownSeconds: 3,
        includeSpirit: false,
        includeChampion: false,
        extraAchievements: await customCategoryAchievements(db, eventId),
      },
    );
    expect(script.find((x) => x.type === 'achievement')).toMatchObject({
      achievementKey: 'c_wrap_wizard',
    });
    // manual awards: only categoryless ones, only from the games phase, once
    expect(
      await code(
        awardCustomAchievement(db, {
          eventId,
          achievementId: manual.achievementId,
          participantIds: [ids[0]!],
          actor: 'owner',
          now: NOW,
        }),
      ),
    ).toBe('invalid_step');
    await db.update(s.events).set({ phase: 'games' }).where(eq(s.events.id, eventId));
    expect(
      await code(
        awardCustomAchievement(db, {
          eventId,
          achievementId: wrap.achievementId,
          participantIds: [ids[0]!],
          actor: 'owner',
          now: NOW,
        }),
      ),
    ).toBe('invalid_category');
    const r = await awardCustomAchievement(db, {
      eventId,
      achievementId: manual.achievementId,
      participantIds: [ids[0]!, ids[1]!, 'f0000000-0000-4000-8000-000000000000'],
      actor: 'owner',
      now: NOW,
    });
    expect(r.awarded).toBe(2);
    expect(r.announcements.every((a) => a.scope === 'pub' && a.key === 'c_helper')).toBe(true);
    expect(
      (
        await awardCustomAchievement(db, {
          eventId,
          achievementId: manual.achievementId,
          participantIds: [ids[0]!],
          actor: 'owner',
          now: NOW,
        })
      ).awarded,
    ).toBe(0);
    expect(
      await code(
        deleteCustomAchievement(db, {
          eventId,
          achievementId: manual.achievementId,
          actor: 'owner',
          now: NOW,
        }),
      ),
    ).toBe('category_in_use'); // earned titles stay
  });
});

describe('transactional outbox (scale-out prep)', () => {
  beforeEach(() => setup({}));

  it('a rolled-back change leaves no message; dispatch is ordered and failure-safe', async () => {
    await db
      .transaction(async (tx) => {
        await enqueueOutbox(tx, { eventId, topic: 't', payload: { n: 0 } });
        throw new Error('boom');
      })
      .catch(() => undefined);
    expect(await db.select().from(s.outboxEvents)).toEqual([]);
    for (const n of [1, 2, 3]) await enqueueOutbox(db, { eventId, topic: 't', payload: { n } });
    const got: number[] = [];
    let fail = true;
    const publish = async (m: { payload: unknown }) => {
      const n = (m.payload as { n: number }).n;
      if (n === 2 && fail) throw new Error('bus down');
      got.push(n);
    };
    expect(await dispatchOutbox(db, { limit: 10, now: NOW, publish })).toEqual({
      dispatched: 1,
      failed: 1,
    });
    expect(got).toEqual([1]); // 3 was NOT sent past the failed 2: order preserved
    fail = false;
    expect(await dispatchOutbox(db, { limit: 10, now: NOW, publish })).toEqual({
      dispatched: 2,
      failed: 0,
    });
    expect(got).toEqual([1, 2, 3]);
    expect(await dispatchOutbox(db, { limit: 10, now: NOW, publish })).toEqual({
      dispatched: 0,
      failed: 0,
    }); // nothing twice
    expect((await db.select().from(s.outboxEvents)).every((r) => r.dispatchedAt !== null)).toBe(
      true,
    );
  });
});
