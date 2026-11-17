import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db } from './types.js';
import * as s from './schema.js';
import { EventError } from './events.js';
import { writeAudit } from './audit.js';
import { unlockAchievement } from './achievements.js';
import type { CeremonyAnnouncement } from './ceremony.js';
import { loadEventRow, type EventRow } from './phase2.js';

/** Categories can be edited until voting opens: afterwards the ballot (and canPublish inputs) are frozen. */
const EDITABLE_PHASES = ['preparation', 'registration', 'gift_registration', 'gift_opening'] as const;
const categoriesEditable = (e: EventRow) => (EDITABLE_PHASES as readonly string[]).includes(e.phase);

const assertEditable = (e: EventRow) => {
  if (!categoriesEditable(e)) throw new EventError('categories_locked');
};

/* ---------- custom categories ---------- */

export async function organizerCategories(db: Db, eventId: string) {
  const e = await loadEventRow(db, eventId);
  const rows = await db
    .select()
    .from(s.votingCategories)
    .where(eq(s.votingCategories.eventId, eventId))
    .orderBy(asc(s.votingCategories.sort));
  return {
    editable: categoriesEditable(e),
    categories: rows.map((c) => ({
      categoryId: c.id,
      key: c.key,
      name: c.name,
      description: c.description,
      enabled: c.enabled,
      sort: c.sort,
      custom: c.custom,
    })),
  };
}

export async function createCategory(
  db: Db,
  p: { eventId: string; actor: string; key: string; name: Record<string, string>; description?: Record<string, string> | undefined; now: Date },
) {
  return db.transaction(async (tx) => {
    const e = await loadEventRow(tx, p.eventId, true);
    assertEditable(e);
    const rows = await tx.select().from(s.votingCategories).where(eq(s.votingCategories.eventId, e.id));
    if (rows.some((r) => r.key === p.key)) throw new EventError('duplicate_key');
    const [row] = await tx
      .insert(s.votingCategories)
      .values({
        eventId: e.id,
        key: p.key,
        name: p.name,
        description: p.description ?? null,
        custom: true,
        sort: Math.max(0, ...rows.map((r) => r.sort)) + 1,
      })
      .returning();
    await writeAudit(tx, { eventId: e.id, actor: p.actor, action: 'category.create', target: p.key, at: p.now });
    return row!;
  });
}

export async function updateCategory(
  db: Db,
  p: {
    eventId: string;
    categoryId: string;
    actor: string;
    patch: { name?: Record<string, string> | undefined; description?: Record<string, string> | null | undefined; enabled?: boolean | undefined; sort?: number | undefined };
    now: Date;
  },
) {
  return db.transaction(async (tx) => {
    const e = await loadEventRow(tx, p.eventId, true);
    assertEditable(e);
    const [c] = await tx
      .select()
      .from(s.votingCategories)
      .where(and(eq(s.votingCategories.id, p.categoryId), eq(s.votingCategories.eventId, e.id)));
    if (!c) throw new EventError('not_found');
    if (p.patch.enabled === false && c.key === e.settings.grandChampionBoard) throw new EventError('category_in_use');
    const [row] = await tx
      .update(s.votingCategories)
      .set({
        ...(p.patch.name ? { name: p.patch.name } : {}),
        ...(p.patch.description !== undefined ? { description: p.patch.description } : {}),
        ...(p.patch.enabled !== undefined ? { enabled: p.patch.enabled } : {}),
        ...(p.patch.sort !== undefined ? { sort: p.patch.sort } : {}),
      })
      .where(eq(s.votingCategories.id, c.id))
      .returning();
    await writeAudit(tx, { eventId: e.id, actor: p.actor, action: 'category.update', target: c.key, at: p.now });
    return row!;
  });
}

export async function deleteCategory(db: Db, p: { eventId: string; categoryId: string; actor: string; now: Date }) {
  await db.transaction(async (tx) => {
    const e = await loadEventRow(tx, p.eventId, true);
    assertEditable(e);
    const [c] = await tx
      .select()
      .from(s.votingCategories)
      .where(and(eq(s.votingCategories.id, p.categoryId), eq(s.votingCategories.eventId, e.id)));
    if (!c) throw new EventError('not_found');
    const [used] = await tx
      .select({ id: s.customAchievements.id })
      .from(s.customAchievements)
      .where(and(eq(s.customAchievements.eventId, e.id), eq(s.customAchievements.categoryKey, c.key)));
    if (!c.custom || used) throw new EventError('category_in_use');
    await tx.delete(s.votingCategories).where(eq(s.votingCategories.id, c.id));
    await writeAudit(tx, { eventId: e.id, actor: p.actor, action: 'category.delete', target: c.key, at: p.now });
  });
}

/* ---------- custom achievements ---------- */

const view = (a: typeof s.customAchievements.$inferSelect) => ({
  achievementId: a.id,
  key: a.key,
  name: a.name,
  description: a.description,
  categoryKey: a.categoryKey,
});

export async function listCustomAchievements(db: Db, eventId: string) {
  return (
    await db.select().from(s.customAchievements).where(eq(s.customAchievements.eventId, eventId)).orderBy(asc(s.customAchievements.createdAt))
  ).map(view);
}

