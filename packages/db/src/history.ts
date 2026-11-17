import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, ne, sql } from 'drizzle-orm';
import {
  ACHIEVEMENT_CATALOG,
  EventArchiveSchema,
  eventFeatures,
  type EventArchiveOutput,
} from '@santa/contracts';
import { giftLabel, publishPeopleBoard, type PublishResult } from '@santa/domain';
import type { Db } from './types.js';
import * as s from './schema.js';
import { EventError } from './events.js';
import { writeAudit } from './audit.js';
import { loadActiveParticipant, loadEventRow, publishedPeople, type EventRow } from './phase2.js';
import { xpTotals } from './xp.js';

/** Titles shown as trophies ("Previous Santa Champion"). Participation badges are separate. */
export const TROPHY_KEYS: ReadonlySet<string> = new Set([
  'christmas_champion',
  'legendary_santa',
  'santa_detective',
  'invisible_santa',
  'mission_master',
  'game_champion',
]);
const PUBLIC_EXTRA_ACHIEVEMENTS = ['santa_detective', 'invisible_santa', 'mission_master', 'game_champion'];
const DAY_MS = 86_400_000;

export const historyEnabled = (e: EventRow) => eventFeatures(e.settings).history;

export function eventYear(e: Pick<EventRow, 'startsAt' | 'timezone'>): number {
  return Number(new Intl.DateTimeFormat('en', { year: 'numeric', timeZone: e.timezone }).format(e.startsAt));
}

interface Snapshot {
  eventId: string;
  name: string;
  year: number;
  completedAt: string;
  participantIds: string[];
  winners: Array<{ boardKey: string; grand: boolean; giftId: string }>;
  achievements: Array<{ key: string; participantId: string }>;
  games: Array<{ kind: string; title: Record<string, string>; results: PublishResult | null }>;
  championId: string | null;
}

/* ---------- archive (public results only) ---------- */

/**
 * Snapshot of the PUBLIC results of a completed event: locked + publishable + ceremony-revealed awards (rank 1
 * only), unlocked achievements, finished games' published results. No votes, nominees, totals, XP, guesses,
 * missions, clue authors or bids can get in: the builder never reads those tables.
 */
async function buildArchive(tx: Db, e: EventRow, now: Date) {
  const completedAt = e.completedAt ?? now;
  const awards = await tx
    .select()
    .from(s.awards)
    .where(
      and(
        eq(s.awards.eventId, e.id),
        eq(s.awards.votingRound, e.votingRound),
        isNull(s.awards.invalidatedAt),
        eq(s.awards.publishable, true),
        isNotNull(s.awards.revealedAt),
      ),
    );
  const hidden = new Set(
    (await tx.select({ id: s.gifts.id }).from(s.gifts).where(and(eq(s.gifts.eventId, e.id), eq(s.gifts.hidden, true)))).map((g) => g.id),
  );
  const ach = await tx.select().from(s.participantAchievements).where(eq(s.participantAchievements.eventId, e.id));
  const games = await tx
    .select()
    .from(s.miniGames)
    .where(and(eq(s.miniGames.eventId, e.id), inArray(s.miniGames.status, ['results', 'finished'])))
    .orderBy(asc(s.miniGames.createdAt));
  const people = await tx
    .select({ id: s.participants.id })
    .from(s.participants)
    .where(and(eq(s.participants.eventId, e.id), eq(s.participants.status, 'active')));
  const snapshot: Snapshot = {
    eventId: e.id,
    name: e.name,
    year: eventYear(e),
    completedAt: completedAt.toISOString(),
    participantIds: people.map((p) => p.id),
    winners: awards.flatMap((a) =>
      a.winners.filter((g) => !hidden.has(g)).map((giftId) => ({ boardKey: a.boardKey, grand: a.boardKey === e.settings.grandChampionBoard, giftId })),
    ),
    achievements: ach.map((a) => ({ key: a.key, participantId: a.participantId })),
    games: games.map((g) => ({ kind: g.kind, title: g.title, results: g.results as PublishResult | null })),
    championId: ach.find((a) => a.key === 'christmas_champion')?.participantId ?? null,
  };
  const expiresAt = new Date(completedAt.getTime() + e.settings.retention.archiveDays * DAY_MS);
  await tx
    .insert(s.eventArchives)
    .values({ eventId: e.id, snapshot, completedAt, expiresAt, builtAt: now })
    .onConflictDoNothing({ target: s.eventArchives.eventId });
}

