import type { FastifyReply, FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { EventError, eventOrganizers, type Db } from '@santa/db';
import type { OrganizerSessions, PrincipalStore } from '../principal.js';

declare module 'fastify' {
  interface FastifyRequest {
    org?: { userId: string; sessionId: string };
  }
}

export interface GuardDeps {
  db: Db;
  sessions: OrganizerSessions;
  principals: PrincipalStore;
}

export const STATUS: Record<string, number> = {
  not_found: 404,
  user_not_found: 404,
  invalid_settings: 400,
  max_below_roster: 409,
  paused: 409,
  invalid_step: 409,
  same_phase: 409,
  pairing_not_ready: 409,
  backstep_after_reveal: 409,
  use_reopen_voting: 409,
  voting_not_closed: 409,
  import_locked: 409,
  import_not_allowed: 409,
  correction_closed: 409,
  already_claimed: 409,
  invalid_claim: 401,
  expired: 410,
  profile_locked: 409,
  name_taken: 409,
  over_capacity: 409,
  join_closed: 409,
  invalid_pairing: 400,
};

export const fail = (reply: FastifyReply, status: number, code: string, message = code) =>
  reply.status(status).send({ error: { code, message } });

/** Shared organizer-route guards: session, event membership, ownership, error mapping, body validation. */
export function makeGuards(d: GuardDeps) {
  const authed = async (req: FastifyRequest, reply: FastifyReply) => {
    const s = await d.sessions.fromCookieHeader(req.headers.cookie);
    if (!s) return fail(reply, 401, 'unauthenticated', 'Sign in required');
    req.org = s;
  };
  const eventParams = (req: FastifyRequest) => (req.params as { eventId: string }).eventId;

  /** Membership gate: non-members get 403 (never confirms the event exists). */
  const member = async (req: FastifyRequest, reply: FastifyReply) => {
    const ok = await d.principals.isOrganizerOf(req.org!.userId, eventParams(req));
    if (!ok) return fail(reply, 403, 'forbidden');
  };
  const owner = async (req: FastifyRequest, reply: FastifyReply) => {
    const [row] = await d.db
      .select({ role: eventOrganizers.role })
      .from(eventOrganizers)
      .where(
        and(
          eq(eventOrganizers.eventId, eventParams(req)),
          eq(eventOrganizers.userId, req.org!.userId),
        ),
      );
    if (row?.role !== 'owner') return fail(reply, 403, 'forbidden', 'Owner only');
  };

  const run = async (reply: FastifyReply, fn: () => Promise<unknown>) => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof EventError) return fail(reply, STATUS[e.code] ?? 400, e.code, e.message);
      throw e;
    }
  };

  const body = <T>(
    reply: FastifyReply,
    schema: { safeParse(v: unknown): { success: boolean; data?: T } },
    v: unknown,
  ) => {
    const r = schema.safeParse(v);
    if (!r.success) {
      void fail(reply, 400, 'bad_request');
      return undefined;
    }
    return r.data as T;
  };

  return { authed, member, owner, pre: [authed, member], run, body, eventParams };
}