export async function createCustomAchievement(
  db: Db,
  p: { eventId: string; actor: string; key: string; name: Record<string, string>; description: Record<string, string>; categoryKey?: string | undefined; now: Date },
) {
  return db.transaction(async (tx) => {
    const e = await loadEventRow(tx, p.eventId, true);
    if (e.phase === 'completed') throw new EventError('categories_locked');
    const dup = await tx
      .select({ id: s.customAchievements.id })
      .from(s.customAchievements)
      .where(and(eq(s.customAchievements.eventId, e.id), eq(s.customAchievements.key, p.key)));
    if (dup.length) throw new EventError('duplicate_key');
    if (p.categoryKey) {
      // only custom categories can carry a custom winner achievement (built-ins have fixed ones)
      const [cat] = await tx
        .select()
        .from(s.votingCategories)
        .where(and(eq(s.votingCategories.eventId, e.id), eq(s.votingCategories.key, p.categoryKey)));
      if (!cat || !cat.custom) throw new EventError('invalid_category');
      const [taken] = await tx
        .select({ id: s.customAchievements.id })
        .from(s.customAchievements)
        .where(and(eq(s.customAchievements.eventId, e.id), eq(s.customAchievements.categoryKey, p.categoryKey)));
      if (taken) throw new EventError('duplicate_key');
      if (e.phase === 'voting' || e.phase === 'reveal' || e.phase === 'awards') throw new EventError('categories_locked');
    }
    const [row] = await tx
      .insert(s.customAchievements)
      .values({ eventId: e.id, key: p.key, name: p.name, description: p.description, categoryKey: p.categoryKey ?? null, createdAt: p.now })
      .returning();
    await writeAudit(tx, { eventId: e.id, actor: p.actor, action: 'achievement.create', target: p.key, at: p.now });
    return view(row!);
  });
}

export async function updateCustomAchievement(
  db: Db,
  p: { eventId: string; achievementId: string; actor: string; patch: { name?: Record<string, string> | undefined; description?: Record<string, string> | undefined }; now: Date },
) {
  const [row] = await db
    .update(s.customAchievements)
    .set({ ...(p.patch.name ? { name: p.patch.name } : {}), ...(p.patch.description ? { description: p.patch.description } : {}) })
    .where(and(eq(s.customAchievements.id, p.achievementId), eq(s.customAchievements.eventId, p.eventId)))
    .returning();
  if (!row) throw new EventError('not_found');
  await writeAudit(db, { eventId: p.eventId, actor: p.actor, action: 'achievement.update', target: row.key, at: p.now });
  return view(row);
}

export async function deleteCustomAchievement(db: Db, p: { eventId: string; achievementId: string; actor: string; now: Date }) {
  await db.transaction(async (tx) => {
    const [a] = await tx
      .select()
      .from(s.customAchievements)
      .where(and(eq(s.customAchievements.id, p.achievementId), eq(s.customAchievements.eventId, p.eventId)))
      .for('update');
    if (!a) throw new EventError('not_found');
    const [held] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(s.participantAchievements)
      .where(and(eq(s.participantAchievements.eventId, p.eventId), eq(s.participantAchievements.key, a.key)));
    if (Number(held?.n ?? 0) > 0) throw new EventError('category_in_use'); // already earned: keep the title
    await tx.delete(s.customAchievements).where(eq(s.customAchievements.id, a.id));
    await writeAudit(tx, { eventId: p.eventId, actor: p.actor, action: 'achievement.delete', target: a.key, at: p.now });
  });
}

/** Manual award (recognition independent of votes): only achievements without a category, from `games` on. */
export async function awardCustomAchievement(
  db: Db,
  p: { eventId: string; achievementId: string; participantIds: string[]; actor: string; now: Date },
): Promise<{ awarded: number; announcements: CeremonyAnnouncement[] }> {
  return db.transaction(async (tx) => {
    const e = await loadEventRow(tx, p.eventId, true);
    if (!['games', 'reveal', 'awards'].includes(e.phase)) throw new EventError('invalid_step');
    const [a] = await tx
      .select()
      .from(s.customAchievements)
      .where(and(eq(s.customAchievements.id, p.achievementId), eq(s.customAchievements.eventId, e.id)));
    if (!a) throw new EventError('not_found');
    if (a.categoryKey) throw new EventError('invalid_category'); // category achievements come from the ceremony
    const active = await tx
      .select({ id: s.participants.id })
      .from(s.participants)
      .where(and(eq(s.participants.eventId, e.id), eq(s.participants.status, 'active')));
    const ok = new Set(active.map((x) => x.id));
    const announcements: CeremonyAnnouncement[] = [];
    for (const participantId of p.participantIds.filter((id) => ok.has(id)))
      if (await unlockAchievement(tx, { eventId: e.id, participantId, key: a.key, source: 'organizer', now: p.now }))
        announcements.push({ scope: 'pub', participantId, key: a.key });
    await writeAudit(tx, {
      eventId: e.id,
      actor: p.actor,
      action: 'achievement.award',
      target: a.key,
      data: { count: announcements.length },
      at: p.now,
    });
    return { awarded: announcements.length, announcements };
  });
}

/** categoryKey -> achievement key for the ceremony script. */
export async function customCategoryAchievements(db: Db, eventId: string): Promise<Record<string, string>> {
  const rows = await db.select().from(s.customAchievements).where(eq(s.customAchievements.eventId, eventId));
  return Object.fromEntries(rows.flatMap((r) => (r.categoryKey ? [[r.categoryKey, r.key]] : [])));
}
