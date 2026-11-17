import { and, eq, gt, inArray, isNull, ne, or } from 'drizzle-orm';
import { isActivityAllowed, normalizeName, planAward } from '@santa/domain';
import type { Db } from './types.js';
import * as s from './schema.js';
import { writeAudit } from './audit.js';
import { awardXp } from './xp.js';
import { EventError } from './events.js';

/* ---------- access tokens (join link / short code / display) ---------- */

export async function insertAccess(
  db: Db,
  p: {
    eventId: string;
    actor: string;
    kind: 'join' | 'display';
    tokenHash: string;
    shortCode: string | null;
    expiresAt: Date;
    now: Date;
  },
) {
  const [row] = await db
    .insert(s.eventAccess)
    .values({
      eventId: p.eventId,
      kind: p.kind,
      tokenHash: p.tokenHash,
      shortCode: p.shortCode,
      expiresAt: p.expiresAt,
      createdAt: p.now,
    })
    .returning({ id: s.eventAccess.id });
  await writeAudit(db, {
    eventId: p.eventId,
    actor: p.actor,
    action: `access.create.${p.kind}`,
    target: row!.id,
    at: p.now,
  });
  return row!.id;
}

export async function revokeAccess(
  db: Db,
  p: { eventId: string; accessId: string; actor: string; now: Date },
) {
  const rows = await db
    .update(s.eventAccess)
    .set({ revokedAt: p.now })
    .where(
      and(
        eq(s.eventAccess.id, p.accessId),
        eq(s.eventAccess.eventId, p.eventId),
        isNull(s.eventAccess.revokedAt),
      ),
    )
    .returning({ kind: s.eventAccess.kind, tokenHash: s.eventAccess.tokenHash });
  if (!rows.length) throw new EventError('not_found');
  await writeAudit(db, {
    eventId: p.eventId,
    actor: p.actor,
    action: 'access.revoke',
    target: p.accessId,
    at: p.now,
  });
  return rows[0]!;
}

export type JoinTarget = { tokenHash: string } | { shortCode: string };

/** Active (not revoked, not expired) join access -> event id. */
export async function resolveJoinTarget(db: Db, t: JoinTarget, now: Date): Promise<string | null> {
  const [row] = await db
    .select({ eventId: s.eventAccess.eventId })
    .from(s.eventAccess)
    .innerJoin(s.events, and(eq(s.events.id, s.eventAccess.eventId), isNull(s.events.suspendedAt)))
    .where(
      and(
        eq(s.eventAccess.kind, 'join'),
        'tokenHash' in t
          ? eq(s.eventAccess.tokenHash, t.tokenHash)
          : eq(s.eventAccess.shortCode, t.shortCode),
        isNull(s.eventAccess.revokedAt),
        or(isNull(s.eventAccess.expiresAt), gt(s.eventAccess.expiresAt, now)),
      ),
    );
  return row?.eventId ?? null;
}

export async function resolveDisplayToken(db: Db, tokenHash: string, now: Date) {
  const [row] = await db
    .select({ eventId: s.eventAccess.eventId, expiresAt: s.eventAccess.expiresAt })
    .from(s.eventAccess)
    .innerJoin(s.events, and(eq(s.events.id, s.eventAccess.eventId), isNull(s.events.suspendedAt)))
    .where(
      and(
        eq(s.eventAccess.kind, 'display'),
        eq(s.eventAccess.tokenHash, tokenHash),
        isNull(s.eventAccess.revokedAt),
        or(isNull(s.eventAccess.expiresAt), gt(s.eventAccess.expiresAt, now)),
      ),
    );
  return row ?? null;
}

/* ---------- join page data ---------- */

export async function joinInfo(db: Db, eventId: string, now: Date) {
  const [e] = await db.select().from(s.events).where(eq(s.events.id, eventId));
  if (!e) throw new EventError('not_found');
  const unclaimed = await db
    .select({ participantId: s.participants.id, displayName: s.participants.displayName })
    .from(s.participants)
    .where(and(eq(s.participants.eventId, eventId), eq(s.participants.status, 'unclaimed')))
    .orderBy(s.participants.displayName);
  return {
    name: e.name,
    startsAt: e.startsAt,
    defaultLocale: e.defaultLocale === 'it' ? ('it' as const) : ('en' as const),
    joinOpen: isActivityAllowed(stateOf(e), 'join'),
    unclaimed,
    now,
  };
}

const stateOf = (e: typeof s.events.$inferSelect) => ({
  phase: e.phase,
  paused: e.paused,
  milestones: {
    giftOpeningStartedAt: e.giftOpeningStartedAt,
    votingClosedAt: e.votingClosedAt,
    revealStartedAt: e.revealStartedAt,
    ceremonyStartedAt: e.ceremonyStartedAt,
  },
});