/** Lifetime titles + season XP for every ACCOUNT-LINKED participant of a completed event (idempotent). */
async function syncLifetimeForEvent(tx: Db, e: EventRow) {
  const linked = await tx
    .select({ id: s.participants.id, userId: s.participants.userId })
    .from(s.participants)
    .where(and(eq(s.participants.eventId, e.id), isNotNull(s.participants.userId), isNull(s.participants.anonymizedAt)));
  if (linked.length === 0) return;
  const year = eventYear(e);
  const ach = await tx.select().from(s.participantAchievements).where(eq(s.participantAchievements.eventId, e.id));
  const totals = eventFeatures(e.settings).xpBoard ? await xpTotals(tx, e.id) : new Map();
  for (const p of linked) {
    const uid = p.userId!;
    const rows = [
      { key: 'participation', trophy: false },
      ...ach.filter((a) => a.participantId === p.id).map((a) => ({ key: a.key, trophy: TROPHY_KEYS.has(a.key) })),
    ];
    for (const r of rows)
      await tx
        .insert(s.lifetimeTitles)
        .values({ userId: uid, eventId: e.id, eventName: e.name, year, key: r.key, trophy: r.trophy })
        .onConflictDoNothing();
    const xp = totals.get(p.id)?.qualifying ?? 0;
    if (xp > 0)
      await tx
        .insert(s.seasonXp)
        .values({ userId: uid, eventId: e.id, ownerId: e.ownerId, year, xp })
        .onConflictDoNothing();
  }
}

/**
 * Called when an event completes (and lazily on reads): syncs the lifetime titles of linked accounts and builds the
 * archive when `features.history` is on. Idempotent.
 */
export async function finalizeEvent(db: Db, eventId: string, now: Date): Promise<{ archived: boolean }> {
  return db.transaction(async (tx) => {
    const e = await loadEventRow(tx, eventId, true);
    if (e.phase !== 'completed' || !e.completedAt) return { archived: false };
    await syncLifetimeForEvent(tx, e);
    if (!historyEnabled(e)) return { archived: false };
    await buildArchive(tx, e, now);
    return { archived: true };
  });
}

export async function purgeExpiredArchives(db: Db, now: Date): Promise<number> {
  const gone = await db.delete(s.eventArchives).where(lte(s.eventArchives.expiresAt, now)).returning({ id: s.eventArchives.eventId });
  return gone.length;
}

const catalogName = (key: string) => {
  const d = ACHIEVEMENT_CATALOG.find((a) => a.key === key);
  return d ? { ...d.name } : { en: key };
};

async function livePeople(db: Db, ids: readonly string[]) {
  if (ids.length === 0) return new Map<string, { participantId: string; displayName: string; avatar: string | null }>();
  const rows = await db
    .select({ id: s.participants.id, name: s.participants.displayName, avatar: s.participants.avatar })
    .from(s.participants)
    .where(and(inArray(s.participants.id, [...ids]), ne(s.participants.status, 'removed')));
  return new Map(rows.map((r) => [r.id, { participantId: r.id, displayName: r.name, avatar: r.avatar }]));
}

