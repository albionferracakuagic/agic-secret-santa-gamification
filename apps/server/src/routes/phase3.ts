import type { FastifyInstance } from 'fastify';
import {
  AccountLinkConfirmRequestSchema,
  AccountLinkConfirmResponseSchema,
  AccountLinkStartRequestSchema,
  AccountLinkStartResponseSchema,
  ArchiveResponseSchema,
  AwardCustomAchievementRequestSchema,
  AwardCustomAchievementResponseSchema,
  CoinGrantRequestSchema,
  CoinGrantResponseSchema,
  CreateCategoryRequestSchema,
  CreateCustomAchievementRequestSchema,
  CreatePrizeRequestSchema,
  CustomAchievementsResponseSchema,
  EventFeaturesResponseSchema,
  FeaturesPatchSchema,
  HallOfFameResponseSchema,
  LifetimeResponseSchema,
  MyAuctionResponseSchema,
  MyCoinsResponseSchema,
  OrganizerCategoriesResponseSchema,
  OrganizerCoinsResponseSchema,
  OrganizerPrizeSchema,
  OrganizerPrizesResponseSchema,
  PlaceBidRequestSchema,
  PlaceBidResponseSchema,
  PrizeActionRequestSchema,
  PrizeActionResponseSchema,
  UpdateCategoryRequestSchema,
  UpdateCustomAchievementRequestSchema,
  UpdatePrizeRequestSchema,
} from '@santa/contracts';
import {
  archiveView,
  awardCustomAchievement,
  confirmAccountLink,
  createCategory,
  createCustomAchievement,
  createLinkToken,
  createPrize,
  deleteCategory,
  deleteCustomAchievement,
  deletePrize,
  grantCoins,
  hallOfFame,
  lifetimeProfile,
  listCustomAchievements,
  myAuction,
  myCoins,
  organizerCategories,
  organizerCoins,
  organizerPrizes,
  participantLifetime,
  placeBid,
  prizeAction,
  updateCategory,
  updateCustomAchievement,
  updateFeatures,
  updatePrize,
  type Db,
} from '@santa/db';
import type { OrganizerSessions, PrincipalStore } from '../principal.js';
import type { RealtimeHub } from '../realtime/hub.js';
import type { EmailTransport } from '../auth/email.js';
import type { StorageAdapter } from '../storage/adapter.js';
import { PHOTO_URL_TTL_SECONDS } from '../storage/adapter.js';
import { broadcastEventState } from '../realtime/broadcast.js';
import { broadcastScene, broadcastSceneSoon, emitAnnouncements } from '../realtime/phase2.js';
import { announceAuctionClosed, announceMysteryReveal } from '../realtime/phase3.js';
import { fail, makeGuards, makeParticipantGuard } from './guards.js';
import { hashToken, newToken } from '../tokens.js';

export interface Phase3RouteDeps {
  db: Db;
  sessions: OrganizerSessions;
  principals: PrincipalStore;
  hub: RealtimeHub;
  clock: () => Date;
  email: EmailTransport;
  baseUrl: string;
  storage?: StorageAdapter | undefined;
}

const publicLimit = (max: number) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });

/**
 * Phase 3: feature switches, Santa Coins (FR-033), mystery auction (FR-034), history / Hall of Fame / account link
 * (FR-042..044) and the custom categories/achievements editor. Balances, bids and lifetime data are self-only; the
 * display and organizer projections contain prices and public winners, never bidders or per-person coin data.
 */
