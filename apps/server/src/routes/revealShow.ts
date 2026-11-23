import type { FastifyInstance } from 'fastify';
import {
  MyRevealShowResponseSchema,
  RevealShowStateSchema,
  ShowChoiceVoteRequestSchema,
  ShowChoiceVoteResponseSchema,
  TreeLightResponseSchema,
} from '@santa/contracts';
import {
  cancelShowChoice,
  lightTree,
  myRevealShow,
  revealShowState,
  startShowChoice,
  voteShowChoice,
  type Db,
} from '@santa/db';
import type { OrganizerSessions, PrincipalStore } from '../principal.js';
import type { RealtimeHub } from '../realtime/hub.js';
import { broadcastScene, broadcastSceneSoon } from '../realtime/phase2.js';
import { makeGuards, makeParticipantGuard } from './guards.js';

export interface RevealShowRouteDeps {
  db: Db;
  sessions: OrganizerSessions;
  principals: PrincipalStore;
  hub: RealtimeHub;
  clock: () => Date;
}

/**
 * Reveal-show extras. Participants: Light the Tree tap, Snowstorm vs Sleigh Bells vote, own selections.
 * Organizers: start / cancel a choice round, read the public state. Nobody (organizers included) gets tallies or
 * voter identities; the pub scene carries only `lights`, the latest round (outcome after close) and `effect`.
 */
export function registerRevealShowRoutes(app: FastifyInstance, d: RevealShowRouteDeps) {
  const g = makeGuards(d);
  const mine = makeParticipantGuard(d.db);
  const state = (eventId: string) =>
    revealShowState(d.db, eventId).then((s) => RevealShowStateSchema.parse(s));

  /* ---------------- participant ---------------- */

  app.get('/api/me/reveal/show', { preHandler: mine }, async (req) =>
    MyRevealShowResponseSchema.parse(
      await myRevealShow(d.db, req.me!.eventId, req.me!.participantId),
    ),
  );

  app.post('/api/me/reveal/gifts/:giftId/light', { preHandler: mine }, async (req, reply) => {
    const { giftId } = req.params as { giftId: string };
    return g.run(reply, async () => {
      const r = await lightTree(d.db, {
        eventId: req.me!.eventId,
        participantId: req.me!.participantId,
        giftId,
        now: d.clock(),
      });
      // coalesced (<= 1 scene push / s / event): a burst of taps never floods the display
      if (r.added) broadcastSceneSoon(d.hub, d.db, req.me!.eventId);
      return TreeLightResponseSchema.parse({ giftId, lit: true, lights: r.lights });
    });
  });

  app.post('/api/me/reveal/choice', { preHandler: mine }, async (req, reply) => {
    const b = g.body(reply, ShowChoiceVoteRequestSchema, req.body);
    if (!b) return;
    return g.run(reply, async () => {
      await voteShowChoice(d.db, {
        eventId: req.me!.eventId,
        participantId: req.me!.participantId,
        round: b.round,
        choice: b.choice,
        now: d.clock(),
      });
      // no scene push: nothing public changes while a round is open (no live tally)
      return ShowChoiceVoteResponseSchema.parse({ round: b.round, choice: b.choice });
    });
  });

  /* ---------------- organizer ---------------- */

  app.get('/api/events/:eventId/reveal/show', { preHandler: g.pre }, async (req) =>
    state(g.eventParams(req)),
  );

  app.post('/api/events/:eventId/reveal/choice', { preHandler: g.pre }, async (req, reply) =>
    g.run(reply, async () => {
      const eventId = g.eventParams(req);
      await startShowChoice(d.db, { eventId, actor: req.org!.userId, now: d.clock() });
      await broadcastScene(d.hub, d.db, eventId);
      return state(eventId);
    }),
  );

  app.post('/api/events/:eventId/reveal/choice/cancel', { preHandler: g.pre }, async (req, reply) =>
    g.run(reply, async () => {
      const eventId = g.eventParams(req);
      await cancelShowChoice(d.db, { eventId, actor: req.org!.userId, now: d.clock() });
      await broadcastScene(d.hub, d.db, eventId);
      return state(eventId);
    }),
  );
}