/** The archive of one event with names resolved NOW (anonymised people drop out). `null` until it exists. */
export async function archiveView(
  db: Db,
  eventId: string,
  now: Date,
  resolvePhoto: (key: string) => Promise<string | null> = async () => null,
): Promise<{ enabled: boolean; archive: EventArchiveOutput | null }> {
  const e = await loadEventRow(db, eventId);
  const enabled = historyEnabled(e);
  if (e.phase === 'completed') await finalizeEvent(db, eventId, now);
  const [row] = await db.select().from(s.eventArchives).where(eq(s.eventArchives.eventId, eventId));
  if (!enabled || !row || row.expiresAt <= now) return { enabled, archive: null };
  const snap = row.snapshot as Snapshot;
  const gifts = snap.winners.length
    ? await db.select().from(s.gifts).where(inArray(s.gifts.id, snap.winners.map((w) => w.giftId)))
    : [];
  const cats = await db.select().from(s.votingCategories).where(eq(s.votingCategories.eventId, eventId));
  const people = await livePeople(db, [
    ...snap.participantIds,
    ...gifts.map((g) => g.giverId),
    ...snap.achievements.map((a) => a.participantId),
    ...(snap.championId ? [snap.championId] : []),
  ]);
  const winners = await Promise.all(
    snap.winners.flatMap((w) => {
      const g = gifts.find((x) => x.id === w.giftId);
      const giver = g && people.get(g.giverId);
      if (!g || !giver) return [];
      return [
        (async () => ({
          boardKey: w.boardKey,
          name: cats.find((c) => c.key === w.boardKey)?.name ?? { en: w.boardKey },
          grand: w.grand,
          giftLabel: giftLabel(g),
          giftName: g.name,
          photoUrl: g.photoKey ? await resolvePhoto(g.photoKey) : null,
          giver,
        }))(),
      ];
    }),
  );
  const out = {
    eventId,
    name: snap.name,
    year: snap.year,
    completedAt: snap.completedAt,
    participants: snap.participantIds.flatMap((id) => (people.get(id) ? [people.get(id)!] : [])),
    winners,
    achievements: snap.achievements.flatMap((a) => (people.get(a.participantId) ? [{ key: a.key, person: people.get(a.participantId)! }] : [])),
    games: await Promise.all(
      snap.games.map(async (g) => ({ kind: g.kind, title: g.title, winners: await publishedPeople(db, g.results ?? { ok: false }) })),
    ),
    champion: snap.championId ? (people.get(snap.championId) ?? null) : null,
    expiresAt: row.expiresAt.toISOString(),
  };
  return { enabled, archive: EventArchiveSchema.parse(out) };
}

/* ---------- Hall of Fame + seasonal top-N ---------- */

/**
 * Past winners across the organizer's archived events (positive accomplishments only) and the seasonal top-N of
 * linked accounts. The seasonal board is canPublish()-gated like every other ranking (>= 5 distinct accounts,
 * top-N, hidden tail, no totals); only events that ran the XP board feed it.
 */
