import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  DeleteMeResponseSchema,
  EventStatsSchema,
  GUEST_COOKIE_NAME,
  GiftTakedownResponseSchema,
  IntegrityDetailsSchema,
  IntegrityReportSchema,
  RemoveParticipantRequestSchema,
  RemoveParticipantResponseSchema,
  TakedownRequestSchema,
  TakedownResponseSchema,
  UNMASK_GRANT_HEADER,
} from '@santa/contracts';
import {
  anonymizeParticipant,
  eventStats,
  integrityDetails,
  integrityReport,
  isPlatformAdmin,
  removeParticipant,
  setEventSuspended,
  takedownGift,
  type Db,
} from '@santa/db';
import type { OrganizerSessions, PrincipalStore } from '../principal.js';
import type { RealtimeHub } from '../realtime/hub.js';
import { broadcastEventState, broadcastGifts } from '../realtime/broadcast.js';
import type { StorageAdapter } from '../storage/adapter.js';
import { fail, makeGuards, makeParticipantGuard } from './guards.js';

export interface AdminRouteDeps {
  db: Db;
  sessions: OrganizerSessions;
  principals: PrincipalStore;
  hub: RealtimeHub;
  storage: StorageAdapter;
  platformAdminEmails?: readonly string[];
  clock: () => Date;
}

export function registerAdminRoutes(app: FastifyInstance, d: AdminRouteDeps) {
  const g = makeGuards(d);
  const mine = makeParticipantGuard(d.db);

  /** Blob removal never blocks the request: a failed delete is left for the daily retention sweep. */
  const deleteBlobs = async (keys: Array<string | null>) => {
    for (const k of keys) if (k) await d.storage.delete(k).catch(() => undefined);
  };

  /* ================= organizer moderation ================= */

  app.post(
    '/api/events/:eventId/participants/:participantId/remove',
    { preHandler: g.pre },
    async (req, reply) => {
      const b = g.body(reply, RemoveParticipantRequestSchema, req.body ?? {});
      if (!b) return;
      const { participantId } = req.params as { participantId: string };
      return g.run(reply, async () => {
        const eventId = g.eventParams(req);
        const r = await removeParticipant(d.db, {
          eventId,
          actor: req.org!.userId,
          participantId,
          reason: b.reason,
          now: d.clock(),
        });
        d.hub.dropParticipant(participantId, 'revoked');
        await broadcastEventState(d.hub, d.db, eventId);
        await broadcastGifts(d.hub, d.db, eventId);
        return RemoveParticipantResponseSchema.parse({ ...r, status: 'removed' });
      });
    },
  );

  app.get('/api/events/:eventId/stats', { preHandler: g.pre }, async (req) =>
    EventStatsSchema.parse(await eventStats(d.db, g.eventParams(req), d.clock())),
  );

  app.get('/api/events/:eventId/integrity', { preHandler: g.pre }, async (req) =>
    IntegrityReportSchema.parse(await integrityReport(d.db, g.eventParams(req))),
  );

  /** Vote-level detail: only with an active unmask grant; the read itself is audited. */
  app.get('/api/events/:eventId/integrity/details', { preHandler: g.pre }, async (req, reply) => {
    const grant = req.headers[UNMASK_GRANT_HEADER];
    const ok =
      typeof grant === 'string' &&
      (await d.principals.grantActive(req.org!.userId, g.eventParams(req), grant, d.clock()));
    if (!ok) return fail(reply, 403, 'unmask_required', 'Active unmask grant required');
    const r = await integrityDetails(d.db, {
      eventId: g.eventParams(req),
      actor: req.org!.userId,
      now: d.clock(),
    });
    return IntegrityDetailsSchema.parse({
      items: r.items.map((i) => ({ ...i, at: i.at.toISOString() })),
    });
  });

  /* ================= delete-my-data ================= */

  app.delete('/api/me', { preHandler: mine }, async (req, reply) => {
    const r = await anonymizeParticipant(d.db, {
      participantId: req.me!.participantId,
      now: d.clock(),
    });
    await deleteBlobs(r.photoKeys);
    d.hub.dropParticipant(req.me!.participantId, 'revoked');
    await broadcastEventState(d.hub, d.db, r.eventId);
    await broadcastGifts(d.hub, d.db, r.eventId);
    reply.clearCookie(GUEST_COOKIE_NAME, { path: '/' });
    return DeleteMeResponseSchema.parse({ anonymized: true, erased: r.erased });
  });

  /* ================= platform admin ================= */

  const platformAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
    const s = await d.sessions.fromCookieHeader(req.headers.cookie);
    if (!s) return fail(reply, 401, 'unauthenticated', 'Sign in required');
    if (!(await isPlatformAdmin(d.db, s.userId, d.platformAdminEmails)))
      return fail(reply, 403, 'forbidden');
    req.org = s;
  };

  const suspend = (path: 'takedown' | 'restore') =>
    app.post(
      `/api/admin/events/:eventId/${path}`,
      { preHandler: platformAdmin },
      async (req, reply) => {
        const b = g.body(reply, TakedownRequestSchema, req.body);
        if (!b) return;
        return g.run(reply, async () => {
          const eventId = (req.params as { eventId: string }).eventId;
          const r = await setEventSuspended(d.db, {
            eventId,
            actor: req.org!.userId,
            suspended: path === 'takedown',
            reason: b.reason,
            now: d.clock(),
          });
          if (r.suspended) d.hub.dropEventAudience(eventId);
          return TakedownResponseSchema.parse(r);
        });
      },
    );
  suspend('takedown');
  suspend('restore');

  app.post('/api/admin/gifts/:giftId/takedown', { preHandler: platformAdmin }, async (req, reply) =>
    g.run(reply, async () => {
      const { giftId } = req.params as { giftId: string };
      const r = await takedownGift(d.db, { giftId, actor: req.org!.userId, now: d.clock() });
      await deleteBlobs([r.photoKey]);
      await broadcastGifts(d.hub, d.db, r.eventId);
      return GiftTakedownResponseSchema.parse({ giftId, removed: true });
    }),
  );
}
