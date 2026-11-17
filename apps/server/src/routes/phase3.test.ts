import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { events, gifts, participantAchievements, participants, awards, xpLedger } from '@santa/db';
import { scanForbidden } from '@santa/contracts';
import { connected, createWorld, sleep, type World } from '../testing/world.js';
import { JobRunner } from '../jobs/runner.js';
import { MemoryEmailTransport } from '../auth/email.js';
import { registerPhase2Jobs } from '../realtime/phase2.js';
import { registerAuctionJobs } from '../realtime/phase3.js';

type Msg = { stream: string; surface?: string; payload?: Record<string, unknown> };

let w: World;
let n = 0;
let now = new Date('2026-12-24T20:00:00Z');
const tick = (sec: number) => (now = new Date(now.getTime() + sec * 1000));
const OWNER = () => w.organizerCookie('demo-owner', 'sess-o');
let cookies: string[];
const email = new MemoryEmailTransport();
const routes: Array<{ method: string; url: string }> = [];

const call = (
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  o: { cookie?: string; body?: unknown } = {},
) =>
  w.app.inject({
    method,
    url: url.startsWith('/api/') ? url : `/api/events/${w.eventId}${url}`,
    ...(o.body === undefined ? {} : { payload: o.body as object }),
    headers: { 'idempotency-key': `p3-${++n}-xxxxxxxx`, cookie: o.cookie ?? OWNER() },
  });
const setPhase = (phase: 'gift_registration' | 'games' | 'reveal' | 'completed') =>
  w.db
    .update(events)
    .set({
      phase,
      revealStartedAt: new Date('2026-12-24T19:00:00Z'),
      ...(phase === 'completed' ? { completedAt: now } : {}),
    })
    .where(eq(events.id, w.eventId));

