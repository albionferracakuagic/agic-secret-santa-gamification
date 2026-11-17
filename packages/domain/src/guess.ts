import { HIDDEN_MIN_FLOOR, canPublish, type PublishResult, type Score } from './ranking.js';

/* ---------- FR-025: suspects ---------- */

export interface SuspectSource {
  id: string;
  displayName: string;
  status: 'unclaimed' | 'pending' | 'active' | 'removed';
}

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

/** Every active participant except the guesser, alphabetical (stable: ties broken by id). */
export function suspectsFor<T extends SuspectSource>(people: readonly T[], selfId: string): T[] {
  return people
    .filter((p) => p.status === 'active' && p.id !== selfId)
    .sort((a, b) => collator.compare(a.displayName, b.displayName) || (a.id < b.id ? -1 : 1));
}

/* ---------- FR-025: clue screening (EN/IT keyword filter) ---------- */

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[0@]/g, (c) => (c === '0' ? 'o' : 'a'))
    .replace(/1/g, 'i')
    .replace(/3/g, 'e')
    .replace(/[4]/g, 'a')
    .replace(/[5$]/g, 's')
    .replace(/(.)\1{2,}/g, '$1');

/** Word stems: a token is blocked when it starts with one of them. Deliberately conservative. */
const BLOCKED_STEMS = [
  // EN
  'fuck',
  'shit',
  'bitch',
  'bastard',
  'asshole',
  'cunt',
  'slut',
  'whore',
  'idiot',
  'stupid',
  'moron',
  'loser',
  'ugly',
  'fatso',
  'retard',
  'nigg',
  'fagg',
  'crap',
  'damn',
  'hate',
  'kill',
  'sucks',
  'boob',
  'porn',
  // IT
  'cazz',
  'merd',
  'stronz',
  'vaffa',
  'puttan',
  'troia',
  'coglion',
  'minchi',
  'scem',
  'cretin',
  'deficient',
  'brutt',
  'ciccion',
  'odio',
  'ammazz',
  'morir',
  'cacca',
  'fottut',
  'figa',
  'sesso',
  'zoccol',
];
// short or ambiguous words ("Dickens", "class") must match a whole token
const WHOLE_TOKENS = new Set(['die', 'sex', 'dick', 'ass', 'tit', 'tits', 'cum', 'fag']);
const SELF_REVEAL =
  /\b(i am|i m|it is me|this is me|it s me|its me|its mine|this is mine|sono io|sono stato io|sono stata io|l ho fatto io|l ho preso io|e mio|e stato mio|e di me)\b/;
const CONTACT = /https?:|www\.|\.com\b|\.it\b|\b\d{6,}\b/;

export type ClueScreening =
  { ok: true } | { ok: false; reason: 'blocked_word' | 'reveals_giver' | 'contact_details' };

/**
 * Keyword filter for giver clues (EN/IT). Rejects insults/profanity, direct self-reveal ("it's me"), the giver's
 * own name, and contact details. Whatever passes still waits in the organizer's moderation queue.
 */
export function screenClue(text: string, opts: { giverName?: string } = {}): ClueScreening {
  const folded = fold(text).replace(/'/g, ' ');
  if (CONTACT.test(text.toLowerCase()) || text.includes('@'))
    return { ok: false, reason: 'contact_details' };
  const tokens = folded.split(/[^a-z]+/).filter(Boolean);
  if (tokens.some((t) => WHOLE_TOKENS.has(t) || BLOCKED_STEMS.some((s) => t.startsWith(s))))
    return { ok: false, reason: 'blocked_word' };
  if (SELF_REVEAL.test(folded)) return { ok: false, reason: 'reveals_giver' };
  const nameTokens = fold(opts.giverName ?? '')
    .split(/[^a-z]+/)
    .filter((t) => t.length >= 3);
  if (nameTokens.some((n) => tokens.includes(n))) return { ok: false, reason: 'reveals_giver' };
  return { ok: true };
}

/* ---------- publication of guess/mission-derived boards (always canPublish) ---------- */

export interface PeopleBoardConfig {
  topN: number;
  hiddenMin?: number;
  /** Distinct contributors required (guessers / completers / players); never below the global floor of 5. */
  minContributors: number;
}

/**
 * Single entry point for every Phase 2 "who is best at X" output (Santa Detective, Invisible Santa, Mission
 * Master, game winners). Delegates to canPublish(): >=5 contributors, top-N only, hidden tail, shared ties, no
 * totals, no rank beyond the published set. Entry ids are participant ids.
 */
export function publishPeopleBoard(
  scores: readonly Score[],
  contributors: number,
  cfg: PeopleBoardConfig,
): PublishResult {
  return canPublish(
    { scores, contributors, purpose: 'live' },
    {
      topN: cfg.topN,
      hiddenMin: Math.max(cfg.hiddenMin ?? 0, HIDDEN_MIN_FLOOR),
      minVoters: cfg.minContributors,
      tieBreak: 'shared',
    },
  );
}

export interface SettledGuess {
  giftId: string;
  giverId: string;
  guesserId: string;
  correct: boolean;
}

/** Santa Detective: correct guesses per guesser (settled guesses only; gifts whose giver is revealed). */
export function detectiveScores(guesses: readonly SettledGuess[]) {
  const per = new Map<string, number>();
  const guessers = new Set<string>();
  for (const g of guesses) {
    guessers.add(g.guesserId);
    if (g.correct) per.set(g.guesserId, (per.get(g.guesserId) ?? 0) + 1);
  }
  return {
    scores: [...per].map(([entryId, score]) => ({ entryId, score })),
    contributors: guessers.size,
  };
}

/**
 * Invisible Santa: a giver nobody guessed. Entry = giver of a gift with >=1 guess and zero correct guesses;
 * score = number of wrong guesses it fooled. Only counts gifts that were guessed by someone else.
 */
export function invisibleSantaScores(guesses: readonly SettledGuess[]) {
  const byGift = new Map<string, { giverId: string; wrong: number; right: number }>();
  const guessers = new Set<string>();
  for (const g of guesses) {
    guessers.add(g.guesserId);
    const row = byGift.get(g.giftId) ?? { giverId: g.giverId, wrong: 0, right: 0 };
    if (g.correct) row.right++;
    else row.wrong++;
    byGift.set(g.giftId, row);
  }
  const per = new Map<string, number>();
  for (const row of byGift.values())
    if (row.right === 0 && row.wrong > 0)
      per.set(row.giverId, (per.get(row.giverId) ?? 0) + row.wrong);
  return {
    scores: [...per].map(([entryId, score]) => ({ entryId, score })),
    contributors: guessers.size,
  };
}
