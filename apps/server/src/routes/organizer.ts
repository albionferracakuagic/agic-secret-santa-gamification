import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  AddOrganizerRequestSchema,
  AuditListResponseSchema,
  CreateEventRequestSchema,
  PauseRequestSchema,
  PhaseChangeRequestSchema,
  ReopenVotingRequestSchema,
  UNMASK_GRANT_HEADER,
  UnmaskGrantResponseSchema,
  UnmaskRequestSchema,
  UpdateEventRequestSchema,
  type GuardEnv,
} from '@santa/contracts';
import {
  addCoOrganizer,
  changePhase,
  finalizeEvent,
  createEvent,
  createUnmaskGrant,
  listAudit,
  listEventsForUser,
  loadPairingsUnmasked,
  removeCoOrganizer,
  reopenVoting,
  revokeUnmaskGrant,
  setPaused,
  updateEvent,
  type Db,
} from '@santa/db';
import type { OrganizerSessions, PrincipalStore } from '../principal.js';
import type { RealtimeHub } from '../realtime/hub.js';
import { broadcastEventState } from '../realtime/broadcast.js';
import { fail, makeGuards } from './guards.js';

export interface OrganizerRouteDeps {
  db: Db;
  sessions: OrganizerSessions;
  principals: PrincipalStore;
  hub: RealtimeHub;
  guardEnv: GuardEnv;
  clock: () => Date;
}

