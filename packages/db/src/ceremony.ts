import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  autoAdvanceSeconds,
  buildCeremonyScript,
  canPublishBallots,
  giftLabel,
  spiritQualifiers,
  type CeremonyStep,
  type PublishConfig,
} from '@santa/domain';
import type { CeremonyStepOutput, CeremonyViewOutput } from '@santa/contracts';
import type { Db } from './types.js';
import * as s from './schema.js';
import { writeAudit } from './audit.js';
import { EventError } from './events.js';
import { cancelJobs, enqueueJob } from './jobs.js';
import { unlockAchievement } from './achievements.js';
import { publishFinalBoards } from './boards.js';
import { xpTotals } from './xp.js';

export const CEREMONY_STEP_JOB = 'ceremony.step';

type Event = typeof s.events.$inferSelect;
type Award = typeof s.awards.$inferSelect;
type State = typeof s.ceremonyState.$inferSelect;

export interface CeremonyAnnouncement {
  /** pub = everyone sees it; participant = only that person's own stream. */
  scope: 'pub' | 'participant';
  participantId: string;
  key: string;
}

interface TieInfo {
  tied?: boolean;
  needsDecision?: boolean;
  candidates?: string[];
  nominees?: string[];
}

const tieOf = (a: Award) => (a.tieInfo ?? {}) as TieInfo;

async function loadEvent(db: Db, eventId: string, lock = false): Promise<Event> {
  const q = db.select().from(s.events).where(eq(s.events.id, eventId));
  const [e] = await (lock ? q.for('update') : q);
  if (!e) throw new EventError('not_found');
  return e;
}

const currentAwards = (db: Db, e: Event) =>
  db
    .select()
    .from(s.awards)
    .where(
      and(
        eq(s.awards.eventId, e.id),
        eq(s.awards.votingRound, e.votingRound),
        isNull(s.awards.invalidatedAt),
      ),
    );

async function stateRow(db: Db, eventId: string, lock = false): Promise<State | undefined> {
  const q = db.select().from(s.ceremonyState).where(eq(s.ceremonyState.eventId, eventId));
  return (await (lock ? q.for('update') : q))[0];
}

export async function ceremonyBlockers(db: Db, e: Event) {
  const blockers: Array<
    'not_in_awards_phase' | 'voting_not_closed' | 'decisions_pending' | 'nothing_to_show'
  > = [];
  if (e.phase !== 'awards') blockers.push('not_in_awards_phase');
  if (!e.votingClosedAt) blockers.push('voting_not_closed');
  const awards = await currentAwards(db, e);
  if (awards.length === 0) blockers.push('nothing_to_show');
  if (awards.some((a) => a.publishable && tieOf(a).needsDecision && a.winners.length === 0))
    blockers.push('decisions_pending');
  return blockers;
}

export async function pendingDecisions(db: Db, e: Event) {
  const pending = (await currentAwards(db, e)).filter(
    (a) => a.publishable && tieOf(a).needsDecision && a.winners.length === 0,
  );
  if (pending.length === 0) return [];
  const gifts = await db.select().from(s.gifts).where(eq(s.gifts.eventId, e.id));
  return pending.map((a) => ({
    boardKey: a.boardKey,
    candidates: (tieOf(a).candidates ?? []).flatMap((id) => {
      const g = gifts.find((x) => x.id === id);
      return g ? [{ giftId: id, label: giftLabel(g) }] : [];
    }),
  }));
}

/** Organizer picks ONE winner among the tied candidates (before the show starts); audited. */
export async function decideAward(
  db: Db,
  p: { eventId: string; actor: string; boardKey: string; giftId: string; now: Date },
) {
  return db.transaction(async (tx) => {
    const e = await loadEvent(tx, p.eventId, true);
    const st = await stateRow(tx, p.eventId);
    if (st && (st.status === 'running' || st.status === 'paused' || st.status === 'done'))
      throw new EventError('ceremony_started');
    const award = (await currentAwards(tx, e)).find((a) => a.boardKey === p.boardKey);
    if (!award) throw new EventError('not_found');
    const info = tieOf(award);
    if (!info.needsDecision && !info.candidates) throw new EventError('no_decision_needed');
    if (!(info.candidates ?? []).includes(p.giftId)) throw new EventError('not_a_candidate');
    await tx
      .update(s.awards)
      .set({
        winners: [p.giftId],
        tieInfo: { ...info, needsDecision: false, tied: false, decided: true },
        confirmedBy: p.actor,
      })
      .where(eq(s.awards.id, award.id));
    await writeAudit(tx, {
      eventId: p.eventId,
      actor: p.actor,
      action: 'award.decide',
      target: p.boardKey,
      data: { giftId: p.giftId },
      at: p.now,
    });
    return { boardKey: p.boardKey, decided: true as const };
  });
}

