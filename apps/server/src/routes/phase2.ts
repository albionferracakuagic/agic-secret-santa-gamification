import type { FastifyInstance } from 'fastify';
import {
  AssignMissionsRequestSchema,
  AssignMissionsResponseSchema,
  BingoDecisionRequestSchema,
  BingoDecisionResponseSchema,
  BingoMarkRequestSchema,
  BingoMarkResponseSchema,
  BingoPendingResponseSchema,
  ClueDecisionRequestSchema,
  ClueDecisionResponseSchema,
  ClueQueueResponseSchema,
  CreateGameRequestSchema,
  GameActionRequestSchema,
  GameActionResponseSchema,
  GuessStateResponseSchema,
  HideSpotlightResponseSchema,
  MissionOptOutRequestSchema,
  MissionOptOutResponseSchema,
  MyCluesResponseSchema,
  MyGameResponseSchema,
  MyMissionsResponseSchema,
  OrganizerGamesResponseSchema,
  OrganizerMissionsResponseSchema,
  PresentRequestSchema,
  PresentResponseSchema,
  ReassignMissionResponseSchema,
  SetGuessRequestSchema,
  SetGuessResponseSchema,
  SubmitAnswerRequestSchema,
  SubmitAnswerResponseSchema,
  SubmitClueRequestSchema,
  SubmitClueResponseSchema,
  SubmitMissionRequestSchema,
  SubmitMissionResponseSchema,
  VerifyMissionRequestSchema,
  VerifyMissionResponseSchema,
} from '@santa/contracts';
import {
  assignMissions,
  clueQueue,
  createGame,
  decideBingoMark,
  decideClue,
  decideMission,
  gameAction,
  guessState,
  hideSpotlight,
  listGames,
  markBingo,
  myGameState,
  myMissions,
  organizerMissions,
  ownClues,
  pendingBingoMarks,
  presentSpotlight,
  setGuess,
  setMissionOptOut,
  submitAnswer,
  submitClue,
  submitMission,
  swapMission,
  type Db,
} from '@santa/db';
import type { OrganizerSessions, PrincipalStore } from '../principal.js';
import type { RealtimeHub } from '../realtime/hub.js';
import { broadcastEventState, broadcastParticipantState } from '../realtime/broadcast.js';
import { broadcastScene, broadcastSceneSoon, emitAnnouncements } from '../realtime/phase2.js';
import { makeGuards, makeParticipantGuard } from './guards.js';

export interface Phase2RouteDeps {
  db: Db;
  sessions: OrganizerSessions;
  principals: PrincipalStore;
  hub: RealtimeHub;
  clock: () => Date;
}

const iso = (d: Date) => d.toISOString();

/**
 * Phase 2: Guess Your Secret Santa (FR-025..027), secret missions (FR-028..030), mini-games (FR-031/032) and the
 * canPublish-gated presentations. Participant routes live under /api/me and return ONLY the caller's own data;
 * organizer routes are masked (no authors, no guesses, no unsubmitted missions). No route name or payload carries
 * a ranking, score or tally of unpublished data.
 */
