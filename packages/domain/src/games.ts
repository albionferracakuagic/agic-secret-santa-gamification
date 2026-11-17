import { BINGO_BANK, TRIVIA_BANK, type L10n } from './games-content.js';

export type Rng = () => number;

/** Seedable PRNG (tests); production passes Math.random. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export interface RoundOption {
  id: string;
  label: Record<string, string>;
}

/** A round as stored server-side. `correctIds` never reaches a payload before the round closes. */
export interface RoundSpec {
  prompt: Record<string, string>;
  options: RoundOption[];
  correctIds: string[];
  /** Speed rounds: random delay before tapping opens (ms after the round starts). */
  delayMs?: number;
  /** guess_the_gift / mystery_santa: the gift this round is about. */
  giftId?: string;
}

export const DEFAULT_ROUNDS = {
  trivia: 8,
  guess_the_gift: 5,
  speed: 5,
  mystery_santa: 5,
  bingo: 1,
} as const;

export interface CustomQuestion {
  prompt: { en: string; it?: string | undefined };
  options: Array<{ en: string; it?: string | undefined }>;
  correctIndex: number;
}

const l10n = (v: { en: string; it?: string | undefined }): L10n => ({ en: v.en, it: v.it ?? v.en });

function choiceRound(prompt: L10n, options: L10n[], correct: number, rng: Rng): RoundSpec {
  const order = shuffle(
    options.map((label, i) => ({ label, i })),
    rng,
  );
  return {
    prompt: { ...prompt },
    options: order.map((x, idx) => ({ id: String(idx), label: { ...x.label } })),
    correctIds: [String(order.findIndex((x) => x.i === correct))],
  };
}

/** Organizer questions first (as written), then random bank questions; no repeats. */
export function buildTriviaRounds(
  count: number,
  custom: readonly CustomQuestion[],
  rng: Rng,
): RoundSpec[] {
  const own = custom
    .slice(0, count)
    .map((c) => choiceRound(l10n(c.prompt), c.options.map(l10n), c.correctIndex, rng));
  const bank = shuffle(TRIVIA_BANK, rng)
    .slice(0, Math.max(0, count - own.length))
    .map((x) => choiceRound(x.prompt, x.options, x.correct, rng));
  return [...own, ...bank];
}

export interface GiftLite {
  id: string;
  aliasNo: number;
  name: string;
}

/** "3 words · S___ ___ T____": first letter of each word, the rest masked. */
export function giftHint(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const masked = words.map((w) => {
    const [first = '', ...rest] = [...w];
    return /[\p{L}\p{N}]/u.test(first)
      ? first.toUpperCase() + rest.map((c) => (/[\p{L}\p{N}]/u.test(c) ? '_' : c)).join('')
      : w;
  });
  return `${words.length} · ${masked.join(' ')}`;
}

/** Guess the Gift: pick which opened gift matches the masked-name hint (options = gift aliases). */
export function buildGiftRounds(gifts: readonly GiftLite[], count: number, rng: Rng): RoundSpec[] {
  if (gifts.length < 2) return [];
  return shuffle(gifts, rng)
    .slice(0, count)
    .map((target) => {
      const decoys = shuffle(
        gifts.filter((g) => g.id !== target.id),
        rng,
      ).slice(0, 3);
      const options = shuffle([target, ...decoys], rng).map((g) => ({
        id: g.id,
        label: { en: `Gift ${g.aliasNo}`, it: `Regalo ${g.aliasNo}` },
      }));
      return {
        prompt: {
          en: `Which gift matches this hint? ${giftHint(target.name)}`,
          it: `Quale regalo corrisponde a questo indizio? ${giftHint(target.name)}`,
        },
        options,
        correctIds: [target.id],
        giftId: target.id,
      };
    });
}

export interface PersonLite {
  id: string;
  displayName: string;
}

/** Mystery Santa Predictions: who is the Santa of this gift? Correctness is settled at the giver reveal. */
export function buildMysteryRounds(
  gifts: readonly GiftLite[],
  people: readonly PersonLite[],
  count: number,
  rng: Rng,
): RoundSpec[] {
  const options = people.map((p) => ({
    id: p.id,
    label: { en: p.displayName, it: p.displayName },
  }));
  return shuffle(gifts, rng)
    .slice(0, count)
    .map((g) => ({
      prompt: {
        en: `Who is the secret Santa of Gift ${g.aliasNo}?`,
        it: `Chi è il Babbo Natale segreto del Regalo ${g.aliasNo}?`,
      },
      options,
      correctIds: [],
      giftId: g.id,
    }));
}

/** Speed Challenge: a "get ready" phase, then a random GO moment; tapping earlier is simply ignored. */
export function buildSpeedRounds(count: number, roundSeconds: number, rng: Rng): RoundSpec[] {
  const maxDelay = Math.max(1000, Math.min(6000, Math.floor((roundSeconds * 1000) / 2)));
  return Array.from({ length: count }, () => ({
    prompt: {
      en: 'Get ready… tap as soon as the star shines!',
      it: 'Pronti… tocca appena la stella si illumina!',
    },
    options: [],
    correctIds: [],
    delayMs: 1000 + Math.floor(rng() * (maxDelay - 1000 + 1)),
  }));
}

