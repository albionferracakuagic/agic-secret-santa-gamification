import { and, count, desc, eq, inArray, ne } from 'drizzle-orm';
import { isActivityAllowed, type PairingValidation, type PersonRef } from '@santa/domain';
import type { Db } from './types.js';
import * as s from './schema.js';
import { writeAudit } from './audit.js';
import { EventError } from './events.js';

export interface RecordImportInput {
  eventId: string;
  actor: string;
  now: Date;
  fileName: string | null;
  fileSize: number;
  mapping: Record<string, string>;
  validation: PairingValidation;
}

/**
 * Stores an import record and, only when consistent (no errors), applies it: new roster entries (unclaimed)
 * + pairings, replacing earlier pairings. The raw file is never persisted; the record keeps counts and
 * row-numbered issue codes only. Re-import is blocked forever once gift opening started.
 */
export async function recordPairingImport(
  db: Db,
  p: RecordImportInput,
): Promise<{ importId: string; status: 'draft' | 'ready' }> {
  return db.transaction(async (tx) => {
    const [e] = await tx.select().from(s.events).where(eq(s.events.id, p.eventId)).for('update');
    if (!e) throw new EventError('not_found');
    if (e.giftOpeningStartedAt) throw new EventError('import_locked');
    const allowed = isActivityAllowed(
      {
        phase: e.phase,
        paused: e.paused,
        milestones: {
          giftOpeningStartedAt: e.giftOpeningStartedAt,
          votingClosedAt: e.votingClosedAt,
          revealStartedAt: e.revealStartedAt,
          ceremonyStartedAt: e.ceremonyStartedAt,
        },
      },
      'pairing_import',
    );
    if (!allowed) throw new EventError('import_not_allowed');

    const { validation: v } = p;
    const status = v.summary.errors > 0 ? 'draft' : 'ready';
    const [imp] = await tx
      .insert(s.pairingImports)
      .values({
        eventId: p.eventId,
        fileName: p.fileName,
        fileSize: p.fileSize,
        columnMapping: p.mapping,
        issueSummary: { summary: v.summary, issues: v.issues } as unknown as Record<string, number>,
        status,
        createdBy: p.actor,
        createdAt: p.now,
      })
      .returning({ id: s.pairingImports.id });
    const importId = imp!.id;

    if (status === 'ready') {
      const [{ n } = { n: 0 }] = await tx
        .select({ n: count() })
        .from(s.participants)
        .where(and(eq(s.participants.eventId, p.eventId), ne(s.participants.status, 'removed')));
      if (n + v.newEntries.length > e.maxParticipants) throw new EventError('over_capacity');

      const ids = new Map<string, string>();
      if (v.newEntries.length) {
        const created = await tx
          .insert(s.participants)
          .values(
            v.newEntries.map((n2) => ({
              eventId: p.eventId,
              displayName: n2.displayName,
              email: n2.email,
              status: 'unclaimed' as const,
              source: 'import' as const,
            })),
          )
          .returning({ id: s.participants.id });
        created.forEach((c, i) => ids.set(v.newEntries[i]!.key, c.id));
      }
      const idOf = (r: PersonRef) => (r.kind === 'existing' ? r.id : ids.get(r.key)!);

      await tx.delete(s.pairings).where(eq(s.pairings.eventId, p.eventId));
      if (v.pairs.length) {
        await tx.insert(s.pairings).values(
          v.pairs.map((pr) => ({
            eventId: p.eventId,
            giverId: idOf(pr.giver),
            recipientId: idOf(pr.recipient),
            source: 'import' as const,
            importId,
          })),
        );
      }
    }

    await writeAudit(tx, {
      eventId: p.eventId,
      actor: p.actor,
      action: 'pairing.import',
      target: importId,
      data: { status, ...v.summary },
      at: p.now,
    });
    return { importId, status };
  });
}

export async function latestPairingImport(db: Db, eventId: string) {
  const [imp] = await db
    .select()
    .from(s.pairingImports)
    .where(eq(s.pairingImports.eventId, eventId))
    .orderBy(desc(s.pairingImports.createdAt))
    .limit(1);
  const [e] = await db
    .select({ giftOpeningStartedAt: s.events.giftOpeningStartedAt })
    .from(s.events)
    .where(eq(s.events.id, eventId));
  return { import: imp ?? null, reimportAllowed: !!e && !e.giftOpeningStartedAt };
}

/**
 * Audited correction (caller already verified an active unmask grant). Allowed until voting closes.
 * Updates the giver's pairing and drops votes that became invalid (voter is the giver of the voted gift).
 */
export async function correctPairing(
  db: Db,
  p: { eventId: string; actor: string; giverId: string; recipientId: string; now: Date },
): Promise<{ invalidatedVotes: number }> {
  return db.transaction(async (tx) => {
    const [e] = await tx.select().from(s.events).where(eq(s.events.id, p.eventId)).for('update');
    if (!e) throw new EventError('not_found');
    if (e.votingClosedAt || e.revealStartedAt) throw new EventError('correction_closed');
    if (p.giverId === p.recipientId) throw new EventError('invalid_pairing');
    const people = await tx
      .select({ id: s.participants.id })
      .from(s.participants)
      .where(
        and(
          eq(s.participants.eventId, p.eventId),
          ne(s.participants.status, 'removed'),
          inArray(s.participants.id, [p.giverId, p.recipientId]),
        ),
      );
    if (people.length !== 2) throw new EventError('not_found');

    await tx
      .insert(s.pairings)
      .values({
        eventId: p.eventId,
        giverId: p.giverId,
        recipientId: p.recipientId,
        source: 'manual',
      })
      .onConflictDoUpdate({
        target: [s.pairings.eventId, s.pairings.giverId],
        set: { recipientId: p.recipientId, source: 'manual', importId: null },
      });

    const bad = await tx
      .select({ categoryId: s.votes.categoryId, voterId: s.votes.voterId })
      .from(s.votes)
      .innerJoin(s.gifts, eq(s.gifts.id, s.votes.giftId))
      .where(and(eq(s.votes.eventId, p.eventId), eq(s.votes.voterId, s.gifts.giverId)));
    for (const b of bad) {
      await tx
        .delete(s.votes)
        .where(and(eq(s.votes.categoryId, b.categoryId), eq(s.votes.voterId, b.voterId)));
    }
    await writeAudit(tx, {
      eventId: p.eventId,
      actor: p.actor,
      action: 'pairing.correct',
      data: { invalidatedVotes: bad.length },
      at: p.now,
    });
    return { invalidatedVotes: bad.length };
  });
}
