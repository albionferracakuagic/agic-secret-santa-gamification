import { and, count, eq, inArray, isNull, ne } from 'drizzle-orm';
import {
  DEFAULT_CATEGORIES,
  EventSettingsSchema,
  type EventSettings,
  type Phase,
} from '@santa/contracts';
import { transition, type Milestones, type TransitionError } from '@santa/domain';
import type { Db } from './types.js';
import * as s from './schema.js';
import { writeAudit } from './audit.js';
import { cancelJobs } from './jobs.js';

export class EventError extends Error {
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message);
  }
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlain(v) && isPlain(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

/** Strict parse: unknown keys and values below the privacy floors are rejected (ADR-0003). */
export function mergeSettings(current: EventSettings, patch: Record<string, unknown> | undefined) {
  const parsed = EventSettingsSchema.safeParse(deepMerge(current, patch ?? {}));
  if (!parsed.success)
    throw new EventError(
      'invalid_settings',
      parsed.error.issues.map((i) => i.path.join('.')).join(', '),
    );
  return parsed.data;
}

export interface CreateEventInput {
  name: string;
  startsAt: string;
  timezone: string;
  defaultLocale: 'en' | 'it';
  description?: string | null | undefined;
  theme?: string | undefined;
  budgetText?: string | null | undefined;
  maxParticipants?: number | undefined;
  settings?: Record<string, unknown> | undefined;
}

export type UpdateEventInput = { [K in keyof CreateEventInput]?: CreateEventInput[K] | undefined };

export async function createEvent(
  db: Db,
  p: { ownerId: string; input: CreateEventInput; now: Date },
) {
  const { input } = p;
  const settings = mergeSettings(EventSettingsSchema.parse({}), input.settings);
  return db.transaction(async (tx) => {
    const [e] = await tx
      .insert(s.events)
      .values({
        ownerId: p.ownerId,
        name: input.name,
        startsAt: new Date(input.startsAt),
        timezone: input.timezone,
        description: input.description ?? null,
        theme: input.theme ?? 'classic',
        budgetText: input.budgetText ?? null,
        maxParticipants: input.maxParticipants ?? 100,
        settings,
        defaultLocale: input.defaultLocale,
        createdAt: p.now,
        updatedAt: p.now,
      })
      .returning();
    const eventId = e!.id;
    await tx.insert(s.eventOrganizers).values({ eventId, userId: p.ownerId, role: 'owner' });
    await tx.insert(s.votingCategories).values(
      DEFAULT_CATEGORIES.map((c, i) => ({
        eventId,
        key: c.key,
        name: { ...c.name },
        sort: i,
        boardEnabled: false,
      })),
    );
    await writeAudit(tx, { eventId, actor: p.ownerId, action: 'event.create', at: p.now });
    return e!;
  });
}

export async function updateEvent(
  db: Db,
  p: { eventId: string; actor: string; now: Date; patch: UpdateEventInput },
) {
  return db.transaction(async (tx) => {
    const [e] = await tx.select().from(s.events).where(eq(s.events.id, p.eventId)).for('update');
    if (!e) throw new EventError('not_found');
    const { patch } = p;
    if (patch.maxParticipants !== undefined) {
      const [{ n } = { n: 0 }] = await tx
        .select({ n: count() })
        .from(s.participants)
        .where(and(eq(s.participants.eventId, p.eventId), ne(s.participants.status, 'removed')));
      if (patch.maxParticipants < n) throw new EventError('max_below_roster');
    }
    const settings = patch.settings ? mergeSettings(e.settings, patch.settings) : e.settings;
    const [u] = await tx
      .update(s.events)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.startsAt !== undefined ? { startsAt: new Date(patch.startsAt) } : {}),
        ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.theme !== undefined ? { theme: patch.theme } : {}),
        ...(patch.budgetText !== undefined ? { budgetText: patch.budgetText } : {}),
        ...(patch.maxParticipants !== undefined ? { maxParticipants: patch.maxParticipants } : {}),
        settings,
        updatedAt: p.now,
      })
      .where(eq(s.events.id, p.eventId))
      .returning();
    await writeAudit(tx, { eventId: p.eventId, actor: p.actor, action: 'event.update', at: p.now });
    return u!;
  });
}

export async function listEventsForUser(db: Db, userId: string) {
  return db
    .select({
      id: s.events.id,
      name: s.events.name,
      startsAt: s.events.startsAt,
      phase: s.events.phase,
      role: s.eventOrganizers.role,
    })
    .from(s.eventOrganizers)
    .innerJoin(s.events, eq(s.events.id, s.eventOrganizers.eventId))
    .where(eq(s.eventOrganizers.userId, userId))
    .orderBy(s.events.startsAt);
}

const toMilestones = (e: typeof s.events.$inferSelect): Milestones => ({
  giftOpeningStartedAt: e.giftOpeningStartedAt,
  votingClosedAt: e.votingClosedAt,
  revealStartedAt: e.revealStartedAt,
  ceremonyStartedAt: e.ceremonyStartedAt,
});

