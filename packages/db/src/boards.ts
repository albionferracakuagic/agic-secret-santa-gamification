import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  canPublish,
  canPublishBallots,
  fingerprint,
  type PublishConfig,
  type PublishPurpose,
  type PublishResult,
} from '@santa/domain';
import { XP_BOARD_KEY } from '@santa/contracts';
import type { Db } from './types.js';
import * as s from './schema.js';
import { writeAudit } from './audit.js';
import { EventError } from './events.js';
import { xpTotals } from './xp.js';

export const VOTED_COUNTER_BOARD = 'voted_counter';

type Event = typeof s.events.$inferSelect;
type BoardStateValue = 'hidden' | 'live' | 'paused';

const configOf = (e: Event): PublishConfig => ({
  topN: e.settings.topN,
  hiddenMin: e.settings.hiddenMin,
  minVoters: e.settings.minVoters,
  minTotalVotes: e.settings.minTotalVotes,
  tieBreak: e.settings.tieBreak,
  showTotals: e.settings.showTotals,
});

async function loadEvent(db: Db, eventId: string): Promise<Event> {
  const [e] = await db.select().from(s.events).where(eq(s.events.id, eventId));
  if (!e) throw new EventError('not_found');
  return e;
}

/** Distinct voters across the whole event (live-board small-cohort rule). */
export async function distinctVoters(db: Db, eventId: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(distinct ${s.votes.voterId})::int` })
    .from(s.votes)
    .where(eq(s.votes.eventId, eventId));
  return Number(r?.n ?? 0);
}

/** Single publication policy for a board from current data. The XP board ranks qualifying XP. */
export async function computeBoard(
  db: Db,
  e: Event,
  boardKey: string,
  purpose: PublishPurpose = 'live',
): Promise<PublishResult> {
  if (boardKey === XP_BOARD_KEY) {
    const totals = await xpTotals(db, e.id);
    const scores = [...totals]
      .filter(([, t]) => t.qualifying > 0)
      .map(([entryId, t]) => ({ entryId, score: t.qualifying }));
    // XP is activity, not votes: vote-count floors do not apply, the hidden-tail rule still does.
    return canPublish(
      { scores, contributors: scores.length, purpose },
      { ...configOf(e), minVoters: 0, minTotalVotes: 0 },
    );
  }
  const [cat] = await db
    .select({ id: s.votingCategories.id })
    .from(s.votingCategories)
    .where(and(eq(s.votingCategories.eventId, e.id), eq(s.votingCategories.key, boardKey)));
  if (!cat) throw new EventError('invalid_category');
  const rows = await db
    .select({ voterId: s.votes.voterId, entryId: s.votes.giftId })
    .from(s.votes)
    .innerJoin(s.gifts, eq(s.gifts.id, s.votes.giftId))
    .where(and(eq(s.votes.categoryId, cat.id), eq(s.gifts.hidden, false)));
  return canPublishBallots(rows, configOf(e), { purpose });
}

async function ensureRow(db: Db, eventId: string, boardKey: string) {
  await db
    .insert(s.boardPublications)
    .values({ eventId, boardKey, state: 'hidden' })
    .onConflictDoNothing({ target: [s.boardPublications.eventId, s.boardPublications.boardKey] });
  const [row] = await db
    .select()
    .from(s.boardPublications)
    .where(
      and(eq(s.boardPublications.eventId, eventId), eq(s.boardPublications.boardKey, boardKey)),
    );
  return row!;
}

export interface BoardListItem {
  boardKey: string;
  kind: 'category' | 'xp';
  label: Record<string, string>;
  state: BoardStateValue;
  forced: boolean;
  lastPublishedAt: Date | null;
  liveAllowed: boolean;
  publishableNow: boolean;
}

export async function listBoards(db: Db, eventId: string): Promise<BoardListItem[]> {
  const e = await loadEvent(db, eventId);
  const cats = await db
    .select()
    .from(s.votingCategories)
    .where(and(eq(s.votingCategories.eventId, eventId), eq(s.votingCategories.enabled, true)))
    .orderBy(s.votingCategories.sort);
  const pubs = await db
    .select()
    .from(s.boardPublications)
    .where(eq(s.boardPublications.eventId, eventId));
  const voters = await distinctVoters(db, eventId);
  const keys: Array<{ key: string; kind: 'category' | 'xp'; label: Record<string, string> }> = [
    ...cats.map((c) => ({ key: c.key, kind: 'category' as const, label: c.name })),
    ...(e.settings.features.xpBoard
      ? [
          {
            key: XP_BOARD_KEY,
            kind: 'xp' as const,
            label: { en: 'Christmas XP', it: 'XP di Natale' },
          },
        ]
      : []),
  ];
  const out: BoardListItem[] = [];
  for (const k of keys) {
    const p = pubs.find((x) => x.boardKey === k.key);
    const forced = p?.forced ?? false;
    out.push({
      boardKey: k.key,
      kind: k.kind,
      label: k.label,
      state: p?.state ?? 'hidden',
      forced,
      lastPublishedAt: p?.lastPublishedAt ?? null,
      liveAllowed: k.kind === 'xp' || forced || voters >= e.settings.liveBoardMinVoters,
      publishableNow: (await computeBoard(db, e, k.key)).ok,
    });
  }
  return out;
}

export type BoardAction = 'enable' | 'pause' | 'resume' | 'hide' | 'publish_now';

/** Publishes only if the projection changed AND canPublish passes (an unsafe result replaces an old safe one). */
export async function publishBoard(
  db: Db,
  p: { eventId: string; boardKey: string; now: Date; purpose?: PublishPurpose; manual?: boolean },
): Promise<{ changed: boolean }> {
  const e = await loadEvent(db, p.eventId);
  const row = await ensureRow(db, p.eventId, p.boardKey);
  if (row.state === 'hidden') return { changed: false };
  if (row.state === 'paused' && !p.manual && p.purpose !== 'final') return { changed: false };
  const next = await computeBoard(db, e, p.boardKey, p.purpose ?? 'live');
  const prev = row.lastPublished as PublishResult | null;
  if (prev && fingerprint(prev) === fingerprint(next)) return { changed: false };
  // First unsafe result: nothing to replace, the projection already shows the neutral message.
  if (!prev && !next.ok) return { changed: false };
  await db
    .update(s.boardPublications)
    .set({
      lastPublished: next,
      lastPublishedAt: p.now,
      cursor: sql`${s.boardPublications.cursor} + 1`,
    })
    .where(eq(s.boardPublications.id, row.id));
  return { changed: true };
}

/** One cadence tick over every live board. */
export async function publishLiveBoards(db: Db, eventId: string, now: Date): Promise<boolean> {
  const rows = await db
    .select({ boardKey: s.boardPublications.boardKey })
    .from(s.boardPublications)
    .where(
      and(
        eq(s.boardPublications.eventId, eventId),
        eq(s.boardPublications.state, 'live'),
        ne(s.boardPublications.boardKey, VOTED_COUNTER_BOARD),
      ),
    );
  let changed = false;
  for (const r of rows) {
    if ((await publishBoard(db, { eventId, boardKey: r.boardKey, now })).changed) changed = true;
  }
  return changed;
}

export async function boardAction(
  db: Db,
  p: {
    eventId: string;
    actor: string;
    boardKey: string;
    action: BoardAction;
    acknowledgeSmallCohort?: boolean | undefined;
    now: Date;
  },
): Promise<{ boardKey: string; state: BoardStateValue }> {
  return db.transaction(async (tx) => {
    const e = await loadEvent(tx, p.eventId);
    const known = await listBoards(tx, p.eventId);
    if (!known.some((b) => b.boardKey === p.boardKey)) throw new EventError('invalid_category');
    const row = await ensureRow(tx, p.eventId, p.boardKey);
    let state: BoardStateValue = row.state;
    let forced = row.forced;
    if (p.action === 'enable') {
      const small =
        p.boardKey !== XP_BOARD_KEY &&
        (await distinctVoters(tx, p.eventId)) < e.settings.liveBoardMinVoters;
      if (small && !p.acknowledgeSmallCohort) throw new EventError('small_cohort_ack_required');
      forced = small;
      state = 'live';
    } else if (p.action === 'pause') {
      if (state === 'live') state = 'paused';
    } else if (p.action === 'resume') {
      if (state === 'paused') state = 'live';
    } else if (p.action === 'hide') {
      state = 'hidden';
    } else if (state === 'hidden') {
      throw new EventError('board_hidden');
    }
    await tx
      .update(s.boardPublications)
      .set(
        p.action === 'hide'
          ? {
              state,
              forced,
              lastPublished: null,
              lastPublishedAt: null,
              cursor: sql`${s.boardPublications.cursor} + 1`,
            }
          : { state, forced },
      )
      .where(eq(s.boardPublications.id, row.id));
    if (p.action === 'enable' || p.action === 'resume' || p.action === 'publish_now') {
      await publishBoard(tx, {
        eventId: p.eventId,
        boardKey: p.boardKey,
        now: p.now,
        manual: p.action === 'publish_now',
      });
    }
    await writeAudit(tx, {
      eventId: p.eventId,
      actor: p.actor,
      action: `board.${p.action}`,
      data: { boardKey: p.boardKey, forced },
      at: p.now,
    });
    return { boardKey: p.boardKey, state };
  });
}

/** Voting closed: boards freeze on their last publication until the ceremony publishes final results. */
export async function freezeBoards(db: Db, eventId: string) {
  await db
    .update(s.boardPublications)
    .set({ state: 'paused' })
    .where(
      and(
        eq(s.boardPublications.eventId, eventId),
        eq(s.boardPublications.state, 'live'),
        ne(s.boardPublications.boardKey, VOTED_COUNTER_BOARD),
      ),
    );
}

/** After the ceremony: final results through the same policy; visible boards go live again. */
export async function publishFinalBoards(db: Db, eventId: string, now: Date) {
  const rows = await db
    .select()
    .from(s.boardPublications)
    .where(
      and(
        eq(s.boardPublications.eventId, eventId),
        inArray(s.boardPublications.state, ['live', 'paused']),
        ne(s.boardPublications.boardKey, VOTED_COUNTER_BOARD),
      ),
    );
  for (const r of rows) {
    await publishBoard(db, { eventId, boardKey: r.boardKey, now, purpose: 'final' });
    await db
      .update(s.boardPublications)
      .set({ state: 'live' })
      .where(eq(s.boardPublications.id, r.id));
  }
}