export function registerPhase3Routes(app: FastifyInstance, d: Phase3RouteDeps) {
  const g = makeGuards(d);
  const mine = makeParticipantGuard(d.db);
  const photoUrl = async (key: string) =>
    d.storage ? d.storage.readUrl(key, PHOTO_URL_TTL_SECONDS) : null;

  /* ================= feature switches ================= */

  app.patch('/api/events/:eventId/features', { preHandler: g.pre }, async (req, reply) => {
    const b = g.body(reply, FeaturesPatchSchema, req.body);
    if (!b) return;
    return g.run(reply, async () => {
      const eventId = g.eventParams(req);
      const r = await updateFeatures(d.db, { eventId, actor: req.org!.userId, patch: b, now: d.clock() });
      await broadcastEventState(d.hub, d.db, eventId);
      return EventFeaturesResponseSchema.parse(r);
    });
  });

  /* ================= coins ================= */

  app.get('/api/me/coins', { preHandler: mine }, async (req) => {
    const r = await myCoins(d.db, req.me!.participantId);
    return MyCoinsResponseSchema.parse({
      ...r,
      entries: r.entries.map((x) => ({ reason: x.reason, amount: x.amount, at: x.at.toISOString() })),
    });
  });

  app.get('/api/events/:eventId/coins', { preHandler: g.pre }, async (req) =>
    OrganizerCoinsResponseSchema.parse(await organizerCoins(d.db, g.eventParams(req))),
  );

  app.post('/api/events/:eventId/coins/grants', { preHandler: g.pre }, async (req, reply) => {
    const b = g.body(reply, CoinGrantRequestSchema, req.body);
    if (!b) return;
    return g.run(reply, async () =>
      CoinGrantResponseSchema.parse(
        await grantCoins(d.db, {
          eventId: g.eventParams(req),
          actor: req.org!.userId,
          key: b.key,
          amount: b.amount,
          participantIds: b.participantIds,
          now: d.clock(),
        }),
      ),
    );
  });

  /* ================= auction ================= */

  app.get('/api/me/auction', { preHandler: mine }, async (req) =>
    MyAuctionResponseSchema.parse(await myAuction(d.db, req.me!.participantId)),
  );

  app.post('/api/me/auction/bids', { preHandler: mine }, async (req, reply) => {
    const b = g.body(reply, PlaceBidRequestSchema, req.body);
    if (!b) return;
    return g.run(reply, async () => {
      const r = await placeBid(d.db, { participantId: req.me!.participantId, amount: b.amount, now: d.clock() });
      broadcastSceneSoon(d.hub, d.db, req.me!.eventId, 300); // new price (and a moved deadline) on the display
      return PlaceBidResponseSchema.parse({ ...r, endsAt: r.endsAt.toISOString() });
    });
  });

  const prizeOut = (p: Awaited<ReturnType<typeof organizerPrizes>>['prizes'][number]) =>
    OrganizerPrizeSchema.parse(p);

  app.get('/api/events/:eventId/auction/prizes', { preHandler: g.pre }, async (req, reply) =>
    g.run(reply, async () =>
      OrganizerPrizesResponseSchema.parse(await organizerPrizes(d.db, g.eventParams(req))),
    ),
  );

  app.post('/api/events/:eventId/auction/prizes', { preHandler: g.pre }, async (req, reply) => {
    const b = g.body(reply, CreatePrizeRequestSchema, req.body);
    if (!b) return;
    return g.run(reply, async () => {
      const eventId = g.eventParams(req);
      const row = await createPrize(d.db, { eventId, actor: req.org!.userId, ...b, now: d.clock() });
      reply.status(201);
      return prizeOut((await organizerPrizes(d.db, eventId)).prizes.find((x) => x.prizeId === row.id)!);
    });
  });

  app.patch('/api/events/:eventId/auction/prizes/:prizeId', { preHandler: g.pre }, async (req, reply) => {
    const b = g.body(reply, UpdatePrizeRequestSchema, req.body);
    if (!b) return;
    const { prizeId } = req.params as { prizeId: string };
    return g.run(reply, async () => {
      const eventId = g.eventParams(req);
      await updatePrize(d.db, { eventId, prizeId, actor: req.org!.userId, patch: b, now: d.clock() });
      return prizeOut((await organizerPrizes(d.db, eventId)).prizes.find((x) => x.prizeId === prizeId)!);
    });
  });

  app.delete('/api/events/:eventId/auction/prizes/:prizeId', { preHandler: g.pre }, async (req, reply) => {
    const { prizeId } = req.params as { prizeId: string };
    return g.run(reply, async () => {
      await deletePrize(d.db, { eventId: g.eventParams(req), prizeId, actor: req.org!.userId, now: d.clock() });
      return reply.status(204).send();
    });
  });

  app.post('/api/events/:eventId/auction/prizes/:prizeId', { preHandler: g.pre }, async (req, reply) => {
    const b = g.body(reply, PrizeActionRequestSchema, req.body);
    if (!b) return;
    const { prizeId } = req.params as { prizeId: string };
    return g.run(reply, async () => {
      const now = d.clock();
      const eventId = g.eventParams(req);
      const r = await prizeAction(d.db, {
        eventId,
        prizeId,
        action: b.action,
        durationSeconds: b.durationSeconds,
        actor: req.org!.userId,
        now,
      });
      await broadcastScene(d.hub, d.db, eventId);
      if (b.action === 'close') await announceAuctionClosed(d.hub, d.db, eventId, r.prize, now);
      if (b.action === 'reveal') await announceMysteryReveal(d.hub, d.db, eventId, r.prize, now);
      return PrizeActionResponseSchema.parse({
        prizeId: r.prize.id,
        status: r.prize.status,
        onStage: r.prize.onStage,
      });
    });
  });

  /* ================= history, hall of fame, lifetime ================= */

  const archiveOut = async (eventId: string) =>
    ArchiveResponseSchema.parse(await archiveView(d.db, eventId, d.clock(), photoUrl));

  app.get('/api/events/:eventId/archive', { preHandler: g.pre }, async (req) =>
    archiveOut(g.eventParams(req)),
  );
  app.get('/api/me/history', { preHandler: mine }, async (req) => archiveOut(req.me!.eventId));

  const hof = async (eventId: string) =>
    HallOfFameResponseSchema.parse(await hallOfFame(d.db, eventId, d.clock()));
  app.get('/api/events/:eventId/hall-of-fame', { preHandler: g.pre }, async (req) =>
    hof(g.eventParams(req)),
  );
  app.get('/api/me/hall-of-fame', { preHandler: mine }, async (req) => hof(req.me!.eventId));

  app.get('/api/me/lifetime', { preHandler: mine }, async (req) =>
    LifetimeResponseSchema.parse(await participantLifetime(d.db, req.me!.participantId)),
  );

  /** Signed-in account (Better Auth session, e.g. after the magic link): its lifetime titles. */
  app.get('/api/account/profile', async (req, reply) => {
    const s = await d.sessions.fromCookieHeader(req.headers.cookie);
    if (!s) return fail(reply, 401, 'unauthenticated', 'Sign in required');
    return LifetimeResponseSchema.parse(await lifetimeProfile(d.db, s.userId));
  });

  app.post('/api/me/account-link', { preHandler: mine, ...publicLimit(5) }, async (req, reply) => {
    const b = g.body(reply, AccountLinkStartRequestSchema, req.body);
    if (!b) return;
    return g.run(reply, async () => {
      const token = newToken();
      await createLinkToken(d.db, {
        participantId: req.me!.participantId,
        email: b.email,
        tokenHash: hashToken(token),
        now: d.clock(),
      });
      await d.email.send({
        to: b.email,
        subject: 'Link your Secret Santa profile',
        text: `Open this link within 30 minutes to keep your titles across events:\n${d.baseUrl}/link?token=${token}\n`,
      });
      return AccountLinkStartResponseSchema.parse({ sent: true });
    });
  });

  app.post('/api/account-link/confirm', publicLimit(10), async (req, reply) => {
    const b = g.body(reply, AccountLinkConfirmRequestSchema, req.body);
    if (!b) return;
    try {
      await confirmAccountLink(d.db, { tokenHash: hashToken(b.token), now: d.clock() });
      return AccountLinkConfirmResponseSchema.parse({ linked: true });
    } catch (e) {
      // one generic answer for wrong / used / expired tokens
      if (e instanceof Error && 'code' in e && ['invalid_link', 'already_linked'].includes(String((e as { code: string }).code)))
        return fail(reply, 401, 'invalid_link');
      throw e;
    }
  });

  /* ================= custom categories / achievements ================= */

  app.get('/api/events/:eventId/categories', { preHandler: g.pre }, async (req) =>
    OrganizerCategoriesResponseSchema.parse(await organizerCategories(d.db, g.eventParams(req))),
  );
  const categoryOut = async (eventId: string) =>
    OrganizerCategoriesResponseSchema.parse(await organizerCategories(d.db, eventId));

  app.post('/api/events/:eventId/categories', { preHandler: g.pre }, async (req, reply) => {
    const b = g.body(reply, CreateCategoryRequestSchema, req.body);
    if (!b) return;
    return g.run(reply, async () => {
      const eventId = g.eventParams(req);
      await createCategory(d.db, { eventId, actor: req.org!.userId, ...b, now: d.clock() });
      reply.status(201);
      return categoryOut(eventId);
    });
  });
  app.patch('/api/events/:eventId/categories/:categoryId', { preHandler: g.pre }, async (req, reply) => {
    const b = g.body(reply, UpdateCategoryRequestSchema, req.body);
    if (!b) return;
    const { categoryId } = req.params as { categoryId: string };
    return g.run(reply, async () => {
      const eventId = g.eventParams(req);
      await updateCategory(d.db, { eventId, categoryId, actor: req.org!.userId, patch: b, now: d.clock() });
      return categoryOut(eventId);
    });
  });
  app.delete('/api/events/:eventId/categories/:categoryId', { preHandler: g.pre }, async (req, reply) => {
    const { categoryId } = req.params as { categoryId: string };
    return g.run(reply, async () => {
      const eventId = g.eventParams(req);
      await deleteCategory(d.db, { eventId, categoryId, actor: req.org!.userId, now: d.clock() });
      return categoryOut(eventId);
    });
  });

  app.get('/api/events/:eventId/custom-achievements', { preHandler: g.pre }, async (req) =>
    CustomAchievementsResponseSchema.parse({ achievements: await listCustomAchievements(d.db, g.eventParams(req)) }),
  );
  app.post('/api/events/:eventId/custom-achievements', { preHandler: g.pre }, async (req, reply) => {
    const b = g.body(reply, CreateCustomAchievementRequestSchema, req.body);
    if (!b) return;
    return g.run(reply, async () => {
      const eventId = g.eventParams(req);
      await createCustomAchievement(d.db, { eventId, actor: req.org!.userId, ...b, now: d.clock() });
      reply.status(201);
      return CustomAchievementsResponseSchema.parse({ achievements: await listCustomAchievements(d.db, eventId) });
    });
  });
  app.patch('/api/events/:eventId/custom-achievements/:achievementId', { preHandler: g.pre }, async (req, reply) => {
    const b = g.body(reply, UpdateCustomAchievementRequestSchema, req.body);
    if (!b) return;
    const { achievementId } = req.params as { achievementId: string };
    return g.run(reply, async () => {
      const eventId = g.eventParams(req);
      await updateCustomAchievement(d.db, { eventId, achievementId, actor: req.org!.userId, patch: b, now: d.clock() });
      return CustomAchievementsResponseSchema.parse({ achievements: await listCustomAchievements(d.db, eventId) });
    });
  });
  app.delete('/api/events/:eventId/custom-achievements/:achievementId', { preHandler: g.pre }, async (req, reply) => {
    const { achievementId } = req.params as { achievementId: string };
    return g.run(reply, async () => {
      const eventId = g.eventParams(req);
      await deleteCustomAchievement(d.db, { eventId, achievementId, actor: req.org!.userId, now: d.clock() });
      return CustomAchievementsResponseSchema.parse({ achievements: await listCustomAchievements(d.db, eventId) });
    });
  });
  app.post('/api/events/:eventId/custom-achievements/:achievementId/awards', { preHandler: g.pre }, async (req, reply) => {
    const b = g.body(reply, AwardCustomAchievementRequestSchema, req.body);
    if (!b) return;
    const { achievementId } = req.params as { achievementId: string };
    return g.run(reply, async () => {
      const now = d.clock();
      const eventId = g.eventParams(req);
      const r = await awardCustomAchievement(d.db, {
        eventId,
        achievementId,
        participantIds: b.participantIds,
        actor: req.org!.userId,
        now,
      });
      await emitAnnouncements(d.hub, d.db, eventId, r.announcements, now);
      if (r.awarded) await broadcastEventState(d.hub, d.db, eventId);
      return AwardCustomAchievementResponseSchema.parse({ awarded: r.awarded });
    });
  });

  /** Names of the event's custom achievements, so clients can label keys the static catalog does not know. */
  app.get('/api/me/custom-achievements', { preHandler: mine }, async (req) =>
    CustomAchievementsResponseSchema.parse({ achievements: await listCustomAchievements(d.db, req.me!.eventId) }),
  );
}