export async function hallOfFame(db: Db, eventId: string, now: Date) {
  const e = await loadEventRow(db, eventId);
  const enabled = historyEnabled(e);
  if (!enabled) return { enabled, years: [], seasons: [] };
  const archives = await db
    .select({ a: s.eventArchives, ev: { id: s.events.id, name: s.events.name } })
    .from(s.eventArchives)
    .innerJoin(s.events, eq(s.events.id, s.eventArchives.eventId))
    .where(eq(s.events.ownerId, e.ownerId));
  const live = archives.filter((r) => r.a.expiresAt > now);
  const snaps = live.map((r) => ({ ...r, snap: r.a.snapshot as Snapshot }));
  const evIds = snaps.map((x) => x.ev.id);
  const cats = evIds.length ? await db.select().from(s.votingCategories).where(inArray(s.votingCategories.eventId, evIds)) : [];
  const gifts = snaps.flatMap((x) => x.snap.winners.map((w) => w.giftId));
  const giftRows = gifts.length ? await db.select().from(s.gifts).where(inArray(s.gifts.id, gifts)) : [];
  const people = await livePeople(db, [
    ...giftRows.map((g) => g.giverId),
    ...snaps.flatMap((x) => [...(x.snap.championId ? [x.snap.championId] : []), ...x.snap.achievements.map((a) => a.participantId)]),
  ]);
  const byYear = new Map<number, Array<{ name: string; champions: Array<{ kind: 'grand_champion' | 'christmas_champion' | 'category_winner' | 'achievement'; title: Record<string, string>; person: { participantId: string; displayName: string; avatar: string | null } }> }>>();
  for (const x of snaps) {
    const champions: NonNullable<ReturnType<typeof byYear.get>>[number]['champions'] = [];
    for (const w of x.snap.winners) {
      const giver = giftRows.find((g) => g.id === w.giftId)?.giverId;
      const person = giver && people.get(giver);
      if (person)
        champions.push({
          kind: w.grand ? 'grand_champion' : 'category_winner',
          title: cats.find((c) => c.eventId === x.ev.id && c.key === w.boardKey)?.name ?? { en: w.boardKey },
          person,
        });
    }
    const champ = x.snap.championId && people.get(x.snap.championId);
    if (champ) champions.push({ kind: 'christmas_champion', title: catalogName('christmas_champion'), person: champ });
    for (const a of x.snap.achievements.filter((a) => PUBLIC_EXTRA_ACHIEVEMENTS.includes(a.key))) {
      const person = people.get(a.participantId);
      if (person) champions.push({ kind: 'achievement', title: catalogName(a.key), person });
    }
    byYear.set(x.snap.year, [...(byYear.get(x.snap.year) ?? []), { name: x.snap.name, champions }]);
  }
  // seasonal board: accounts, not events
  const rows = await db.select().from(s.seasonXp).where(eq(s.seasonXp.ownerId, e.ownerId));
  const seasons: Array<{ year: number; board: Awaited<ReturnType<typeof publishedPeople>> }> = [];
  for (const year of [...new Set(rows.map((r) => r.year))].sort((a, b) => b - a)) {
    const yr = rows.filter((r) => r.year === year);
    const perUser = new Map<string, number>();
    for (const r of yr) perUser.set(r.userId, (perUser.get(r.userId) ?? 0) + r.xp);
    const reps = await db
      .select({ id: s.participants.id, userId: s.participants.userId })
      .from(s.participants)
      .where(and(inArray(s.participants.userId, [...perUser.keys()]), ne(s.participants.status, 'removed')))
      .orderBy(desc(s.participants.createdAt));
    const rep = new Map<string, string>();
    for (const r of reps) if (r.userId && !rep.has(r.userId)) rep.set(r.userId, r.id);
    const scores = [...perUser].flatMap(([uid, xp]) => (rep.has(uid) ? [{ entryId: rep.get(uid)!, score: xp }] : []));
    const res = publishPeopleBoard(scores, scores.length, {
      topN: e.settings.topN,
      hiddenMin: e.settings.hiddenMin,
      minContributors: e.settings.minVoters,
    });
    seasons.push({ year, board: await publishedPeople(db, res) });
  }
  return {
    enabled,
    years: [...byYear].sort((a, b) => b[0] - a[0]).map(([year, events]) => ({ year, events })),
    seasons,
  };
}

/* ---------- guest -> account claim ---------- */

export const hashLinkToken = (token: string) => createHash('sha256').update(token).digest('hex');
const LINK_TTL_MS = 30 * 60_000;

/** Records a one-time link for a VERIFIED, active participant (the caller emails the raw token). */
export async function createLinkToken(
  db: Db,
  p: { participantId: string; email: string; tokenHash: string; now: Date },
) {
  const me = await loadActiveParticipant(db, p.participantId);
  if (!me.claimVerifiedAt) throw new EventError('verification_required');
  if (me.userId) throw new EventError('already_linked');
  await db.insert(s.accountLinkTokens).values({
    participantId: me.id,
    email: p.email.trim().toLowerCase(),
    tokenHash: p.tokenHash,
    expiresAt: new Date(p.now.getTime() + LINK_TTL_MS),
    createdAt: p.now,
  });
}