export async function changePhase(
  db: Db,
  p: { eventId: string; actor: string; to: Phase; now: Date; reason?: string | undefined },
): Promise<{ phase: Phase }> {
  return db.transaction(async (tx) => {
    const [e] = await tx.select().from(s.events).where(eq(s.events.id, p.eventId)).for('update');
    if (!e) throw new EventError('not_found');
    const [ready] = await tx
      .select({ id: s.pairingImports.id })
      .from(s.pairingImports)
      .where(and(eq(s.pairingImports.eventId, p.eventId), eq(s.pairingImports.status, 'ready')))
      .limit(1);
    const t = transition({ phase: e.phase, paused: e.paused, milestones: toMilestones(e) }, p.to, {
      now: p.now,
      pairingReady: !!ready,
    });
    if (!t.ok) throw new EventError(t.error satisfies TransitionError);
    const m = t.patch.milestones;
    await tx
      .update(s.events)
      .set({
        phase: t.patch.phase,
        ...(m.giftOpeningStartedAt ? { giftOpeningStartedAt: m.giftOpeningStartedAt } : {}),
        ...(m.votingClosedAt ? { votingClosedAt: m.votingClosedAt } : {}),
        ...(m.revealStartedAt ? { revealStartedAt: m.revealStartedAt } : {}),
        ...(m.ceremonyStartedAt ? { ceremonyStartedAt: m.ceremonyStartedAt } : {}),
        ...(t.patch.phase === 'completed' ? { completedAt: p.now } : { completedAt: null }),
        updatedAt: p.now,
      })
      .where(eq(s.events.id, p.eventId));
    await writeAudit(tx, {
      eventId: p.eventId,
      actor: p.actor,
      action: t.audit,
      target: `${e.phase}->${p.to}`,
      reason: p.reason ?? null,
      at: p.now,
    });
    return { phase: t.patch.phase };
  });
}

export async function setPaused(
  db: Db,
  p: { eventId: string; actor: string; paused: boolean; now: Date },
) {
  const rows = await db
    .update(s.events)
    .set({ paused: p.paused, updatedAt: p.now })
    .where(eq(s.events.id, p.eventId))
    .returning({ id: s.events.id });
  if (!rows.length) throw new EventError('not_found');
  await writeAudit(db, {
    eventId: p.eventId,
    actor: p.actor,
    action: p.paused ? 'event.pause' : 'event.resume',
    at: p.now,
  });
}

const VOTING_JOB_KINDS = ['voting.autoclose', 'board.publish', 'ceremony.step'];

/** Explicit tx: invalidate locked awards, bump votingRound, cancel pending jobs, audit. Blocked after reveal. */
export async function reopenVoting(
  db: Db,
  p: { eventId: string; actor: string; reason: string; now: Date },
): Promise<{ votingRound: number }> {
  return db.transaction(async (tx) => {
    const [e] = await tx.select().from(s.events).where(eq(s.events.id, p.eventId)).for('update');
    if (!e) throw new EventError('not_found');
    if (e.revealStartedAt) throw new EventError('backstep_after_reveal');
    const closed = e.phase === 'games' || (e.phase === 'voting' && e.votingClosedAt !== null);
    if (!closed) throw new EventError('voting_not_closed');
    const votingRound = e.votingRound + 1;
    await tx
      .update(s.events)
      .set({ phase: 'voting', votingClosedAt: null, votingRound, updatedAt: p.now })
      .where(eq(s.events.id, p.eventId));
    await tx
      .update(s.awards)
      .set({ invalidatedAt: p.now, publishable: false })
      .where(
        and(
          eq(s.awards.eventId, p.eventId),
          eq(s.awards.votingRound, e.votingRound),
          isNull(s.awards.invalidatedAt),
        ),
      );
    await cancelJobs(tx, p.eventId, VOTING_JOB_KINDS);
    await writeAudit(tx, {
      eventId: p.eventId,
      actor: p.actor,
      action: 'voting.reopen',
      reason: p.reason,
      data: { fromRound: e.votingRound, toRound: votingRound },
      at: p.now,
    });
    return { votingRound };
  });
}

export async function addCoOrganizer(
  db: Db,
  p: { eventId: string; actor: string; email: string; now: Date },
) {
  const [u] = await db
    .select({ id: s.user.id })
    .from(s.user)
    .where(eq(s.user.email, p.email.toLowerCase()));
  if (!u) throw new EventError('user_not_found');
  await db
    .insert(s.eventOrganizers)
    .values({ eventId: p.eventId, userId: u.id, role: 'co' })
    .onConflictDoNothing();
  await writeAudit(db, {
    eventId: p.eventId,
    actor: p.actor,
    action: 'organizer.add',
    target: u.id,
    at: p.now,
  });
  return u.id;
}

export async function removeCoOrganizer(
  db: Db,
  p: { eventId: string; actor: string; userId: string; now: Date },
) {
  const rows = await db
    .delete(s.eventOrganizers)
    .where(
      and(
        eq(s.eventOrganizers.eventId, p.eventId),
        eq(s.eventOrganizers.userId, p.userId),
        inArray(s.eventOrganizers.role, ['co']),
      ),
    )
    .returning({ userId: s.eventOrganizers.userId });
  if (!rows.length) throw new EventError('not_found');
  await writeAudit(db, {
    eventId: p.eventId,
    actor: p.actor,
    action: 'organizer.remove',
    target: p.userId,
    at: p.now,
  });
}