/** Leading gifts for the "nominees" step: same policy as everything else, shown in alias order (no ranking). */
async function computeNominees(db: Db, e: Event, categoryId: string): Promise<string[]> {
  const rows = await db
    .select({ voterId: s.votes.voterId, entryId: s.votes.giftId })
    .from(s.votes)
    .innerJoin(s.gifts, eq(s.gifts.id, s.votes.giftId))
    .where(and(eq(s.votes.categoryId, categoryId), eq(s.gifts.hidden, false)));
  const cfg: PublishConfig = {
    topN: e.settings.topN,
    hiddenMin: e.settings.hiddenMin,
    minVoters: e.settings.minVoters,
    minTotalVotes: e.settings.minTotalVotes,
    tieBreak: e.settings.tieBreak,
  };
  const r = canPublishBallots(rows, cfg, { purpose: 'live' });
  return r.ok ? r.entries.map((x) => x.entryId) : [];
}

/* ---------- state machine ---------- */

async function enterStep(
  tx: Db,
  e: Event,
  st: State,
  index: number,
  actor: string,
  now: Date,
): Promise<CeremonyAnnouncement[]> {
  const script = st.script as CeremonyStep[];
  const step = script[index]!;
  const seconds = autoAdvanceSeconds(step);
  const endsAt = seconds ? new Date(now.getTime() + seconds * 1000) : null;
  await tx
    .update(s.ceremonyState)
    .set({ stepIndex: index, stepEndsAt: endsAt })
    .where(eq(s.ceremonyState.eventId, e.id));
  if (endsAt) {
    await enqueueJob(tx, {
      eventId: e.id,
      kind: CEREMONY_STEP_JOB,
      runAt: endsAt,
      payload: { index },
    });
  }
  const out: CeremonyAnnouncement[] = [];
  const awards = await currentAwards(tx, e);

  if (step.type === 'winner') {
    const award = awards.find((a) => a.boardKey === step.boardKey);
    if (award) {
      for (const giftId of award.winners) {
        // the giver is revealed exactly when the winner is shown, never earlier; irreversible
        const done = await tx
          .update(s.gifts)
          .set({ status: 'revealed', giverRevealedAt: now })
          .where(
            and(eq(s.gifts.id, giftId), eq(s.gifts.eventId, e.id), isNull(s.gifts.giverRevealedAt)),
          )
          .returning({ id: s.gifts.id });
        if (done.length)
          await writeAudit(tx, {
            eventId: e.id,
            actor,
            action: 'reveal.gift',
            target: giftId,
            data: { via: 'ceremony' },
            at: now,
          });
      }
      await tx.update(s.awards).set({ revealedAt: now }).where(eq(s.awards.id, award.id));
    }
  } else if (step.type === 'achievement') {
    const award = awards.find((a) => a.boardKey === step.boardKey);
    const givers = award?.winners.length
      ? await tx
          .select({ giverId: s.gifts.giverId })
          .from(s.gifts)
          .where(and(inArray(s.gifts.id, award.winners), eq(s.gifts.hidden, false)))
      : [];
    for (const { giverId } of givers) {
      await unlockAchievement(tx, {
        eventId: e.id,
        participantId: giverId,
        key: step.achievementKey,
        source: 'ceremony',
        now,
      });
      out.push({ scope: 'pub', participantId: giverId, key: step.achievementKey });
    }
  } else if (step.type === 'spirit') {
    for (const id of await spiritIds(tx, e.id)) {
      await unlockAchievement(tx, {
        eventId: e.id,
        participantId: id,
        key: 'christmas_spirit',
        source: 'ceremony',
        now,
      });
      out.push({ scope: 'participant', participantId: id, key: 'christmas_spirit' });
    }
  } else if (step.type === 'champion' && step.participantId) {
    await unlockAchievement(tx, {
      eventId: e.id,
      participantId: step.participantId,
      key: 'christmas_champion',
      source: 'ceremony',
      now,
    });
    out.push({ scope: 'pub', participantId: step.participantId, key: 'christmas_champion' });
  }
  return out;
}

