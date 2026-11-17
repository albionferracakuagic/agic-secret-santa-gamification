import type { FastifyInstance } from 'fastify';
import {
  AwardDecisionRequestSchema,
  AwardDecisionResponseSchema,
  BoardActionRequestSchema,
  BoardActionResponseSchema,
  CeremonyNextRequestSchema,
  MyAchievementsResponseSchema,
  OrganizerBoardsResponseSchema,
  OrganizerCeremonyStateSchema,
  ProfileSchema,
} from '@santa/contracts';
import {
  advanceCeremony,
  boardAction,
  cancelCeremony,
  decideAward,
  events,
  listBoards,
  myAchievements,
  organizerCeremonyState,
  pauseCeremony,
  publicProfile,
  restartCeremony,
  resumeCeremony,
  startCeremony,
  type Db,
} from '@santa/db';
import { eq } from 'drizzle-orm';
import type { OrganizerSessions, PrincipalStore } from '../principal.js';
import type { RealtimeHub } from '../realtime/hub.js';
import { broadcastBoards } from '../realtime/broadcast.js';
import { emitCeremony } from '../realtime/ceremonyEvents.js';
import { fail, makeGuards, makeParticipantGuard } from './guards.js';

export interface ShowRouteDeps {
  db: Db;
  sessions: OrganizerSessions;
  principals: PrincipalStore;
  hub: RealtimeHub;
  clock: () => Date;
}

export function registerShowRoutes(app: FastifyInstance, d: ShowRouteDeps) {
  const g = makeGuards(d);
  const mine = makeParticipantGuard(d.db);

  /* ================= live boards (organizer, masked) ================= */

  app.get('/api/events/:eventId/boards', { preHandler: g.pre }, async (req) => {
    const eventId = g.eventParams(req);
    const [e] = await d.db.select().from(events).where(eq(events.id, eventId));
    const boards = await listBoards(d.db, eventId);
    return OrganizerBoardsResponseSchema.parse({
      boards: boards.map((b) => ({
        ...b,
        lastPublishedAt: b.lastPublishedAt?.toISOString() ?? null,
      })),
      cadenceSeconds: e?.settings.cadenceSeconds ?? 10,
    });
  });

  app.post('/api/events/:eventId/boards/:boardKey', { preHandler: g.pre }, async (req, reply) => {
    const b = g.body(reply, BoardActionRequestSchema, req.body);
    if (!b) return;
    const { boardKey } = req.params as { boardKey: string };
    return g.run(reply, async () => {
      const r = await boardAction(d.db, {
        eventId: g.eventParams(req),
        actor: req.org!.userId,
        boardKey,
        action: b.action,
        acknowledgeSmallCohort: b.acknowledgeSmallCohort,
        now: d.clock(),
      });
      await broadcastBoards(d.hub, d.db, g.eventParams(req));
      return BoardActionResponseSchema.parse(r);
    });
  });

  /* ================= award ceremony (organizer remote) ================= */

  const ceremonyState = (eventId: string) =>
    organizerCeremonyState(d.db, eventId).then((s) => OrganizerCeremonyStateSchema.parse(s));

  app.get('/api/events/:eventId/ceremony', { preHandler: g.pre }, async (req) =>
    ceremonyState(g.eventParams(req)),
  );

  const act = (
    path: string,
    fn: (p: { eventId: string; actor: string; now: Date }) => Promise<{
      announcements?: readonly {
        scope: 'pub' | 'participant';
        participantId: string;
        key: string;
      }[];
      done?: boolean;
    } | void>,
  ) =>
    app.post(`/api/events/:eventId/ceremony/${path}`, { preHandler: g.pre }, async (req, reply) =>
      g.run(reply, async () => {
        const now = d.clock();
        const eventId = g.eventParams(req);
        const r = await fn({ eventId, actor: req.org!.userId, now });
        await emitCeremony(d.hub, d.db, eventId, r?.announcements ?? [], now, {
          boards: r?.done === true,
        });
        return ceremonyState(eventId);
      }),
    );

  act('start', (p) => startCeremony(d.db, p));
  act('restart', (p) => restartCeremony(d.db, p));
  act('pause', (p) => pauseCeremony(d.db, p));
  act('resume', (p) => resumeCeremony(d.db, p));
  act('cancel', (p) => cancelCeremony(d.db, p));

  /** `fromIndex` makes a double-click harmless: the second request gets 409 stale_step. */
  app.post('/api/events/:eventId/ceremony/next', { preHandler: g.pre }, async (req, reply) => {
    const b = g.body(reply, CeremonyNextRequestSchema, req.body);
    if (!b) return;
    return g.run(reply, async () => {
      const now = d.clock();
      const eventId = g.eventParams(req);
      const r = await advanceCeremony(d.db, {
        eventId,
        actor: req.org!.userId,
        fromIndex: b.fromIndex,
        now,
      });
      await emitCeremony(d.hub, d.db, eventId, r.announcements, now, { boards: r.done });
      return ceremonyState(eventId);
    });
  });

  app.post(
    '/api/events/:eventId/awards/:boardKey/decide',
    { preHandler: g.pre },
    async (req, reply) => {
      const b = g.body(reply, AwardDecisionRequestSchema, req.body);
      if (!b) return;
      const { boardKey } = req.params as { boardKey: string };
      return g.run(reply, async () =>
        AwardDecisionResponseSchema.parse(
          await decideAward(d.db, {
            eventId: g.eventParams(req),
            actor: req.org!.userId,
            boardKey,
            giftId: b.giftId,
            now: d.clock(),
          }),
        ),
      );
    },
  );

  /* ================= achievements (participant) ================= */

  app.get('/api/me/achievements', { preHandler: mine }, async (req) =>
    MyAchievementsResponseSchema.parse({
      achievements: (await myAchievements(d.db, req.me!.participantId)).map((a) => ({
        key: a.key,
        unlockedAt: a.unlockedAt.toISOString(),
      })),
    }),
  );

  /** Another participant's public profile: name, avatar, achievements. Never XP, votes or pairings. */
  app.get('/api/profiles/:participantId', { preHandler: mine }, async (req, reply) => {
    const { participantId } = req.params as { participantId: string };
    const p = await publicProfile(d.db, req.me!.eventId, participantId);
    if (!p) return fail(reply, 404, 'not_found');
    return ProfileSchema.parse(p);
  });
}