/* ---------- personal claim credentials ---------- */

/** Replaces earlier unused credentials of the same method for this participant. */
export async function issueClaimToken(
  db: Db,
  p: {
    participantId: string;
    method: 'email_link' | 'personal_code';
    tokenHash: string;
    expiresAt: Date;
    now: Date;
  },
) {
  await db.transaction(async (tx) => {
    await tx
      .delete(s.claimTokens)
      .where(
        and(
          eq(s.claimTokens.participantId, p.participantId),
          eq(s.claimTokens.method, p.method),
          isNull(s.claimTokens.usedAt),
        ),
      );
    await tx.insert(s.claimTokens).values({
      participantId: p.participantId,
      method: p.method,
      tokenHash: p.tokenHash,
      expiresAt: p.expiresAt,
      createdAt: p.now,
    });
  });
}

/** Atomic single use: exactly one caller can consume a credential. Optional event scope. */
export async function consumeClaimToken(
  db: Db,
  p: { tokenHash: string; method: 'email_link' | 'personal_code'; now: Date; eventId?: string },
): Promise<{ participantId: string; eventId: string } | null> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(s.claimTokens)
      .set({ usedAt: p.now })
      .where(
        and(
          eq(s.claimTokens.tokenHash, p.tokenHash),
          eq(s.claimTokens.method, p.method),
          isNull(s.claimTokens.usedAt),
          gt(s.claimTokens.expiresAt, p.now),
        ),
      )
      .returning({ participantId: s.claimTokens.participantId });
    const hit = rows[0];
    if (!hit) return null;
    const [person] = await tx
      .select({ eventId: s.participants.eventId })
      .from(s.participants)
      .where(eq(s.participants.id, hit.participantId));
    if (!person || (p.eventId && person.eventId !== p.eventId)) {
      throw new EventError('invalid_claim'); // rolls back: credential stays unused for its own event
    }
    return { participantId: hit.participantId, eventId: person.eventId };
  });
}

/* ---------- claims ---------- */

export type ClaimMethod = 'email_link' | 'personal_code' | 'pick_name';

export interface ClaimResult {
  status: 'active' | 'pending';
  participantId: string;
  verified: boolean;
  /** true when an earlier session of this roster entry was replaced (caller drops its sockets). */
  replacedSession: boolean;
}

/**
 * Atomic claim (row lock): one active claim per roster entry.
 * - verified methods (email_link/personal_code) activate the entry and may RE-claim an active/pending one
 *   (new device / recovery): the old session token is replaced => old session dead.
 * - pick_name only works on `unclaimed` entries: pending until approval (or active, unverified, with auto-approve).
 */
export async function claimParticipant(
  db: Db,
  p: {
    eventId: string;
    participantId: string;
    method: ClaimMethod;
    sessionTokenHash: string;
    now: Date;
    autoApprove?: boolean;
  },
): Promise<ClaimResult> {
  return db.transaction(async (tx) => {
    const [e] = await tx.select().from(s.events).where(eq(s.events.id, p.eventId));
    if (!e) throw new EventError('not_found');
    if (e.phase === 'completed') throw new EventError('join_closed');
    const verified = p.method !== 'pick_name';
    if (!verified && !isActivityAllowed(stateOf(e), 'join')) throw new EventError('join_closed');

    const [row] = await tx
      .select()
      .from(s.participants)
      .where(and(eq(s.participants.id, p.participantId), eq(s.participants.eventId, p.eventId)))
      .for('update');
    if (!row || row.status === 'removed') throw new EventError('not_found');
    if (!verified && row.status !== 'unclaimed') throw new EventError('already_claimed');

    const status: 'active' | 'pending' = verified || p.autoApprove ? 'active' : 'pending';
    await tx
      .update(s.participants)
      .set({
        status,
        sessionTokenHash: p.sessionTokenHash,
        claimMethod: p.method === 'pick_name' ? 'organizer_approved' : p.method,
        claimVerifiedAt: verified ? p.now : null,
      })
      .where(eq(s.participants.id, p.participantId));

    if (status === 'active') {
      await awardXp(tx, {
        eventId: p.eventId,
        participantId: p.participantId,
        award: planAward('joined', e.settings.xpValues),
      });
    }
    await writeAudit(tx, {
      eventId: p.eventId,
      actor: `participant:${p.participantId}`,
      action: row.sessionTokenHash ? 'claim.reclaim' : 'claim.create',
      target: p.method,
      at: p.now,
    });
    return {
      status,
      participantId: p.participantId,
      verified,
      replacedSession: !!row.sessionTokenHash,
    };
  });
}