async function spiritIds(db: Db, eventId: string): Promise<string[]> {
  const rows = await db
    .select({
      participantId: s.xpLedger.participantId,
      rewardKey: s.xpLedger.rewardKey,
      qualifying: s.xpLedger.qualifying,
    })
    .from(s.xpLedger)
    .innerJoin(s.participants, eq(s.participants.id, s.xpLedger.participantId))
    .where(and(eq(s.xpLedger.eventId, eventId), eq(s.participants.status, 'active')));
  return spiritQualifiers(rows);
}

async function buildScript(tx: Db, e: Event, awards: Award[]): Promise<CeremonyStep[]> {
  const script = buildCeremonyScript(
    awards.map((a) => ({
      boardKey: a.boardKey,
      publishable: a.publishable && a.winners.length > 0,
      hasNominees: (tieOf(a).nominees ?? []).length >= 2,
    })),
    {
      grandBoard: e.settings.grandChampionBoard,
      countdownSeconds: e.settings.ceremonyCountdownSeconds,
      includeSpirit: (await spiritIds(tx, e.id)).length > 0,
      includeChampion: true,
    },
  );
  const totals = [...(await xpTotals(tx, e.id))]
    .filter(([, t]) => t.qualifying > 0)
    .sort((a, b) => b[1].qualifying - a[1].qualifying);
  // a tie for first place has no single champion: the step is dropped rather than picking arbitrarily
  const champ =
    totals[0] && (!totals[1] || totals[1][1].qualifying < totals[0][1].qualifying)
      ? totals[0][0]
      : null;
  return script.flatMap<CeremonyStep>((st) =>
    st.type !== 'champion' ? [st] : champ ? [{ ...st, participantId: champ }] : [],
  );
}

async function begin(
  tx: Db,
  e: Event,
  actor: string,
  now: Date,
  action: 'ceremony.start' | 'ceremony.restart',
) {
  const blockers = await ceremonyBlockers(tx, e);
  if (blockers.length) throw new EventError(blockers[0]!);
  const awards = await currentAwards(tx, e);
  const cats = await tx
    .select()
    .from(s.votingCategories)
    .where(eq(s.votingCategories.eventId, e.id));
  for (const a of awards) {
    const cat = cats.find((c) => c.key === a.boardKey);
    const nominees =
      a.publishable && cat && a.winners.length > 0 ? await computeNominees(tx, e, cat.id) : [];
    await tx
      .update(s.awards)
      .set({
        tieInfo: { ...tieOf(a), nominees },
        confirmedBy: a.publishable ? actor : a.confirmedBy,
      })
      .where(eq(s.awards.id, a.id));
  }
  const fresh = await currentAwards(tx, e);
  const script = await buildScript(tx, e, fresh);
  const values = {
    script,
    stepIndex: 0,
    status: 'running' as const,
    stepEndsAt: null,
    votingRound: e.votingRound,
    startedAt: now,
  };
  await tx
    .insert(s.ceremonyState)
    .values({ eventId: e.id, ...values })
    .onConflictDoUpdate({ target: s.ceremonyState.eventId, set: values });
  await cancelJobs(tx, e.id, [CEREMONY_STEP_JOB]);
  await writeAudit(tx, { eventId: e.id, actor, action, at: now });
  const st = (await stateRow(tx, e.id))!;
  const announcements = await enterStep(tx, e, st, 0, actor, now);
  return { index: 0, total: script.length, announcements };
}

export async function startCeremony(db: Db, p: { eventId: string; actor: string; now: Date }) {
  return db.transaction(async (tx) => {
    const e = await loadEvent(tx, p.eventId, true);
    const st = await stateRow(tx, p.eventId);
    if (st && st.status !== 'idle' && st.status !== 'cancelled')
      throw new EventError('ceremony_started');
    return begin(tx, e, p.actor, p.now, 'ceremony.start');
  });
}

/** Back to step 0 with the same locked awards. Reveals/achievements already happened and stay (idempotent). */
export async function restartCeremony(db: Db, p: { eventId: string; actor: string; now: Date }) {
  return db.transaction(async (tx) => {
    const e = await loadEvent(tx, p.eventId, true);
    return begin(tx, e, p.actor, p.now, 'ceremony.restart');
  });
}

