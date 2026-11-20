import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ApproveParticipantResponseSchema,
  ClaimCodesResponseSchema,
  ClaimEmailLinksResponseSchema,
  ClaimRequestSchema,
  ClaimResponseSchema,
  CreateAccessRequestSchema,
  CreateAccessResponseSchema,
  DISPLAY_COOKIE_NAME,
  DisplayExchangeRequestSchema,
  GUEST_COOKIE_NAME,
  SHORT_CODE_LENGTH,
  JoinResolveRequestSchema,
  JoinResolveResponseSchema,
  MeResponseSchema,
  MuteParticipantRequestSchema,
  ParticipantEventStateSchema,
  ProfileUpdateRequestSchema,
  ReactionSettingsRequestSchema,
  OrganizerParticipantsResponseSchema,
} from '@santa/contracts';
import {
  EventError,
  approveParticipant,
  claimParticipant,
  consumeClaimToken,
  events,
  findParticipantBySession,
  insertAccess,
  issueClaimToken,
  joinInfo,
  listUnclaimed,
  resolveDisplayToken,
  resolveJoinTarget,
  revokeAccess,
  setReactionsMuted,
  listParticipantsMasked,
  updateEvent,
  updateProfile,
  type Db,
  type JoinTarget,
} from '@santa/db';
import { eq } from 'drizzle-orm';
import type { EmailTransport } from '../auth/email.js';
import type { OrganizerSessions, PrincipalStore } from '../principal.js';
import type { RealtimeHub } from '../realtime/hub.js';
import { broadcastEventState } from '../realtime/broadcast.js';
import { ShortCodeGuard, type ShortCodeGuardOptions } from '../http/shortcode-guard.js';
import { hashToken, newToken, parseCookies, randomCode } from '../tokens.js';
import { fail, makeGuards } from './guards.js';

export interface JoinRouteDeps {
  db: Db;
  sessions: OrganizerSessions;
  principals: PrincipalStore;
  hub: RealtimeHub;
  email: EmailTransport;
  baseUrl: string;
  secureCookies: boolean;
  /** Per-IP requests/minute on the public endpoints (resolve+display, claim). */
  limits?: { resolve: number; claim: number };
  /** Global short-code brute-force limits (defaults: 30 lookups/code/min, 100 failures/min overall). */
  shortCodeLimits?: ShortCodeGuardOptions;
  clock: () => Date;
}

const DAY = 24 * 3600_000;
const COOKIE_MAX_AGE = 60 * 60 * 24 * 14; // seconds

const publicLimit = (max: number) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });

export function registerJoinRoutes(app: FastifyInstance, d: JoinRouteDeps) {
  const g = makeGuards(d);

  const guard = new ShortCodeGuard(d.shortCodeLimits);
  /** Resolves a join target; short-code lookups are guarded globally (not per IP). */
  const lookup = async (t: { joinToken: string } | { shortCode: string }, now: Date) => {
    if ('shortCode' in t && !guard.allow(t.shortCode, now.getTime()))
      throw new EventError('rate_limited');
    const id = await resolveJoinTarget(d.db, targetOf(t), now);
    if (!id && 'shortCode' in t) guard.fail(now.getTime());
    return id;
  };

  const targetOf = (t: { joinToken: string } | { shortCode: string }): JoinTarget =>
    'joinToken' in t ? { tokenHash: hashToken(t.joinToken) } : { shortCode: t.shortCode };

  const secure = (req: FastifyRequest) => d.secureCookies || req.protocol === 'https';
  const roleCookieOptions = (req: FastifyRequest) => ({
    httpOnly: true,
    secure: secure(req),
    sameSite: 'lax' as const,
    path: '/',
  });
  const clearRoleCookie = (req: FastifyRequest, reply: FastifyReply, name: string) =>
    reply.clearCookie(name, roleCookieOptions(req));
  const setGuestCookie = (req: FastifyRequest, reply: FastifyReply, token: string) =>
    reply.setCookie(GUEST_COOKIE_NAME, token, {
      ...roleCookieOptions(req),
      maxAge: COOKIE_MAX_AGE,
    });

  /* ================= public join flow ================= */

  app.post('/api/join/resolve', publicLimit(d.limits?.resolve ?? 20), async (req, reply) => {
    const b = g.body(reply, JoinResolveRequestSchema, req.body);
    if (!b) return;
    const eventId = await lookup(b, d.clock()).catch((e: unknown) => {
      if (e instanceof EventError && e.code === 'rate_limited') return 'locked' as const;
      throw e;
    });
    if (eventId === 'locked') return fail(reply, 429, 'rate_limited');
    if (!eventId) return fail(reply, 404, 'invalid_claim'); // same answer for unknown/expired/revoked
    const info = await joinInfo(d.db, eventId, d.clock());
    return JoinResolveResponseSchema.parse({
      event: {
        name: info.name,
        startsAt: info.startsAt.toISOString(),
        defaultLocale: info.defaultLocale,
        joinOpen: info.joinOpen,
      },
      unclaimed: info.unclaimed,
    });
  });

  app.post('/api/join/claim', publicLimit(d.limits?.claim ?? 10), async (req, reply) => {
    const b = g.body(reply, ClaimRequestSchema, req.body);
    if (!b) return;
    const session = newToken();
    const sessionTokenHash = hashToken(session);
    const now = d.clock();
    return g.run(reply, async () => {
      let eventId: string;
      let participantId: string;
      let autoApprove = false;

      if (b.method === 'pick_name') {
        const e = await lookup(b.target, now);
        if (!e) return fail(reply, 401, 'invalid_claim');
        eventId = e;
        participantId = b.participantId;
        const [ev] = await d.db.select({ s: events.settings }).from(events).where(eq(events.id, e));
        autoApprove = !!ev?.s.features.autoApproveJoin;
      } else {
        const scope = b.method === 'personal_code' ? await lookup(b.target, now) : undefined;
        if (b.method === 'personal_code' && !scope) return fail(reply, 401, 'invalid_claim');
        const hit = await consumeClaimToken(d.db, {
          tokenHash: hashToken(b.method === 'email_link' ? b.token : b.code),
          method: b.method,
          now,
          ...(scope ? { eventId: scope } : {}),
        }).catch((e: unknown) => {
          if (e instanceof EventError) return null;
          throw e;
        });
        if (!hit) return fail(reply, 401, 'invalid_claim'); // wrong/used/expired: indistinguishable
        eventId = hit.eventId;
        participantId = hit.participantId;
      }

      const r = await claimParticipant(d.db, {
        eventId,
        participantId,
        method: b.method,
        sessionTokenHash,
        now,
        autoApprove,
      });
      if (r.replacedSession) d.hub.dropParticipant(participantId, 'session'); // old device is dead
      clearRoleCookie(req, reply, DISPLAY_COOKIE_NAME);
      setGuestCookie(req, reply, session);
      await broadcastEventState(d.hub, d.db, eventId);
      return ClaimResponseSchema.parse({
        status: r.status,
        participantId: r.participantId,
        verified: r.verified,
      });
    });
  });

  const myself = async (req: FastifyRequest) => {
    const token = parseCookies(req.headers.cookie)[GUEST_COOKIE_NAME];
    return token ? findParticipantBySession(d.db, hashToken(token)) : null;
  };

  app.get('/api/me', async (req, reply) => {
    const me = await myself(req);
    if (!me) return fail(reply, 401, 'unauthenticated');
    return MeResponseSchema.parse({
      participantId: me.id,
      eventId: me.eventId,
      displayName: me.displayName,
      avatar: me.avatar,
      status: me.status,
      verified: me.claimVerifiedAt !== null,
      locale: me.locale === 'it' ? 'it' : 'en',
    });
  });

  /** Strict participant projection for reload/bootstrap; never accepts display or organizer cookies. */
  app.get('/api/me/state', async (req, reply) => {
    const me = await myself(req);
    if (!me) return fail(reply, 401, 'unauthenticated');
    const token = parseCookies(req.headers.cookie)[GUEST_COOKIE_NAME]!;
    const data = await d.hub.snapshot(
      {
        kind: 'guest',
        eventId: me.eventId,
        participantId: me.id,
        sessionId: hashToken(token),
      },
      me.eventId,
      `p:${me.id}`,
    );
    return ParticipantEventStateSchema.parse(data['eventState']);
  });

  app.patch('/api/me/profile', async (req, reply) => {
    const me = await myself(req);
    if (!me || me.status !== 'active') return fail(reply, 401, 'unauthenticated');
    const b = g.body(reply, ProfileUpdateRequestSchema, req.body);
    if (!b) return;
    return g.run(reply, async () => {
      const u = await updateProfile(d.db, { participantId: me.id, patch: b });
      await broadcastEventState(d.hub, d.db, me.eventId);
      return MeResponseSchema.parse({
        participantId: u.id,
        eventId: u.eventId,
        displayName: u.displayName,
        avatar: u.avatar,
        status: u.status,
        verified: u.claimVerifiedAt !== null,
        locale: u.locale === 'it' ? 'it' : 'en',
      });
    });
  });

  /** Display token (from the organizer's display URL) -> HttpOnly cookie; the client then strips the URL token. */
  app.post('/api/join/display', publicLimit(d.limits?.resolve ?? 20), async (req, reply) => {
    const b = g.body(reply, DisplayExchangeRequestSchema, req.body);
    if (!b) return;
    const row = await resolveDisplayToken(d.db, hashToken(b.token), d.clock());
    if (!row) return fail(reply, 401, 'invalid_claim');
    const maxAge = row.expiresAt
      ? Math.max(1, Math.floor((row.expiresAt.getTime() - d.clock().getTime()) / 1000))
      : COOKIE_MAX_AGE;
    clearRoleCookie(req, reply, GUEST_COOKIE_NAME);
    reply.setCookie(DISPLAY_COOKIE_NAME, b.token, {
      ...roleCookieOptions(req),
      maxAge,
    });
    return { ok: true };
  });

  /* ================= organizer endpoints ================= */

  app.post('/api/events/:eventId/access', { preHandler: g.pre }, async (req, reply) => {
    const b = g.body(reply, CreateAccessRequestSchema, req.body);
    if (!b) return;
    const now = d.clock();
    const expiresAt = new Date(now.getTime() + b.expiresInHours * 3600_000);
    return g.run(reply, async () => {
      const token = newToken();
      let shortCode: string | null = null;
      let accessId: string | undefined;
      for (let attempt = 0; attempt < 5 && !accessId; attempt++) {
        shortCode = b.kind === 'join' ? randomCode(SHORT_CODE_LENGTH) : null;
        try {
          accessId = await insertAccess(d.db, {
            eventId: g.eventParams(req),
            actor: req.org!.userId,
            kind: b.kind,
            tokenHash: hashToken(token),
            shortCode,
            expiresAt,
            now,
          });
        } catch (e) {
          if (shortCode === null || attempt === 4) throw e; // short-code collision: retry
        }
      }
      return reply.status(201).send(
        CreateAccessResponseSchema.parse({
          accessId,
          kind: b.kind,
          token,
          shortCode,
          path: b.kind === 'join' ? `/j/${token}` : `/d/${token}`,
          expiresAt: expiresAt.toISOString(),
        }),
      );
    });
  });

  app.delete('/api/events/:eventId/access/:accessId', { preHandler: g.pre }, async (req, reply) => {
    const { accessId } = req.params as { accessId: string };
    return g.run(reply, async () => {
      const r = await revokeAccess(d.db, {
        eventId: g.eventParams(req),
        accessId,
        actor: req.org!.userId,
        now: d.clock(),
      });
      if (r.kind === 'display') d.hub.dropDisplays(g.eventParams(req));
      return { ok: true };
    });
  });

  /** One-time printable list of per-person codes (no pairings). Regenerating invalidates older codes. */
  app.post('/api/events/:eventId/claims/codes', { preHandler: g.pre }, async (req) => {
    const now = d.clock();
    const people = await listUnclaimed(d.db, g.eventParams(req));
    const codes: Array<{ participantId: string; displayName: string; code: string }> = [];
    for (const p of people) {
      const code = randomCode(10);
      await issueClaimToken(d.db, {
        participantId: p.id,
        method: 'personal_code',
        tokenHash: hashToken(code),
        expiresAt: new Date(now.getTime() + 30 * DAY),
        now,
      });
      codes.push({ participantId: p.id, displayName: p.displayName, code });
    }
    return ClaimCodesResponseSchema.parse({ codes });
  });

  app.post('/api/events/:eventId/claims/email-links', { preHandler: g.pre }, async (req) => {
    const now = d.clock();
    const people = (await listUnclaimed(d.db, g.eventParams(req))).filter((p) => p.email);
    let sent = 0;
    for (const p of people) {
      const token = newToken();
      await issueClaimToken(d.db, {
        participantId: p.id,
        method: 'email_link',
        tokenHash: hashToken(token),
        expiresAt: new Date(now.getTime() + 14 * DAY),
        now,
      });
      await d.email.send({
        to: p.email!,
        subject: 'Your Secret Santa Games link',
        text: `Hi ${p.displayName}, join here: ${d.baseUrl}/j/claim?token=${token}\n\nThis link works once and expires in 14 days.`,
      });
      sent++;
    }
    return ClaimEmailLinksResponseSchema.parse({ sent });
  });

  app.post(
    '/api/events/:eventId/participants/:participantId/approve',
    { preHandler: g.pre },
    async (req, reply) => {
      const { participantId } = req.params as { participantId: string };
      return g.run(reply, async () => {
        await approveParticipant(d.db, {
          eventId: g.eventParams(req),
          participantId,
          actor: req.org!.userId,
          now: d.clock(),
        });
        await broadcastEventState(d.hub, d.db, g.eventParams(req));
        return ApproveParticipantResponseSchema.parse({ participantId, status: 'active' });
      });
    },
  );

  /** Masked roster (names + status + mute flag) for the console. */
  app.get('/api/events/:eventId/participants', { preHandler: g.pre }, async (req) =>
    OrganizerParticipantsResponseSchema.parse({
      participants: await listParticipantsMasked(d.db, g.eventParams(req)),
    }),
  );

  /* ================= reactions: organizer controls ================= */

  app.post('/api/events/:eventId/reactions/settings', { preHandler: g.pre }, async (req, reply) => {
    const b = g.body(reply, ReactionSettingsRequestSchema, req.body);
    if (!b) return;
    return g.run(reply, async () => {
      await updateEvent(d.db, {
        eventId: g.eventParams(req),
        actor: req.org!.userId,
        now: d.clock(),
        patch: { settings: { features: { reactionsEnabled: b.enabled } } },
      });
      d.hub.reactions.invalidatePolicy(g.eventParams(req));
      await broadcastEventState(d.hub, d.db, g.eventParams(req)); // org state carries reactionsEnabled
      return { enabled: b.enabled };
    });
  });

  app.post(
    '/api/events/:eventId/participants/:participantId/mute',
    { preHandler: g.pre },
    async (req, reply) => {
      const b = g.body(reply, MuteParticipantRequestSchema, req.body);
      if (!b) return;
      const { participantId } = req.params as { participantId: string };
      return g.run(reply, async () => {
        await setReactionsMuted(d.db, {
          eventId: g.eventParams(req),
          participantId,
          muted: b.muted,
          actor: req.org!.userId,
          now: d.clock(),
        });
        d.hub.reactions.invalidatePolicy(g.eventParams(req));
        return { muted: b.muted };
      });
    },
  );
}
