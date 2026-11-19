import type { FastifyInstance } from 'fastify';
import {
  holdAutopilot,
  resumeAutopilot,
  skipAutopilotStep,
  startAutopilot,
  stopAutopilot,
  updateAutopilotSettings,
  autopilotView,
  type Db,
} from '@santa/db';
import {
  AutopilotCommandSchema,
  AutopilotResponseSchema,
  AutopilotSettingsPatchSchema,
} from '@santa/contracts';
import type { OrganizerSessions, PrincipalStore } from '../principal.js';
import type { RealtimeHub } from '../realtime/hub.js';
import { broadcastAutopilot } from '../realtime/autopilot.js';
import { makeGuards } from './guards.js';

export interface AutopilotRouteDeps {
  db: Db;
  sessions: OrganizerSessions;
  principals: PrincipalStore;
  hub: RealtimeHub;
  clock: () => Date;
}

/** Show Autopilot — organizer only (never on display / participant surfaces). Audited in the db layer. */
export function registerAutopilotRoutes(app: FastifyInstance, d: AutopilotRouteDeps) {
  const g = makeGuards(d);
  const view = async (eventId: string) => AutopilotResponseSchema.parse(await autopilotView(d.db, eventId));

  app.get('/api/events/:eventId/autopilot', { preHandler: g.pre }, async (req) =>
    view(g.eventParams(req)),
  );

  app.post('/api/events/:eventId/autopilot', { preHandler: g.pre }, async (req, reply) => {
    const b = g.body(reply, AutopilotCommandSchema, req.body);
    if (!b) return;
    return g.run(reply, async () => {
      const eventId = g.eventParams(req);
      const p = { eventId, actor: req.org!.userId, now: d.clock(), fromSeq: b.fromSeq };
      const cmd = {
        start: startAutopilot,
        hold: holdAutopilot,
        resume: resumeAutopilot,
        stop: stopAutopilot,
        skip: skipAutopilotStep,
      }[b.action];
      await cmd(d.db, p);
      await broadcastAutopilot(d.hub, d.db, eventId);
      return view(eventId);
    });
  });

  app.patch('/api/events/:eventId/autopilot', { preHandler: g.pre }, async (req, reply) => {
    const b = g.body(reply, AutopilotSettingsPatchSchema, req.body);
    if (!b) return;
    return g.run(reply, async () => {
      const eventId = g.eventParams(req);
      await updateAutopilotSettings(d.db, {
        eventId,
        actor: req.org!.userId,
        patch: b,
        now: d.clock(),
      });
      await broadcastAutopilot(d.hub, d.db, eventId);
      return view(eventId);
    });
  });
}