export const TRIVIA_BASE_POINTS = 100;
export const TRIVIA_SPEED_BONUS = 50;

/** Correct answer = 100 + up to 50 for speed (linear over the round). Wrong/late = 0 (never negative). */
export function choicePoints(p: {
  correct: boolean;
  submittedAtMs: number;
  startMs: number;
  endMs: number;
}): number {
  if (!p.correct) return 0;
  const span = Math.max(1, p.endMs - p.startMs);
  const left = Math.min(1, Math.max(0, (p.endMs - p.submittedAtMs) / span));
  return TRIVIA_BASE_POINTS + Math.round(TRIVIA_SPEED_BONUS * left);
}

/** Speed Challenge: arrival order after GO. Ties on the same millisecond share a rank. 100, 90, 80 ... min 10. */
export function speedPoints(arrivalsMs: ReadonlyMap<string, number>): Map<string, number> {
  const sorted = [...arrivalsMs].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
  const out = new Map<string, number>();
  let rank = 0;
  let prev = -1;
  for (const [id, t] of sorted) {
    if (t !== prev) rank = out.size;
    prev = t;
    out.set(id, Math.max(10, 100 - 10 * rank));
  }
  return out;
}

/* ---------- Bingo ---------- */

export const BINGO_SIZE = 25;
export const BINGO_FREE_CELL = 12;

/** 25 cells; index 12 is the free centre (null). Others = distinct squares from the bank. */
export function generateBingoCard(rng: Rng): Array<number | null> {
  const picks = shuffle(
    BINGO_BANK.map((_, i) => i),
    rng,
  ).slice(0, BINGO_SIZE - 1);
  const cells: Array<number | null> = [];
  let k = 0;
  for (let i = 0; i < BINGO_SIZE; i++) cells.push(i === BINGO_FREE_CELL ? null : picks[k++]!);
  return cells;
}

const LINES: number[][] = [
  ...Array.from({ length: 5 }, (_, r) => Array.from({ length: 5 }, (_, c) => r * 5 + c)),
  ...Array.from({ length: 5 }, (_, c) => Array.from({ length: 5 }, (_, r) => r * 5 + c)),
  [0, 6, 12, 18, 24],
  [4, 8, 12, 16, 20],
];

/** Completed lines (rows, columns, diagonals); the free centre always counts as marked. */
export function bingoLines(confirmed: ReadonlySet<number>): number {
  const has = (i: number) => i === BINGO_FREE_CELL || confirmed.has(i);
  return LINES.filter((line) => line.every(has)).length;
}

export const bingoScore = (confirmedMarks: number, lines: number) =>
  confirmedMarks * 10 + lines * 50;

export const bingoSquare = (index: number): L10n | undefined => BINGO_BANK[index];

export const GAME_TITLES: Record<string, L10n> = {
  trivia: { en: 'Christmas Trivia', it: 'Quiz di Natale' },
  guess_the_gift: { en: 'Guess the Gift', it: 'Indovina il Regalo' },
  bingo: { en: 'Christmas Bingo', it: 'Tombola di Natale' },
  speed: { en: 'Santa Speed Challenge', it: 'Sfida di Velocità di Babbo Natale' },
  mystery_santa: { en: 'Mystery Santa Predictions', it: 'Previsioni del Babbo Natale Misterioso' },
};

export const GAME_RULES: Record<string, L10n> = {
  trivia: {
    en: 'Answer fast: a correct answer scores 100 points plus up to 50 for speed. One answer per question.',
    it: 'Rispondi in fretta: una risposta giusta vale 100 punti più fino a 50 per la velocità. Una risposta per domanda.',
  },
  guess_the_gift: {
    en: 'Match the hint to the right gift. Faster correct answers score more.',
    it: 'Abbina l’indizio al regalo giusto. Le risposte corrette più veloci valgono di più.',
  },
  bingo: {
    en: 'Mark a square when you spot it happening. The organizer confirms your marks; lines score extra.',
    it: 'Segna una casella quando la vedi succedere. L’organizzatore conferma i segni; le linee valgono di più.',
  },
  speed: {
    en: 'Wait for the star, then tap! Early taps are ignored, so no worries. The quickest taps score most.',
    it: 'Aspetta la stella, poi tocca! I tocchi troppo presto vengono ignorati, nessun problema. I più rapidi fanno più punti.',
  },
  mystery_santa: {
    en: 'Predict who the secret Santa of each gift is. Results come when the givers are revealed.',
    it: 'Prevedi chi è il Babbo Natale segreto di ogni regalo. I risultati arrivano alla rivelazione dei donatori.',
  },
};
