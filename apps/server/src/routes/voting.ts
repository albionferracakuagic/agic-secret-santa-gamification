import type { FastifyInstance } from 'fastify';
import {
  CastVoteRequestSchema,
  CastVoteResponseSchema,
  CloseVotingResponseSchema,
  OpenVotingRequestSchema,
  OwnVotesResponseSchema,
  VotingStateSchema,
} from '@santa/contracts';
import {
  castVote,
  closeVoting,
  events,
  listVotingCategories,
  loadPublishedVotedCount,
  openVoting,
  ownVotes,
  type Db,
} from '@santa/db';
import { eq } from 'drizzle-orm';
import type { OrganizerSessions, PrincipalStore } from '../principal.js';
import type { RealtimeHub } from '../realtime/hub.js';
import { broadcastEventState } from '../realtime/broadcast.js';
import { makeGuards, makeParticipantGuard } from './guards.js';

export interface VotingRouteDeps {
  db: Db;
  sessions: OrganizerSessions;
  principals: PrincipalStore;
  hub: RealtimeHub;
  clock: () => Date;
}

export async function votingState(db: Db, eventId: string, now: Date) {
  const [e] = await db.select().from(events).where(eq(events.id, eventId));
  const closed =
    !!e && (e.votingClosedAt !== null || (e.votingEndsAt !== null && now >= e.votingEndsAt));
  const status =
    !e ||
    e.phase === 'preparation' ||
    e.phase === 'registration' ||
    e.phase === 'gift_registration' ||
    e.phase === 'gift_opening'
      ? 'not_open'
      : e.phase === 'voting' && !closed
        ? 'open'
        : 'closed';
  return VotingStateSchema.parse({
    status,
    endsAt: e?.votingEndsAt?.toISOString() ?? null,
    votedCount: await loadPublishedVotedCount(db, eventId), // published (cadence) value, never live
    categories: await listVotingCategories(db, eventId),
  });
}

export function registerVotingRoutes(app: FastifyInstance, d: VotingRouteDeps) {
  const g = makeGuards(d);
  const mine = makeParticipantGuard(d.db);

  /* ================= organizer ================= */

  app.post('/api/events/:eventId/voting/open', { preHandler: g.pre }, async (req, reply) => {
    const b = g.body(reply, OpenVotingRequestSchema, req.body ?? {});
    if (!b) return;
    return g.run(reply, async () => {
      await openVoting(d.db, {
        eventId: g.eventParams(req),
        actor: req.org!.userId,
        durationMinutes: b.durationMinutes,
        now: d.clock(),
      });
      await broadcastEventState(d.hub, d.db, g.eventParams(req));
      return votingState(d.db, g.eventParams(req), d.clock());
    });
  });

  app.post('/api/events/:eventId/voting/close', { preHandler: g.pre }, async (req, reply) =>
    g.run(reply, async () => {
      const r = await closeVoting(d.db, {
        eventId: g.eventParams(req),
        actor: req.org!.userId,
        now: d.clock(),
      });
      if (!r.alreadyClosed) await broadcastEventState(d.hub, d.db, g.eventParams(req));
      return CloseVotingResponseSchema.parse({
        closedAt: r.closedAt.toISOString(),
        categoriesLocked: r.categoriesLocked,
        categoriesPublishable: r.categoriesPublishable,
      });
    }),
  );

  /* ================= participant ================= */

  app.get('/api/me/voting', { preHandler: mine }, async (req) =>
    votingState(d.db, req.me!.eventId, d.clock()),
  );

  /** Upsert: one active selection per category. Repeating the same request is harmless (idempotent). */
  app.post('/api/me/votes', { preHandler: mine }, async (req, reply) => {
    const b = g.body(reply, CastVoteRequestSchema, req.body);
    if (!b) return;
    return g.run(reply, async () => {
      const r = await castVote(d.db, {
        participantId: req.me!.participantId,
        categoryId: b.categoryId,
        giftId: b.giftId,
        now: d.clock(),
      });
      return CastVoteResponseSchema.parse(r); // only the caller's own selection; no tallies
    });
  });

  app.get('/api/me/votes', { preHandler: mine }, async (req) =>
    OwnVotesResponseSchema.parse({ votes: await ownVotes(d.db, req.me!.participantId) }),
  );
}