export async function advanceCeremony(
  db: Db,
  p: { eventId: string; actor: string; fromIndex: number; now: Date; auto?: boolean },
): Promise<{ moved: boolean; announcements: CeremonyAnnouncement[]; done: boolean }> {
  return db.transaction(async (tx) => {
    const e = await loadEvent(tx, p.eventId, true);
    const st = await stateRow(tx, p.eventId, true);
    if (!st || st.status !== 'running') {
      if (p.auto) return { moved: false, announcements: [], done: false };
      throw new EventError('ceremony_not_running');
    }
    if (st.stepIndex !== p.fromIndex) {
      if (p.auto) return { moved: false, announcements: [], done: false };
      throw new EventError('stale_step');
    }
    if (p.auto && (!st.stepEndsAt || p.now < st.stepEndsAt))
      return { moved: false, announcements: [], done: false };
    await cancelJobs(tx, p.eventId, [CEREMONY_STEP_JOB]);
    const script = st.script as CeremonyStep[];
    const next = st.stepIndex + 1;
    if (next >= script.length) {
      await tx
        .update(s.ceremonyState)
        .set({ status: 'done', stepEndsAt: null })
        .where(eq(s.ceremonyState.eventId, p.eventId));
      await publishFinalBoards(tx, p.eventId, p.now);
      await writeAudit(tx, {
        eventId: p.eventId,
        actor: p.actor,
        action: 'ceremony.done',
        at: p.now,
      });
      return { moved: true, announcements: [], done: true };
    }
    const announcements = await enterStep(tx, e, st, next, p.actor, p.now);
    return { moved: true, announcements, done: false };
  });
}

export async function pauseCeremony(db: Db, p: { eventId: string; actor: string; now: Date }) {
  await db.transaction(async (tx) => {
    const st = await stateRow(tx, p.eventId, true);
    if (!st || st.status !== 'running') throw new EventError('ceremony_not_running');
    await tx
      .update(s.ceremonyState)
      .set({ status: 'paused', stepEndsAt: null })
      .where(eq(s.ceremonyState.eventId, p.eventId));
    await cancelJobs(tx, p.eventId, [CEREMONY_STEP_JOB]);
    await writeAudit(tx, {
      eventId: p.eventId,
      actor: p.actor,
      action: 'ceremony.pause',
      at: p.now,
    });
  });
}

export async function resumeCeremony(db: Db, p: { eventId: string; actor: string; now: Date }) {
  await db.transaction(async (tx) => {
    const st = await stateRow(tx, p.eventId, true);
    if (!st || st.status !== 'paused') throw new EventError('ceremony_not_paused');
    const step = (st.script as CeremonyStep[])[st.stepIndex]!;
    const seconds = autoAdvanceSeconds(step);
    const endsAt = seconds ? new Date(p.now.getTime() + seconds * 1000) : null;
    await tx
      .update(s.ceremonyState)
      .set({ status: 'running', stepEndsAt: endsAt })
      .where(eq(s.ceremonyState.eventId, p.eventId));
    if (endsAt)
      await enqueueJob(tx, {
        eventId: p.eventId,
        kind: CEREMONY_STEP_JOB,
        runAt: endsAt,
        payload: { index: st.stepIndex },
      });
    await writeAudit(tx, {
      eventId: p.eventId,
      actor: p.actor,
      action: 'ceremony.resume',
      at: p.now,
    });
  });
}

export async function cancelCeremony(db: Db, p: { eventId: string; actor: string; now: Date }) {
  await db.transaction(async (tx) => {
    const st = await stateRow(tx, p.eventId, true);
    if (!st || st.status === 'idle' || st.status === 'cancelled')
      throw new EventError('ceremony_not_running');
    await tx
      .update(s.ceremonyState)
      .set({ status: 'cancelled', stepEndsAt: null })
      .where(eq(s.ceremonyState.eventId, p.eventId));
    await cancelJobs(tx, p.eventId, [CEREMONY_STEP_JOB]);
    await writeAudit(tx, {
      eventId: p.eventId,
      actor: p.actor,
      action: 'ceremony.cancel',
      at: p.now,
    });
  });
}

/* ---------- views ---------- */