/**
 * Consumes the token atomically and attaches the participant to the account owning that email (created if
 * missing; the mailbox proof makes the address verified). One generic error for every bad token.
 */
export async function confirmAccountLink(db: Db, p: { tokenHash: string; now: Date }) {
  return db.transaction(async (tx) => {
    const used = await tx
      .update(s.accountLinkTokens)
      .set({ usedAt: p.now })
      .where(and(eq(s.accountLinkTokens.tokenHash, p.tokenHash), isNull(s.accountLinkTokens.usedAt), sql`${s.accountLinkTokens.expiresAt} > ${p.now}`))
      .returning();
    const t = used[0];
    if (!t) throw new EventError('invalid_link');
    const [me] = await tx.select().from(s.participants).where(eq(s.participants.id, t.participantId));
    if (!me || me.status !== 'active') throw new EventError('invalid_link');
    if (me.userId) throw new EventError('already_linked');
    const [existing] = await tx.select().from(s.user).where(sql`lower(${s.user.email}) = ${t.email}`);
    let userId = existing?.id;
    if (!userId) {
      userId = randomUUID();
      await tx.insert(s.user).values({ id: userId, name: me.displayName, email: t.email, emailVerified: true });
    } else if (!existing!.emailVerified) {
      await tx.update(s.user).set({ emailVerified: true }).where(eq(s.user.id, userId));
    }
    await tx.update(s.participants).set({ userId }).where(eq(s.participants.id, me.id));
    const e = await loadEventRow(tx, me.eventId);
    if (e.phase === 'completed') await syncLifetimeForEvent(tx, e);
    await writeAudit(tx, { eventId: me.eventId, actor: `participant:${me.id}`, action: 'account.link', target: me.id, at: p.now });
    return { userId, participantId: me.id };
  });
}

/* ---------- lifetime profile ---------- */

export async function lifetimeProfile(db: Db, userId: string) {
  const [u] = await db.select().from(s.user).where(eq(s.user.id, userId));
  if (!u) return { linked: false as const, profile: null };
  const rows = await db.select().from(s.lifetimeTitles).where(eq(s.lifetimeTitles.userId, userId)).orderBy(desc(s.lifetimeTitles.year));
  const linkedPeople = await db
    .select({ name: s.participants.displayName })
    .from(s.participants)
    .where(and(eq(s.participants.userId, userId), ne(s.participants.status, 'removed')))
    .orderBy(desc(s.participants.createdAt))
    .limit(1);
  const linked = rows.length > 0 || linkedPeople.length > 0;
  if (!linked) return { linked: false as const, profile: null };
  const custom = rows.length
    ? await db.select().from(s.customAchievements).where(inArray(s.customAchievements.eventId, [...new Set(rows.map((r) => r.eventId))]))
    : [];
  const titles = rows
    .filter((r) => r.key !== 'participation')
    .map((r) => ({
      key: r.key,
      title: custom.find((c) => c.eventId === r.eventId && c.key === r.key)?.name ?? catalogName(r.key),
      eventName: r.eventName,
      year: r.year,
      trophy: r.trophy,
    }));
  return {
    linked: true as const,
    profile: {
      displayName: linkedPeople[0]?.name ?? u.name,
      events: new Set(rows.map((r) => r.eventId)).size,
      participationYears: [...new Set(rows.filter((r) => r.key === 'participation').map((r) => r.year))].sort((a, b) => b - a),
      titles,
      totalAchievements: titles.length,
    },
  };
}

export async function participantLifetime(db: Db, participantId: string) {
  const me = await loadActiveParticipant(db, participantId);
  return me.userId ? lifetimeProfile(db, me.userId) : { linked: false as const, profile: null };
}