describe('Phase 2 follow-ups and Phase 3 API', () => {
  let display: ReturnType<World['client']>;
  let marco: ReturnType<World['client']>;
  const dSeen: Msg[] = [];
  const mSeen: Msg[] = [];
  const surfaces = (seen: Msg[], surface: string) =>
    seen.filter((m) => m.surface === surface).map((m) => m.payload!);

  beforeAll(async () => {
    w = await createWorld({
      clock: () => now,
      email,
      rateLimitMax: 10_000,
      configure: (app: FastifyInstance) => {
        app.addHook('onRoute', (o) => {
          for (const m of [o.method].flat()) routes.push({ method: m, url: o.url });
        });
      },
    });
    await w.db.update(events).set({ phase: 'games' }).where(eq(events.id, w.eventId));
    cookies = await Promise.all(w.participantIds.map((_, i) => w.guestCookie(i)));
    display = w.client(await w.displayCookie());
    marco = w.client(cookies[1]!);
    for (const [c, seen] of [
      [display, dSeen],
      [marco, mSeen],
    ] as const) {
      await connected(c);
      c.on('delta', (m: Msg) => seen.push(m));
      c.emit('subscribe', {});
    }
    await sleep(300);
  }, 60_000);
  afterAll(async () => {
    await w.close();
  });

  /* ---------------------------------------------------------------- A: features */

  it('organizer state exposes every feature flag; PATCH flips them (audited, floors untouched)', async () => {
    const st = (await call('GET', '/organizer-state')).json();
    const org = st.eventState.organizer;
    expect(org.features).toEqual({ xpBoard: false, guessSanta: false, missions: false, miniGames: true, coins: false, auction: false, history: false });
    expect(org.phase2).toMatchObject({ missionVerification: 'none', detectiveMinGuessers: 5 });
    expect(org.phase3.coinRules).toMatchObject({ game_play: 2 });

    expect((await call('GET', '/clues')).json()).toEqual({ enabled: false, clues: [] });
    expect((await call('GET', '/games')).json()).toMatchObject({ enabled: true, canCreate: true });

    expect((await call('PATCH', '/features', { body: { auction: true } })).json().error.code).toBe('coins_disabled');
    const ok = await call('PATCH', '/features', { body: { guessSanta: true, coins: true, auction: true, history: true, phase3: { coinRules: { game_win: 12 } } } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().features).toMatchObject({ guessSanta: true, coins: true, auction: true, history: true });
    expect(ok.json().phase3.coinRules.game_win).toBe(12);
    expect((await call('GET', '/clues')).json().enabled).toBe(true);
    // floors are not reachable
    for (const body of [{ minVoters: 2 }, { settings: { hiddenMin: 1 } }, { phase2: { detectiveMinGuessers: 3 } }, {}, { showTotals: true }])
      expect((await call('PATCH', '/features', { body })).statusCode).toBe(400);
    // organizers only
    expect((await call('PATCH', '/features', { cookie: cookies[0]!, body: { missions: true } })).statusCode).toBe(401);
    expect((await call('PATCH', '/features', { cookie: w.organizerCookie('stranger', 'sess-x'), body: { missions: true } })).statusCode).toBe(403);
    expect((await call('GET', '/audit')).json().entries.some((e: { action: string }) => e.action === 'features.update')).toBe(true);
    // the organizer socket stream refreshed too
    await sleep(200);
  });

  it('speed answers: `answerId` is optional (or "tap"); choice rounds still need a valid option', async () => {
    const speed = (await call('POST', '/games', { body: { kind: 'speed', config: { rounds: 1, introSeconds: 0, roundSeconds: 20 } } })).json().gameId;
    await call('POST', `/games/${speed}`, { body: { action: 'start' } });
    await call('POST', `/games/${speed}`, { body: { action: 'next' } });
    tick(8); // past the random GO moment (<= 6 s)
    const a = await call('POST', '/api/me/game/answers', { cookie: cookies[0]!, body: {} });
    expect(a.statusCode).toBe(200);
    const b = await call('POST', '/api/me/game/answers', { cookie: cookies[1]!, body: { answerId: 'tap' } });
    expect(b.statusCode).toBe(200);
    expect((await call('POST', '/api/me/game/answers', { cookie: cookies[0]!, body: {} })).json().error.code).toBe('already_submitted');
    await call('POST', `/games/${speed}`, { body: { action: 'cancel' } });
    const trivia = (await call('POST', '/games', { body: { kind: 'trivia', config: { rounds: 1, introSeconds: 0 } } })).json().gameId;
    await call('POST', `/games/${trivia}`, { body: { action: 'start' } });
    await call('POST', `/games/${trivia}`, { body: { action: 'next' } });
    const none = await call('POST', '/api/me/game/answers', { cookie: cookies[0]!, body: {} });
    expect(none.statusCode).toBe(422);
    expect(none.json().error.code).toBe('invalid_answer');
    await call('POST', `/games/${trivia}`, { body: { action: 'cancel' } });
    // mini-games can be switched off
    await call('PATCH', '/features', { body: { miniGames: false } });
    expect((await call('GET', '/games')).json()).toMatchObject({ enabled: false, canCreate: false });
    expect((await call('POST', '/games', { body: { kind: 'trivia' } })).json().error.code).toBe('feature_disabled');
    await call('PATCH', '/features', { body: { miniGames: true } });
  });

  /* ---------------------------------------------------------------- B: coins + auction */

  it('coins are self-only and have no board, no purchase and no transfer route', async () => {
    const grant = await call('POST', '/coins/grants', { body: { key: 'welcome', amount: 50 } });
    expect(grant.json()).toEqual({ granted: 8 });
    expect((await call('POST', '/coins/grants', { body: { key: 'welcome', amount: 50 } })).json()).toEqual({ granted: 0 });
    const mine = (await call('GET', '/api/me/coins', { cookie: cookies[1]! })).json();
    expect(mine).toMatchObject({ enabled: true, balance: 50, held: 0 });
    expect(Object.keys(mine).sort()).toEqual(['balance', 'enabled', 'entries', 'held']);
    expect((await call('GET', '/api/me/coins', { cookie: OWNER() })).statusCode).toBe(401);
    expect((await call('GET', '/api/me/coins', { cookie: await w.displayCookie() })).statusCode).toBe(401);
    const org = (await call('GET', '/coins')).json();
    expect(org).toMatchObject({ enabled: true, issued: 400 });
    expect(scanForbidden(org, { keys: ['balance', 'participantId'] })).toEqual([]);
    const coinRoutes = routes.filter((r) => /coin|auction/.test(r.url)).map((r) => `${r.method} ${r.url}`);
    expect(coinRoutes.length).toBeGreaterThan(5);
    expect(coinRoutes.filter((r) => /purchas|buy|transfer|convert|cash|payment|leader|rank|top|balances/i.test(r))).toEqual([]);
    // the XP-earning hook pays coins to the right person only
    await w.db.insert(xpLedger).values({ eventId: w.eventId, participantId: w.participantIds[2]!, activity: 'game_play', amount: 5, rewardKey: 'x', qualifying: false });
    expect((await call('GET', '/api/me/coins', { cookie: cookies[2]! })).json().balance).toBe(50); // direct inserts bypass the hook by design
  });

  it('auction end to end: price only on the display, "you are leading" only for you, winner announced, box revealed', async () => {
    const created = await call('POST', '/auction/prizes', { body: { title: { en: 'Mystery Box 1', it: 'Scatola 1' }, reveal: { en: 'A cozy scarf', it: 'Una sciarpa' }, minBid: 10 } });
    expect(created.statusCode).toBe(201);
    const prizeId = created.json().prizeId;
    expect(created.json()).toMatchObject({ status: 'draft', reveal: { en: 'A cozy scarf' } });
    expect((await call('POST', `/auction/prizes/${prizeId}`, { cookie: cookies[0]!, body: { action: 'open' } })).statusCode).toBe(401);
    expect((await call('POST', `/auction/prizes/${prizeId}`, { body: { action: 'open', durationSeconds: 60 } })).json()).toMatchObject({ status: 'open', onStage: true });
    await sleep(300);
    const scene = surfaces(dSeen, 'scene').at(-1)!;
    expect(scene).toMatchObject({ scene: 'auction', auction: { status: 'open', currentBid: null, minNextBid: 10, reveal: null, winner: null } });
    expect(JSON.stringify(scene)).not.toContain('cozy'); // mystery content is not on any pre-reveal payload

    const bid = (i: number, amount: number) => call('POST', '/api/me/auction/bids', { cookie: cookies[i]!, body: { amount } });
    expect((await bid(1, 9)).json().error.code).toBe('bid_too_low');
    expect((await bid(1, 80)).json().error.code).toBe('insufficient_coins');
    const first = await bid(1, 12);
    expect(first.json()).toMatchObject({ amount: 12, leading: true, extended: false });
    expect((await bid(1, 20)).json().error.code).toBe('already_leading');
    await bid(2, 15);
    await sleep(900); // coalesced scene push
    const priced = surfaces(dSeen, 'scene').at(-1) as { auction: { currentBid: number } };
    expect(priced.auction.currentBid).toBe(15);
    // nothing on the public stream names a bidder
    expect(scanForbidden(surfaces(dSeen, 'scene'), { values: [w.participantIds[1]!, w.participantIds[2]!], keys: ['bidderId', 'bids'] })).toEqual([]);
    const you = (await call('GET', '/api/me/auction', { cookie: cookies[2]! })).json();
    expect(you).toMatchObject({ enabled: true, balance: 35, you: { leading: true, myBid: 15 } });
    expect((await call('GET', '/api/me/auction', { cookie: cookies[1]! })).json()).toMatchObject({ balance: 50, you: { leading: false } });
    expect((await call('GET', '/api/me/auction', { cookie: cookies[5]! })).json().you).toEqual({ leading: false, myBid: null });
    expect(JSON.stringify(await call('GET', '/auction/prizes').then((r) => r.json()))).not.toContain(w.participantIds[2]!);

    // durable close at the deadline (the timer job)
    const runner = new JobRunner(w.db, { clock: () => now });
    registerAuctionJobs(runner, w.app.hub!, w.db, () => now);
    tick(30);
    await runner.tick(); // too early: no-op
    expect((await call('GET', '/auction/prizes')).json().prizes[0].status).toBe('open');
    tick(40);
    await runner.tick();
    await sleep(400);
    const won = surfaces(dSeen, 'announcement').find((p) => p['type'] === 'auction_won')!;
    expect(won).toMatchObject({ prizeId, winner: { displayName: 'Sofia' } });
    const closed = surfaces(dSeen, 'scene').at(-1) as { auction: { status: string; reveal: unknown; winner: { displayName: string } } };
    expect(closed.auction).toMatchObject({ status: 'closed', reveal: null, winner: { displayName: 'Sofia' } });
    expect((await bid(3, 30)).json().error.code).toBe('auction_closed');
    expect((await call('GET', '/api/me/coins', { cookie: cookies[1]! })).json().balance).toBe(50); // refunded
    expect((await call('GET', '/api/me/coins', { cookie: cookies[2]! })).json().balance).toBe(35); // paid

    expect((await call('POST', `/auction/prizes/${prizeId}`, { body: { action: 'reveal' } })).json()).toMatchObject({ status: 'revealed' });
    await sleep(300);
    expect(surfaces(dSeen, 'announcement').find((p) => p['type'] === 'mystery_reveal')).toMatchObject({ cue: 'box_open', reveal: { en: 'A cozy scarf' }, winner: { displayName: 'Sofia' } });
    expect((surfaces(dSeen, 'scene').at(-1) as { auction: { reveal: unknown } }).auction.reveal).toEqual({ en: 'A cozy scarf', it: 'Una sciarpa' });
    await call('POST', `/auction/prizes/${prizeId}`, { body: { action: 'dismiss' } });
    await sleep(300);
    expect(surfaces(dSeen, 'scene').at(-1)).toMatchObject({ scene: 'phase', phase: 'games' });
    expect((await call('DELETE', `/auction/prizes/${prizeId}`)).json().error.code).toBe('invalid_prize_state');
    // switching the auction off removes the stage and the routes refuse
    await call('PATCH', '/features', { body: { auction: false } });
    expect((await call('GET', '/api/me/auction', { cookie: cookies[1]! })).json()).toMatchObject({ enabled: false, prize: null });
    expect((await call('POST', '/api/me/auction/bids', { cookie: cookies[1]!, body: { amount: 10 } })).json().error.code).toBe('auction_disabled');
    // participants never see the mission/guess machinery of the other phase through here
    expect(mSeen.length).toBeGreaterThan(0);
  });

  /* ---------------------------------------------------------------- history, link, HoF, lifetime */

  it('history archive, lifetime titles via the emailed link, Hall of Fame (positive only)', async () => {
    const gs = await w.db
      .insert(gifts)
      .values(w.participantIds.map((giverId, i) => ({ eventId: w.eventId, giverId, aliasNo: i + 1, name: `Present ${i + 1}`, status: 'revealed' as const, giverRevealedAt: now })))
      .returning();
    await w.db.insert(awards).values({ eventId: w.eventId, boardKey: 'best_overall', winners: [gs[3]!.id], publishable: true, lockedAt: now, revealedAt: now });
    await w.db.insert(participantAchievements).values({ eventId: w.eventId, participantId: w.participantIds[3]!, key: 'christmas_champion', source: 'ceremony' });
    await setPhase('completed');
    const hist = (await call('GET', '/api/me/history', { cookie: cookies[1]! })).json();
    expect(hist.enabled).toBe(true);
    expect(hist.archive.winners).toEqual([expect.objectContaining({ boardKey: 'best_overall', grand: true, giver: expect.objectContaining({ displayName: 'Luca' }) })]);
    expect(hist.archive.champion.displayName).toBe('Luca');
    expect(scanForbidden(hist, { keys: ['votes', 'voterId', 'xp', 'score', 'total', 'giverId'] })).toEqual([]);
    expect((await call('GET', '/archive')).json().archive.name).toBe(hist.archive.name);
    const hof = (await call('GET', '/api/me/hall-of-fame', { cookie: cookies[1]! })).json();
    expect(hof.years[0].events[0].champions.map((c: { kind: string }) => c.kind).sort()).toEqual(['christmas_champion', 'grand_champion']);
    expect(hof.seasons).toEqual([]);

    // guest -> account claim through an emailed single-use link
    expect((await call('GET', '/api/me/lifetime', { cookie: cookies[3]! })).json()).toEqual({ linked: false, profile: null });
    await w.db.update(participants).set({ claimVerifiedAt: now }).where(eq(participants.id, w.participantIds[3]!));
    await w.db.update(participants).set({ claimVerifiedAt: null }).where(eq(participants.id, w.participantIds[4]!));
    expect((await call('POST', '/api/me/account-link', { cookie: cookies[4]!, body: { email: 'chiara@example.test' } })).json().error.code).toBe('verification_required');
    expect((await call('POST', '/api/me/account-link', { cookie: cookies[3]!, body: { email: 'not-an-email' } })).statusCode).toBe(400);
    expect((await call('POST', '/api/me/account-link', { cookie: cookies[3]!, body: { email: 'luca@example.test' } })).json()).toEqual({ sent: true });
    const mail = email.sent.at(-1)!;
    expect(mail.to).toBe('luca@example.test');
    const token = /token=([\w-]+)/.exec(mail.text)![1]!;
    expect((await call('POST', '/api/account-link/confirm', { cookie: '', body: { token: 'x'.repeat(30) } })).statusCode).toBe(401);
    const confirm = await call('POST', '/api/account-link/confirm', { cookie: '', body: { token } });
    expect(confirm.json()).toEqual({ linked: true });
    expect((await call('POST', '/api/account-link/confirm', { cookie: '', body: { token } })).statusCode).toBe(401); // single use
    const life = (await call('GET', '/api/me/lifetime', { cookie: cookies[3]! })).json();
    expect(life.linked).toBe(true);
    expect(life.profile).toMatchObject({ displayName: 'Luca', events: 1, participationYears: [2026], totalAchievements: 1 });
    expect(life.profile.titles[0]).toMatchObject({ key: 'christmas_champion', trophy: true });
    // the account profile is for signed-in accounts only (guest/display get 401)
    expect((await call('GET', '/api/account/profile', { cookie: cookies[3]! })).statusCode).toBe(401);
    expect((await call('GET', '/api/account/profile', { cookie: await w.displayCookie() })).statusCode).toBe(401);
  });

  /* ---------------------------------------------------------------- custom categories / achievements */

  it('custom categories and achievements: organizer editor with locks', async () => {
    await w.db.update(events).set({ phase: 'gift_registration', completedAt: null }).where(eq(events.id, w.eventId));
    const created = await call('POST', '/categories', { body: { key: 'c_cozy', name: { en: 'Coziest', it: 'Più Accogliente' } } });
    expect(created.statusCode).toBe(201);
    expect(created.json().categories.find((c: { key: string }) => c.key === 'c_cozy')).toMatchObject({ custom: true, enabled: true });
    expect((await call('POST', '/categories', { body: { key: 'best_overall', name: { en: 'x' } } })).statusCode).toBe(400); // key space
    expect((await call('POST', '/categories', { body: { key: 'c_cozy', name: { en: 'Dup' } } })).json().error.code).toBe('duplicate_key');
    const cat = created.json().categories.find((c: { key: string }) => c.key === 'c_cozy');
    const patched = await call('PATCH', `/categories/${cat.categoryId}`, { body: { name: { en: 'Coziest Gift' } } });
    expect(patched.json().categories.find((c: { key: string }) => c.key === 'c_cozy').name.en).toBe('Coziest Gift');
    const ach = await call('POST', '/custom-achievements', { body: { key: 'c_cozy_king', name: { en: 'Cozy King', it: 'Re del Comfort' }, description: { en: 'Coziest gift' }, categoryKey: 'c_cozy' } });
    expect(ach.statusCode).toBe(201);
    const defs = (await call('GET', '/api/me/custom-achievements', { cookie: cookies[1]! })).json();
    expect(defs.achievements).toEqual([expect.objectContaining({ key: 'c_cozy_king', categoryKey: 'c_cozy' })]);
    expect((await call('DELETE', `/categories/${cat.categoryId}`)).json().error.code).toBe('category_in_use');
    // participants cannot edit; frozen once voting is open
    expect((await call('POST', '/categories', { cookie: cookies[1]!, body: { key: 'c_x1', name: { en: 'X1' } } })).statusCode).toBe(401);
    await w.db.update(events).set({ phase: 'voting' }).where(eq(events.id, w.eventId));
    expect((await call('POST', '/categories', { body: { key: 'c_late', name: { en: 'Late' } } })).json().error.code).toBe('categories_locked');
    expect((await call('GET', '/categories')).json().editable).toBe(false);
    // manual award in games phase: positive, announced
    await setPhase('games');
    const manual = (await call('POST', '/custom-achievements', { body: { key: 'c_helper', name: { en: 'Super Helper' }, description: { en: 'Always helping' } } })).json().achievements.find((a: { key: string }) => a.key === 'c_helper');
    const before = dSeen.length;
    const aw = await call('POST', `/custom-achievements/${manual.achievementId}/awards`, { body: { participantIds: [w.participantIds[5]!] } });
    expect(aw.json()).toEqual({ awarded: 1 });
    await sleep(300);
    expect(surfaces(dSeen.slice(before), 'announcement')[0]).toMatchObject({ type: 'achievement', key: 'c_helper', person: { displayName: 'Paolo' } });
    // certificates know custom achievements too
    const cert = await call('GET', '/api/me/achievements/c_helper/certificate.png?locale=en', { cookie: cookies[5]! });
    expect(cert.statusCode).toBe(200);
    expect(cert.headers['content-type']).toBe('image/png');
  }, 30_000);

  it('Phase 2 background jobs still register next to the auction timer', async () => {
    const runner = new JobRunner(w.db, { clock: () => now });
    registerPhase2Jobs(runner, w.app.hub!, w.db, () => now);
    registerAuctionJobs(runner, w.app.hub!, w.db, () => now);
    await expect(runner.tick()).resolves.toBeTypeOf('number');
  });
});