export async function organizerCeremonyState(db: Db, eventId: string) {
  const e = await loadEvent(db, eventId);
  const st = await stateRow(db, eventId);
  const blockers = await ceremonyBlockers(db, e);
  const script = (st?.script ?? []) as CeremonyStep[];
  return {
    status: st?.status ?? ('idle' as const),
    index: st?.stepIndex ?? 0,
    total: script.length,
    canStart: blockers.length === 0 && (!st || st.status === 'idle' || st.status === 'cancelled'),
    blockers,
    outline: script.map((x) => x.type),
    pendingDecisions: e.settings.tieBreak === 'organizer' ? await pendingDecisions(db, e) : [],
  };
}

/** Public view of the current step (same payload for display and participants). Null when no show happened yet. */
export async function ceremonyView(db: Db, eventId: string): Promise<CeremonyViewOutput | null> {
  const e = await loadEvent(db, eventId);
  const st = await stateRow(db, eventId);
  if (!st || st.status === 'idle') return null;
  const script = st.script as CeremonyStep[];
  const step = script[st.stepIndex];
  if (!step) return null;
  return {
    status: st.status,
    index: st.stepIndex,
    total: script.length,
    endsAt: st.stepEndsAt?.toISOString() ?? null,
    step: await resolveStep(db, e, step),
  };
}

async function person(db: Db, id: string) {
  const [p] = await db
    .select({
      id: s.participants.id,
      name: s.participants.displayName,
      avatar: s.participants.avatar,
    })
    .from(s.participants)
    .where(eq(s.participants.id, id));
  return p
    ? { participantId: p.id, displayName: p.name, avatar: p.avatar }
    : { participantId: id, displayName: '', avatar: null };
}

async function resolveStep(db: Db, e: Event, step: CeremonyStep): Promise<CeremonyStepOutput> {
  const catName = async (key: string): Promise<Record<string, string>> => {
    const [c] = await db
      .select({ name: s.votingCategories.name })
      .from(s.votingCategories)
      .where(and(eq(s.votingCategories.eventId, e.id), eq(s.votingCategories.key, key)));
    return c?.name ?? { en: key };
  };
  const award = (key: string) =>
    currentAwards(db, e).then((a) => a.find((x) => x.boardKey === key));
  const giftsOf = async (ids: string[]) =>
    ids.length
      ? db
          .select()
          .from(s.gifts)
          .where(
            and(eq(s.gifts.eventId, e.id), inArray(s.gifts.id, ids), eq(s.gifts.hidden, false)),
          )
      : [];

  switch (step.type) {
    case 'intro':
    case 'outro':
      return { type: step.type };
    case 'category':
      return {
        type: 'category',
        boardKey: step.boardKey,
        name: await catName(step.boardKey),
        grand: step.grand,
      };
    case 'category_skipped':
      return {
        type: 'category_skipped',
        boardKey: step.boardKey,
        name: await catName(step.boardKey),
      };
    case 'countdown':
      return { type: 'countdown', seconds: step.seconds };
    case 'nominees': {
      const a = await award(step.boardKey);
      const gs = (await giftsOf(tieOf(a ?? ({} as Award)).nominees ?? [])).sort(
        (x, y) => x.aliasNo - y.aliasNo,
      );
      return {
        type: 'nominees',
        boardKey: step.boardKey,
        entries: gs.map((g) => ({ entryId: g.id, label: giftLabel(g) })),
      };
    }
    case 'winner': {
      const a = await award(step.boardKey);
      const gs = await giftsOf(a?.winners ?? []);
      return {
        type: 'winner',
        boardKey: step.boardKey,
        name: await catName(step.boardKey),
        grand: step.grand,
        tied: gs.length > 1,
        winners: await Promise.all(
          gs.map(async (g) => ({
            entryId: g.id,
            label: giftLabel(g),
            giver: await person(db, g.giverId),
          })),
        ),
      };
    }
    case 'achievement': {
      const a = await award(step.boardKey);
      const gs = await giftsOf(a?.winners ?? []);
      return {
        type: 'achievement',
        achievementKey: step.achievementKey,
        recipients: await Promise.all(gs.map((g) => person(db, g.giverId))),
      };
    }
    case 'spirit':
      return { type: 'spirit', recipientCount: (await spiritIds(db, e.id)).length };
    case 'champion':
      return { type: 'champion', person: await person(db, step.participantId ?? '') };
  }
}
