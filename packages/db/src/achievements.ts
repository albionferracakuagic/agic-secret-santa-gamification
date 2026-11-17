import { and, eq } from 'drizzle-orm';
import { planAchievementAward } from '@santa/domain';
import type { Db } from './types.js';
import * as s from './schema.js';
import { awardXp } from './xp.js';

export const ACHIEVEMENT_XP = 50;

/** Idempotent (unique participant+key). Returns true iff newly unlocked. XP for it is non-qualifying. */
export async function unlockAchievement(
  db: Db,
  p: { eventId: string; participantId: string; key: string; source: string; now: Date },
): Promise<boolean> {
  const rows = await db
    .insert(s.participantAchievements)
    .values({
      eventId: p.eventId,
      participantId: p.participantId,
      key: p.key,
      source: p.source,
      unlockedAt: p.now,
      announcedAt: p.now,
    })
    .onConflictDoNothing({
      target: [s.participantAchievements.participantId, s.participantAchievements.key],
    })
    .returning({ id: s.participantAchievements.id });
  if (rows.length === 0) return false;
  await awardXp(db, {
    eventId: p.eventId,
    participantId: p.participantId,
    award: planAchievementAward(p.key, ACHIEVEMENT_XP),
  });
  return true;
}

export async function myAchievements(db: Db, participantId: string) {
  return db
    .select({
      key: s.participantAchievements.key,
      unlockedAt: s.participantAchievements.unlockedAt,
    })
    .from(s.participantAchievements)
    .where(eq(s.participantAchievements.participantId, participantId))
    .orderBy(s.participantAchievements.unlockedAt);
}

/** Public profile of another participant: name, avatar, unlocked achievements only (never XP, votes, pairings). */
export async function publicProfile(db: Db, eventId: string, participantId: string) {
  const [p] = await db
    .select({
      id: s.participants.id,
      displayName: s.participants.displayName,
      avatar: s.participants.avatar,
    })
    .from(s.participants)
    .where(and(eq(s.participants.id, participantId), eq(s.participants.eventId, eventId)));
  if (!p) return null;
  const rows = await db
    .select({ key: s.participantAchievements.key })
    .from(s.participantAchievements)
    .where(eq(s.participantAchievements.participantId, participantId));
  return {
    participantId: p.id,
    displayName: p.displayName,
    avatar: p.avatar,
    achievements: rows.map((r) => r.key),
  };
}