export function registerPhase2Routes(app: FastifyInstance, d: Phase2RouteDeps) {
  const g = makeGuards(d);
  const mine = makeParticipantGuard(d.db);

  /* ================= guess your secret Santa ================= */

  app.get('/api/me/guess', { preHandler: mine }, async (req) =>
    GuessStateResponseSchema.parse(await guessState(d.db, req.me!.participantId, d.clock())),
  );

  app.put('/api/me/guesses/:giftId', { preHandler: mine }, async (req, reply) => {
    const b = g.body(reply, SetGuessRequestSchema, req.body);
    if (!b) return;
    const { giftId } = req.params as { giftId: string };
    return g.run(reply, async () =>
      SetGuessResponseSchema.parse(
        await setGuess(d.db, {
          participantId: req.me!.participantId,
          giftId,
          suspectId: b.suspectId,
          now: d.clock(),
        }),
      ),
    );
  });

  app.post('/api/me/clues', { preHandler: mine }, async (req, reply) => {
    const b = g.body(reply, SubmitClueRequestSchema, req.body);
    if (!b) return;
    return g.run(reply, async () =>
      SubmitClueResponseSchema.parse(
        await submitClue(d.db, {
          participantId: req.me!.participantId,
          text: b.text,
          now: d.clock(),
        }),
      ),
    );
  });

  app.get('/api/me/clues', { preHandler: mine }, async (req) =>
    MyCluesResponseSchema.parse({ clues: await ownClues(d.db, req.me!.participantId) }),
  );

  app.get('/api/events/:eventId/clues', { preHandler: g.pre }, async (req) =>
    ClueQueueResponseSchema.parse({ clues: await clueQueue(d.db, g.eventParams(req)) }),
  );

  app.post('/api/events/:eventId/clues/:clueId', { preHandler: g.pre }, async (req, reply) => {
    const b = g.body(reply, ClueDecisionRequestSchema, req.body);
    if (!b) return;
    const { clueId } = req.params as { clueId: string };
    return g.run(reply, async () => {
      const now = d.clock();
      const eventId = g.eventParams(req);
      const r = await decideClue(d.db, {
        eventId,
        clueId,
        action: b.action,
        actor: req.org!.userId,
        now,
      });
      if (r.status === 'approved')
        d.hub.publish(eventId, 'pub', 'announcement', {
          type: 'clue',
          giftId: r.giftId,
          alias: r.alias,
          text: r.text,
          at: iso(now),
        });
      return ClueDecisionResponseSchema.parse({ clueId: r.clueId, status: r.status });
    });
  });

  /* ================= presentations ================= */

  app.post('/api/events/:eventId/presentations', { preHandler: g.pre }, async (req, reply) => {
    const b = g.body(reply, PresentRequestSchema, req.body);
    if (!b) return;
    return g.run(reply, async () => {
      const now = d.clock();
      const eventId = g.eventParams(req);
      const r = await presentSpotlight(d.db, {
        eventId,
        kind: b.kind,
        actor: req.org!.userId,
        now,
      });
      await broadcastScene(d.hub, d.db, eventId);
      await emitAnnouncements(d.hub, d.db, eventId, r.announcements, now);
      if (r.announcements.length) await broadcastEventState(d.hub, d.db, eventId);
      return PresentResponseSchema.parse({
        kind: b.kind,
        published: r.published,
        reason: r.reason,
        achievementsUnlocked: r.announcements.length,
      });
    });
  });

  app.delete('/api/events/:eventId/presentations', { preHandler: g.pre }, async (req, reply) =>
    g.run(reply, async () => {
      const eventId = g.eventParams(req);
      await hideSpotlight(d.db, { eventId, actor: req.org!.userId, now: d.clock() });
      await broadcastScene(d.hub, d.db, eventId);
      return HideSpotlightResponseSchema.parse({ hidden: true });
    }),
  );

  /* ================= missions ================= */

  app.get('/api/me/missions', { preHandler: mine }, async (req) =>
    MyMissionsResponseSchema.parse(await myMissions(d.db, req.me!.participantId)),
  );

  app.post('/api/me/missions/opt-out', { preHandler: mine }, async (req, reply) => {
    const b = g.body(reply, MissionOptOutRequestSchema, req.body);
    if (!b) return;
    return g.run(reply, async () =>
      MissionOptOutResponseSchema.parse(
        await setMissionOptOut(d.db, { participantId: req.me!.participantId, optOut: b.optOut }),
      ),
    );
  });

  app.post('/api/me/missions/:assignmentId/submit', { preHandler: mine }, async (req, reply) => {
    const b = g.body(reply, SubmitMissionRequestSchema, req.body ?? {});
    if (!b) return;
    const { assignmentId } = req.params as { assignmentId: string };
    return g.run(reply, async () => {
      const r = await submitMission(d.db, {
        participantId: req.me!.participantId,
        assignmentId,
        note: b.note,
        now: d.clock(),
      });
      // own stream only: a public delta here would let the display correlate it with a person
      if (r.xpAwarded)
        await broadcastParticipantState(d.hub, d.db, req.me!.eventId, req.me!.participantId);
      return SubmitMissionResponseSchema.parse(r);
    });
  });

  app.post('/api/me/missions/:assignmentId/reassign', { preHandler: mine }, async (req, reply) => {
    const { assignmentId } = req.params as { assignmentId: string };
    return g.run(reply, async () =>
      ReassignMissionResponseSchema.parse(
        await swapMission(d.db, { participantId: req.me!.participantId, assignmentId }),
      ),
    );
  });

  app.post('/api/events/:eventId/missions/assign', { preHandler: g.pre }, async (req, reply) => {
    const b = g.body(reply, AssignMissionsRequestSchema, req.body ?? {});
    if (!b) return;
    return g.run(reply, async () =>
      AssignMissionsResponseSchema.parse(
        await assignMissions(d.db, {
          eventId: g.eventParams(req),
          actor: req.org!.userId,
          perParticipant: b.perParticipant,
          now: d.clock(),
        }),
      ),
    );
  });

  app.get('/api/events/:eventId/missions', { preHandler: g.pre }, async (req, reply) =>
    g.run(reply, async () => {
      const r = await organizerMissions(d.db, g.eventParams(req));
      return OrganizerMissionsResponseSchema.parse({
        ...r,
        pending: r.pending.map((p) => ({ ...p, submittedAt: iso(p.submittedAt) })),
      });
    }),
  );

  app.post(
    '/api/events/:eventId/missions/:assignmentId',
    { preHandler: g.pre },
    async (req, reply) => {
      const b = g.body(reply, VerifyMissionRequestSchema, req.body);
      if (!b) return;
      const { assignmentId } = req.params as { assignmentId: string };
      return g.run(reply, async () => {
        const eventId = g.eventParams(req);
        const r = await decideMission(d.db, {
          eventId,
          assignmentId,
          action: b.action,
          actor: req.org!.userId,
          now: d.clock(),
        });
        return VerifyMissionResponseSchema.parse(r);
      });
    },
  );

  /* ================= mini-games ================= */

  app.get('/api/me/game', { preHandler: mine }, async (req) =>
    MyGameResponseSchema.parse(await myGameState(d.db, req.me!.participantId, d.clock())),
  );

  app.post('/api/me/game/answers', { preHandler: mine }, async (req, reply) => {
    const b = g.body(reply, SubmitAnswerRequestSchema, req.body);
    if (!b) return;
    return g.run(reply, async () => {
      const r = await submitAnswer(d.db, {
        participantId: req.me!.participantId,
        answerId: b.answerId,
        now: d.clock(),
      });
      broadcastSceneSoon(d.hub, d.db, req.me!.eventId); // "N answered" counter, coalesced
      return SubmitAnswerResponseSchema.parse(r);
    });
  });

  app.post('/api/me/game/bingo-marks', { preHandler: mine }, async (req, reply) => {
    const b = g.body(reply, BingoMarkRequestSchema, req.body);
    if (!b) return;
    return g.run(reply, async () =>
      BingoMarkResponseSchema.parse(
        await markBingo(d.db, {
          participantId: req.me!.participantId,
          cell: b.cell,
          now: d.clock(),
        }),
      ),
    );
  });

  app.get('/api/events/:eventId/games', { preHandler: g.pre }, async (req) =>
    OrganizerGamesResponseSchema.parse(await listGames(d.db, g.eventParams(req))),
  );

  app.post('/api/events/:eventId/games', { preHandler: g.pre }, async (req, reply) => {
    const b = g.body(reply, CreateGameRequestSchema, req.body);
    if (!b) return;
    return g.run(reply, async () => {
      const r = await createGame(d.db, {
        eventId: g.eventParams(req),
        actor: req.org!.userId,
        kind: b.kind,
        title: b.title,
        config: b.config,
        now: d.clock(),
      });
      reply.status(201);
      return r;
    });
  });

  app.post('/api/events/:eventId/games/:gameId', { preHandler: g.pre }, async (req, reply) => {
    const b = g.body(reply, GameActionRequestSchema, req.body);
    if (!b) return;
    const { gameId } = req.params as { gameId: string };
    return g.run(reply, async () => {
      const now = d.clock();
      const eventId = g.eventParams(req);
      const r = await gameAction(d.db, {
        eventId,
        gameId,
        action: b.action,
        actor: req.org!.userId,
        now,
      });
      await broadcastScene(d.hub, d.db, eventId);
      if (r.announcements.length) {
        await emitAnnouncements(d.hub, d.db, eventId, r.announcements, now);
      }
      if (r.game.status === 'results') await broadcastEventState(d.hub, d.db, eventId); // XP
      return GameActionResponseSchema.parse({
        gameId: r.game.id,
        status: r.game.status,
        roundIndex: r.game.roundIndex,
      });
    });
  });

  app.get(
    '/api/events/:eventId/games/:gameId/bingo-marks',
    { preHandler: g.pre },
    async (req, reply) => {
      const { gameId } = req.params as { gameId: string };
      return g.run(reply, async () =>
        BingoPendingResponseSchema.parse({
          marks: await pendingBingoMarks(d.db, g.eventParams(req), gameId),
        }),
      );
    },
  );

  app.post(
    '/api/events/:eventId/games/:gameId/bingo-marks/:markId',
    { preHandler: g.pre },
    async (req, reply) => {
      const b = g.body(reply, BingoDecisionRequestSchema, req.body);
      if (!b) return;
      const { gameId, markId } = req.params as { gameId: string; markId: string };
      return g.run(reply, async () => {
        const eventId = g.eventParams(req);
        const r = await decideBingoMark(d.db, {
          eventId,
          gameId,
          markId,
          action: b.action,
          actor: req.org!.userId,
          now: d.clock(),
        });
        broadcastSceneSoon(d.hub, d.db, eventId);
        return BingoDecisionResponseSchema.parse(r);
      });
    },
  );
}
