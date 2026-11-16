export const MIN_VOTERS_FLOOR = 5;
export const HIDDEN_MIN_FLOOR = 2;
export const MIN_TOTAL_VOTES_FLOOR = 5;

export type TieBreak = 'shared' | 'secondary' | 'organizer';
export type PublishPurpose = 'live' | 'final';

export interface PublishConfig {
  topN: number;
  hiddenMin?: number;
  minVoters?: number;
  minTotalVotes?: number;
  tieBreak?: TieBreak;
  showTotals?: boolean;
}

export interface Score {
  entryId: string;
  score: number;
}

export interface Ballot {
  voterId: string;
  entryId: string;
}

export interface ScoreInput {
  scores: readonly Score[];
  /** Distinct voters (ballots) or distinct participants contributing to the metric. */
  contributors: number;
  /** Secondary-category scores, used when tieBreak = 'secondary'. */
  secondary?: readonly Score[];
  /** Entry ids in organizer-chosen precedence, used when tieBreak = 'organizer'. */
  organizerOrder?: readonly string[];
  purpose?: PublishPurpose;
}

export interface PublishedEntry {
  entryId: string;
  rank: number;
  tied: boolean;
  score?: number;
}

export type FallbackReason =
  'insufficient_voters' | 'insufficient_votes' | 'no_safe_entries' | 'organizer_decision_required';

export type PublishResult =
  | { ok: true; entries: PublishedEntry[]; unresolvedTie: boolean }
  | { ok: false; reason: FallbackReason; fallback: 'christmas_magic' };

const fail = (reason: FallbackReason): PublishResult => ({
  ok: false,
  reason,
  fallback: 'christmas_magic',
});

export function tally(ballots: readonly Ballot[]): { scores: Score[]; contributors: number } {
  const byVoter = new Map<string, string>();
  for (const b of ballots) byVoter.set(b.voterId, b.entryId);
  const counts = new Map<string, number>();
  for (const entryId of byVoter.values()) counts.set(entryId, (counts.get(entryId) ?? 0) + 1);
  return {
    scores: [...counts].map(([entryId, score]) => ({ entryId, score })),
    contributors: byVoter.size,
  };
}

/**
 * Single publication policy for ALL vote-derived output (ADR-0003).
 * Pure: output depends only on inputs. Floors are non-overridable (config can only be stricter).
 */
export function canPublish(input: ScoreInput, config: PublishConfig): PublishResult {
  const hiddenMin = Math.max(config.hiddenMin ?? 0, HIDDEN_MIN_FLOOR);
  const minVoters = Math.max(config.minVoters ?? 0, MIN_VOTERS_FLOOR);
  const minTotalVotes = Math.max(config.minTotalVotes ?? 0, MIN_TOTAL_VOTES_FLOOR);
  const tieBreak = config.tieBreak ?? 'shared';
  const purpose = input.purpose ?? 'live';

  if (input.contributors < minVoters) return fail('insufficient_voters');

  const eligible = input.scores.filter((s) => s.score > 0);
  const total = eligible.reduce((sum, s) => sum + s.score, 0);
  if (total < minTotalVotes) return fail('insufficient_votes');

  const topN = Math.floor(config.topN);
  const limit = Math.max(0, eligible.length - hiddenMin);
  const maxShown = Math.max(0, Math.min(topN, limit));
  if (maxShown === 0) return fail('no_safe_entries');

  const secondary = new Map(input.secondary?.map((s) => [s.entryId, s.score]));
  const order = new Map(input.organizerOrder?.map((id, i) => [id, i]));
  const key = (s: Score): [number, number, number] => [
    s.score,
    tieBreak === 'secondary' ? (secondary.get(s.entryId) ?? 0) : 0,
    tieBreak === 'organizer' ? -(order.get(s.entryId) ?? Number.MAX_SAFE_INTEGER) : 0,
  ];
  const cmp = (a: Score, b: Score) => {
    const ka = key(a);
    const kb = key(b);
    return kb[0] - ka[0] || kb[1] - ka[1] || kb[2] - ka[2] || (a.entryId < b.entryId ? -1 : 1);
  };
  const sameTier = (a: Score, b: Score) => key(a).every((v, i) => v === key(b)[i]);

  const sorted = [...eligible].sort(cmp);
  const tiers: Score[][] = [];
  for (const s of sorted) {
    const last = tiers.at(-1);
    if (last && sameTier(last[0]!, s)) last.push(s);
    else tiers.push([s]);
  }

  const shown: PublishedEntry[] = [];
  let unresolvedTie = false;
  for (const [i, tier] of tiers.entries()) {
    const fits = shown.length + tier.length <= maxShown;
    // A tie straddling the topN cutoff is kept whole only if hiddenMin stays satisfied.
    const extendsTie = shown.length < topN && shown.length + tier.length <= limit;
    if (!fits && !extendsTie) break;
    for (const s of tier) {
      shown.push({
        entryId: s.entryId,
        rank: i + 1,
        tied: tier.length > 1,
        ...(config.showTotals ? { score: s.score } : {}),
      });
    }
    if (tier.length > 1 && tieBreak === 'organizer') unresolvedTie = true;
  }

  if (shown.length === 0) return fail('no_safe_entries');
  if (
    purpose === 'final' &&
    tieBreak === 'organizer' &&
    shown.some((e) => e.rank === 1 && e.tied)
  ) {
    return fail('organizer_decision_required');
  }
  return { ok: true, entries: shown, unresolvedTie };
}

export function canPublishBallots(
  ballots: readonly Ballot[],
  config: PublishConfig,
  extra: Pick<ScoreInput, 'secondary' | 'organizerOrder' | 'purpose'> = {},
): PublishResult {
  return canPublish({ ...tally(ballots), ...extra }, config);
}

/** Organizer-unmasked only: full ranking incl. every entry. Never route to other roles. */
export function fullRanking(scores: readonly Score[]): Array<Required<PublishedEntry>> {
  const sorted = [...scores].sort((a, b) => b.score - a.score || (a.entryId < b.entryId ? -1 : 1));
  return sorted.map((s) => {
    const rank = sorted.findIndex((o) => o.score === s.score) + 1;
    return {
      entryId: s.entryId,
      rank,
      tied: sorted.filter((o) => o.score === s.score).length > 1,
      score: s.score,
    };
  });
}

/** Stable fingerprint used by the cadence job to detect "projection changed". */
export function fingerprint(result: PublishResult): string {
  return result.ok
    ? result.entries
        .map((e) => `${e.rank}:${e.entryId}${e.score === undefined ? '' : `=${e.score}`}`)
        .join('|')
    : `fail:${result.reason}`;
}