/** Organizer in-person approval: pending -> active + verified, XP joined. */
export async function approveParticipant(
  db: Db,
  p: { eventId: string; participantId: string; actor: string; now: Date },
) {
  await db.transaction(async (tx) => {
    const [e] = await tx.select().from(s.events).where(eq(s.events.id, p.eventId));
    if (!e) throw new EventError('not_found');
    const rows = await tx
      .update(s.participants)
      .set({ status: 'active', claimMethod: 'organizer_approved', claimVerifiedAt: p.now })
      .where(
        and(
          eq(s.participants.id, p.participantId),
          eq(s.participants.eventId, p.eventId),
          inArray(s.participants.status, ['pending', 'active']),
        ),
      )
      .returning({ id: s.participants.id });
    if (!rows.length) throw new EventError('not_found');
    await awardXp(tx, {
      eventId: p.eventId,
      participantId: p.participantId,
      award: planAward('joined', e.settings.xpValues),
    });
    await writeAudit(tx, {
      eventId: p.eventId,
      actor: p.actor,
      action: 'claim.approve',
      target: p.participantId,
      at: p.now,
    });
  });
}

/* ---------- own profile ---------- */

export async function findParticipantBySession(db: Db, sessionTokenHash: string) {
  const [row] = await db
    .select({ p: s.participants })
    .from(s.participants)
    .innerJoin(s.events, and(eq(s.events.id, s.participants.eventId), isNull(s.events.suspendedAt)))
    .where(
      and(
        eq(s.participants.sessionTokenHash, sessionTokenHash),
        ne(s.participants.status, 'removed'),
      ),
    );
  return row?.p ?? null;
}

export async function updateProfile(
  db: Db,
  p: {
    participantId: string;
    patch: {
      displayName?: string | undefined;
      avatar?: string | null | undefined;
      locale?: 'en' | 'it' | undefined;
    };
  },
) {
  return db.transaction(async (tx) => {
    const [me] = await tx
      .select()
      .from(s.participants)
      .where(eq(s.participants.id, p.participantId))
      .for('update');
    if (!me || me.status !== 'active') throw new EventError('not_found');
    const [e] = await tx.select().from(s.events).where(eq(s.events.id, me.eventId));
    if (!e || !isActivityAllowed(stateOf(e), 'profile_edit'))
      throw new EventError('profile_locked');
    if (p.patch.displayName !== undefined) {
      const others = await tx
        .select({ id: s.participants.id, displayName: s.participants.displayName })
        .from(s.participants)
        .where(
          and(
            eq(s.participants.eventId, me.eventId),
            ne(s.participants.status, 'removed'),
            ne(s.participants.id, me.id),
          ),
        );
      const wanted = normalizeName(p.patch.displayName);
      if (others.some((o) => normalizeName(o.displayName) === wanted))
        throw new EventError('name_taken');
    }
    const [u] = await tx
      .update(s.participants)
      .set({
        ...(p.patch.displayName !== undefined ? { displayName: p.patch.displayName } : {}),
        ...(p.patch.avatar !== undefined ? { avatar: p.patch.avatar } : {}),
        ...(p.patch.locale !== undefined ? { locale: p.patch.locale } : {}),
      })
      .where(eq(s.participants.id, me.id))
      .returning();
    return u!;
  });
}

/** Unclaimed roster entries (for personal codes / email links). */
export async function listUnclaimed(db: Db, eventId: string) {
  return db
    .select({
      id: s.participants.id,
      displayName: s.participants.displayName,
      email: s.participants.email,
    })
    .from(s.participants)
    .where(and(eq(s.participants.eventId, eventId), eq(s.participants.status, 'unclaimed')));
}

/** Masked roster for the organizer console: names + status + mute flag only. */
export async function listParticipantsMasked(db: Db, eventId: string) {
  return db
    .select({
      participantId: s.participants.id,
      displayName: s.participants.displayName,
      status: s.participants.status,
      reactionsMuted: s.participants.reactionsMuted,
    })
    .from(s.participants)
    .where(and(eq(s.participants.eventId, eventId), ne(s.participants.status, 'removed')))
    .orderBy(s.participants.displayName);
}

export async function setReactionsMuted(
  db: Db,
  p: { eventId: string; participantId: string; muted: boolean; actor: string; now: Date },
) {
  const rows = await db
    .update(s.participants)
    .set({ reactionsMuted: p.muted })
    .where(and(eq(s.participants.id, p.participantId), eq(s.participants.eventId, p.eventId)))
    .returning({ id: s.participants.id });
  if (!rows.length) throw new EventError('not_found');
  await writeAudit(db, {
    eventId: p.eventId,
    actor: p.actor,
    action: p.muted ? 'reactions.mute' : 'reactions.unmute',
    target: p.participantId,
    at: p.now,
  });
}