export function registerOrganizerRoutes(app: FastifyInstance, d: OrganizerRouteDeps) {
  const { authed, member, owner, pre, run, body, eventParams } = makeGuards(d);

  /* ---------- events ---------- */
  app.post('/api/events', { preHandler: authed }, async (req, reply) => {
    const input = body(reply, CreateEventRequestSchema, req.body);
    if (!input) return;
    return run(reply, async () => {
      const e = await createEvent(d.db, { ownerId: req.org!.userId, input, now: d.clock() });
      return reply.status(201).send({ id: e.id });
    });
  });

  app.get('/api/events', { preHandler: authed }, async (req) => ({
    events: (await listEventsForUser(d.db, req.org!.userId)).map((e) => ({
      id: e.id,
      name: e.name,
      startsAt: e.startsAt.toISOString(),
      phase: e.phase,
      role: e.role,
    })),
  }));

  app.patch('/api/events/:eventId', { preHandler: pre }, async (req, reply) => {
    const patch = body(reply, UpdateEventRequestSchema, req.body);
    if (!patch) return;
    return run(reply, async () => {
      await updateEvent(d.db, {
        eventId: eventParams(req),
        actor: req.org!.userId,
        now: d.clock(),
        patch,
      });
      await broadcastEventState(d.hub, d.db, eventParams(req));
      return { ok: true };
    });
  });

  app.post('/api/events/:eventId/phase', { preHandler: pre }, async (req, reply) => {
    const b = body(reply, PhaseChangeRequestSchema, req.body);
    if (!b) return;
    return run(reply, async () => {
      const r = await changePhase(d.db, {
        eventId: eventParams(req),
        actor: req.org!.userId,
        to: b.to,
        reason: b.reason,
        now: d.clock(),
      });
      await broadcastEventState(d.hub, d.db, eventParams(req));
      if (r.phase === 'completed') {
        // lifetime titles + history archive; rebuilt lazily on read if this fails
        await finalizeEvent(d.db, eventParams(req), d.clock()).catch(() => undefined);
      }
      return r;
    });
  });

  app.post('/api/events/:eventId/pause', { preHandler: pre }, async (req, reply) => {
    const b = body(reply, PauseRequestSchema, req.body);
    if (!b) return;
    return run(reply, async () => {
      await setPaused(d.db, {
        eventId: eventParams(req),
        actor: req.org!.userId,
        paused: b.paused,
        now: d.clock(),
      });
      await broadcastEventState(d.hub, d.db, eventParams(req));
      return { paused: b.paused };
    });
  });

  app.post('/api/events/:eventId/reopen-voting', { preHandler: pre }, async (req, reply) => {
    const b = body(reply, ReopenVotingRequestSchema, req.body);
    if (!b) return;
    return run(reply, async () => {
      const r = await reopenVoting(d.db, {
        eventId: eventParams(req),
        actor: req.org!.userId,
        reason: b.reason,
        now: d.clock(),
      });
      await broadcastEventState(d.hub, d.db, eventParams(req));
      return r;
    });
  });

  /* ---------- co-organizers (owner only) ---------- */
  app.post(
    '/api/events/:eventId/organizers',
    { preHandler: [authed, member, owner] },
    async (req, reply) => {
      const b = body(reply, AddOrganizerRequestSchema, req.body);
      if (!b) return;
      return run(reply, async () => {
        const userId = await addCoOrganizer(d.db, {
          eventId: eventParams(req),
          actor: req.org!.userId,
          email: b.email,
          now: d.clock(),
        });
        return reply.status(201).send({ userId });
      });
    },
  );

  app.delete(
    '/api/events/:eventId/organizers/:userId',
    { preHandler: [authed, member, owner] },
    async (req, reply) => {
      const { userId } = req.params as { userId: string };
      return run(reply, async () => {
        await removeCoOrganizer(d.db, {
          eventId: eventParams(req),
          actor: req.org!.userId,
          userId,
          now: d.clock(),
        });
        d.hub.dropOrganizer(eventParams(req), userId); // membership removal => forced disconnect
        return { ok: true };
      });
    },
  );

  /* ---------- masked / unmasked organizer state ---------- */
  const activeGrant = async (req: FastifyRequest): Promise<string | null> => {
    const g = req.headers[UNMASK_GRANT_HEADER];
    if (typeof g !== 'string') return null;
    return (await d.principals.grantActive(req.org!.userId, eventParams(req), g, d.clock()))
      ? g
      : null;
  };

  app.get('/api/events/:eventId/organizer-state', { preHandler: pre }, async (req, reply) => {
    const principal = {
      kind: 'organizer' as const,
      userId: req.org!.userId,
      sessionId: req.org!.sessionId,
    };
    const grantId = await activeGrant(req);
    if (req.headers[UNMASK_GRANT_HEADER] && !grantId) return fail(reply, 403, 'unmask_required');
    const role = grantId ? 'organizer_unmasked' : 'organizer_masked';
    const data = await d.hub.snapshot(
      principal,
      eventParams(req),
      grantId ? `grant:${grantId}` : 'org',
    );
    return { role, ...data };
  });

  /** FR-046.9: secret data only with an active grant; everyone else gets 403. */
  app.get('/api/events/:eventId/pairings', { preHandler: pre }, async (req, reply) => {
    const grantId = await activeGrant(req);
    if (!grantId) return fail(reply, 403, 'unmask_required', 'Active unmask grant required');
    return {
      pairings: await loadPairingsUnmasked(d.db, eventParams(req), req.org!.userId, grantId),
    };
  });

  /* ---------- unmask grants + audit ---------- */
  app.post('/api/events/:eventId/unmask', { preHandler: pre }, async (req, reply) => {
    const b = body(reply, UnmaskRequestSchema, req.body);
    if (!b) return;
    const g = await createUnmaskGrant(d.db, {
      eventId: eventParams(req),
      userId: req.org!.userId,
      reason: b.reason,
      now: d.clock(),
    });
    return reply.status(201).send(
      UnmaskGrantResponseSchema.parse({
        grantId: g.grantId,
        expiresAt: g.expiresAt.toISOString(),
        banner: true,
      }),
    );
  });

  app.post(
    '/api/events/:eventId/unmask/:grantId/revoke',
    { preHandler: pre },
    async (req, reply) => {
      const { grantId } = req.params as { grantId: string };
      const ok = await revokeUnmaskGrant(d.db, {
        eventId: eventParams(req),
        grantId,
        userId: req.org!.userId,
        now: d.clock(),
      });
      if (!ok) return fail(reply, 404, 'not_found');
      d.hub.revokeGrant(grantId, 'revoked');
      return { ok: true };
    },
  );

  app.get('/api/events/:eventId/audit', { preHandler: pre }, async (req) => {
    const rows = await listAudit(d.db, eventParams(req), { limit: 100 });
    return AuditListResponseSchema.parse({
      entries: rows.map((r) => ({ ...r, at: r.at.toISOString() })),
    });
  });
}
