import { eq } from 'drizzle-orm';
import { SpotlightSchema, type SpotlightKind, type SpotlightOutput } from '@santa/contracts';
import { PRESENT_PHASES, type PublishResult } from '@santa/domain';
import type { Db } from './types.js';
import * as s from './schema.js';
import { EventError } from './events.js';
import { writeAudit } from './audit.js';
import { unlockAchievement } from './achievements.js';
import { invisibleSantaResult, santaDetectiveResult } from './guess.js';
import { missionMasterResult } from './missions.js';
import { loadEventRow, publishedPeople } from './phase2.js';
import { assertNoOpenShowChoice } from './showChoiceGuard.js';
import type { CeremonyAnnouncement } from './ceremony.js';

interface StoredSpotlight {
  kind: SpotlightKind;
  result: PublishResult;
}

/** Spotlight achievement for each presentation (rank-1 entries only). */
const ACHIEVEMENT_FOR: Record<SpotlightKind, string> = {
  santa_detective: 'santa_detective',
  invisible_santa: 'invisible_santa',
  mission_master: 'mission_master',
};

/**
 * Computes the board through canPublish(), stores ONLY the policy result (ids + ranks, no totals) as the current
 * spotlight and unlocks the rank-1 achievements. A failing policy stores the neutral fallback and unlocks nothing.
 */
export async function presentSpotlight(
  db: Db,
  p: { eventId: string; kind: SpotlightKind; actor: string; now: Date },
): Promise<{
  published: boolean;
  reason: Extract<PublishResult, { ok: false }>['reason'] | null;
  announcements: CeremonyAnnouncement[];
}> {
  const e = await loadEventRow(db, p.eventId);
  if (!PRESENT_PHASES[p.kind].includes(e.phase)) throw new EventError('presentation_not_available');
  const result =
    p.kind === 'santa_detective'
      ? await santaDetectiveResult(db, e, p.now)
      : p.kind === 'invisible_santa'
        ? await invisibleSantaResult(db, e, p.now)
        : await missionMasterResult(db, e);
  const announcements: CeremonyAnnouncement[] = [];
  await db.transaction(async (tx) => {
    // same event lock as startShowChoice: a spotlight would take the screen from an open choice round
    await loadEventRow(tx, p.eventId, true);
    await assertNoOpenShowChoice(tx, p.eventId);
    const stored: StoredSpotlight = { kind: p.kind, result };
    await tx
      .insert(s.eventSpotlights)
      .values({
        eventId: p.eventId,
        kind: p.kind,
        data: stored as unknown as Record<string, unknown>,
        shownAt: p.now,
      })
      .onConflictDoUpdate({
        target: s.eventSpotlights.eventId,
        set: { kind: p.kind, data: stored as unknown as Record<string, unknown>, shownAt: p.now },
      });
    if (result.ok)
      for (const entry of result.entries.filter((x) => x.rank === 1)) {
        if (
          await unlockAchievement(tx, {
            eventId: p.eventId,
            participantId: entry.entryId,
            key: ACHIEVEMENT_FOR[p.kind],
            source: 'presentation',
            now: p.now,
          })
        )
          announcements.push({
            scope: 'pub',
            participantId: entry.entryId,
            key: ACHIEVEMENT_FOR[p.kind],
          });
      }
    await writeAudit(tx, {
      eventId: p.eventId,
      actor: p.actor,
      action: 'presentation.show',
      target: p.kind,
      data: { published: result.ok, reason: result.ok ? null : result.reason },
      at: p.now,
    });
  });
  return {
    published: result.ok,
    reason: result.ok ? null : result.reason,
    announcements,
  };
}

export async function hideSpotlight(db: Db, p: { eventId: string; actor: string; now: Date }) {
  await db.delete(s.eventSpotlights).where(eq(s.eventSpotlights.eventId, p.eventId));
  await writeAudit(db, {
    eventId: p.eventId,
    actor: p.actor,
    action: 'presentation.hide',
    at: p.now,
  });
}

/** Public payload of the current spotlight (names resolved now, so anonymisation applies). Null if none. */
export async function spotlightView(db: Db, eventId: string): Promise<SpotlightOutput | null> {
  const [row] = await db
    .select()
    .from(s.eventSpotlights)
    .where(eq(s.eventSpotlights.eventId, eventId));
  if (!row) return null;
  const stored = row.data as unknown as StoredSpotlight;
  const people = await publishedPeople(db, stored.result.ok ? stored.result : { ok: false });
  const parsed = SpotlightSchema.safeParse({
    kind: row.kind,
    ...people,
    at: row.shownAt.toISOString(),
  });
  return parsed.success ? parsed.data : null;
}
