import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  BINGO_BANK,
  BINGO_FREE_CELL,
  MISSION_CATALOG,
  TRIVIA_BANK,
  bingoLines,
  buildGiftRounds,
  buildMysteryRounds,
  buildSpeedRounds,
  buildTriviaRounds,
  choicePoints,
  detectiveScores,
  generateBingoCard,
  giftHint,
  invisibleSantaScores,
  mulberry32,
  planMissionAssignments,
  publishPeopleBoard,
  screenClue,
  speedPoints,
  suspectsFor,
} from './index.js';

const person = (id: string, displayName: string, status = 'active' as const) => ({
  id,
  displayName,
  status,
});

describe('suspects (FR-025)', () => {
  it('lists every active participant except self, alphabetically', () => {
    const people = [
      person('1', 'zoe'),
      person('2', 'Anna'),
      person('3', 'bruno'),
      person('4', 'Carla', 'removed' as never),
      person('5', 'Dario', 'pending' as never),
    ];
    expect(suspectsFor(people, '3').map((p) => p.displayName)).toEqual(['Anna', 'zoe']);
    expect(suspectsFor(people, '1').map((p) => p.id)).toEqual(['2', '3']);
  });
});

describe('clue screening (EN/IT keyword filter)', () => {
  it.each([
    ['You are such an idiot', 'blocked_word'],
    ['che stronzata di regalo', 'blocked_word'],
    ["it's me, obviously", 'reveals_giver'],
    ['sono io!!', 'reveals_giver'],
    ['Call 3331234567 now', 'contact_details'],
    ['mail me at a@b.it', 'contact_details'],
    ['Marco would love this', 'reveals_giver'],
  ])('rejects %s', (text, reason) => {
    expect(screenClue(text, { giverName: 'Marco Rossi' })).toEqual({ ok: false, reason });
  });
  it('accepts friendly clues and does not trip on innocent words', () => {
    for (const t of [
      'Likes cooking and long walks',
      'Ama il Natale e il cioccolato',
      'Fan of Dickens and old movies',
      'Brought a smile to my class',
    ])
      expect(screenClue(t, { giverName: 'Marco' })).toEqual({ ok: true });
  });
  it('sees through simple obfuscation', () => {
    expect(screenClue('what an 1d1ot')).toMatchObject({ ok: false });
    expect(screenClue('stroooonzo')).toMatchObject({ ok: false });
  });
});

describe('publishPeopleBoard goes through canPublish (FR-046)', () => {
  const scores = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ entryId: `p${i}`, score: n - i }));
  it('needs >=5 distinct contributors, whatever the config asks', () => {
    expect(publishPeopleBoard(scores(8), 4, { topN: 3, minContributors: 1 })).toMatchObject({
      ok: false,
      reason: 'insufficient_voters',
    });
    expect(publishPeopleBoard(scores(8), 5, { topN: 3, minContributors: 1 }).ok).toBe(true);
  });
  it('property: top-N only, rank 1.., no totals, hidden tail kept, never the last entry', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 9 }), { minLength: 2, maxLength: 15 }),
        fc.integer({ min: 5, max: 20 }),
        fc.integer({ min: 1, max: 10 }),
        (raw, contributors, topN) => {
          const s = raw.map((score, i) => ({ entryId: `e${i}`, score }));
          const r = publishPeopleBoard(s, contributors, { topN, minContributors: 5 });
          if (!r.ok) return;
          expect(r.entries.length).toBeLessThanOrEqual(Math.max(topN, s.length));
          expect(s.length - r.entries.length).toBeGreaterThanOrEqual(2);
          for (const e of r.entries) {
            expect(e).not.toHaveProperty('score');
            expect(e.rank).toBeGreaterThanOrEqual(1);
          }
        },
      ),
    );
  });
  it('detective: scores correct guesses per guesser; guessers include the zero-scorers', () => {
    const g = (guesserId: string, correct: boolean, giftId = 'g1') => ({
      giftId,
      giverId: 'x',
      guesserId,
      correct,
    });
    const r = detectiveScores([g('a', true), g('a', true, 'g2'), g('b', false), g('c', true)]);
    expect(r.contributors).toBe(3);
    expect(Object.fromEntries(r.scores.map((s) => [s.entryId, s.score]))).toEqual({ a: 2, c: 1 });
  });
  it('invisible santa: only givers of guessed gifts nobody got right', () => {
    const g = (giftId: string, giverId: string, guesserId: string, correct: boolean) => ({
      giftId,
      giverId,
      guesserId,
      correct,
    });
    const r = invisibleSantaScores([
      g('g1', 'ann', 'a', false),
      g('g1', 'ann', 'b', false),
      g('g2', 'bob', 'a', false),
      g('g2', 'bob', 'c', true),
      g('g3', 'cy', 'a', true),
    ]);
    expect(r.scores).toEqual([{ entryId: 'ann', score: 2 }]);
    expect(r.contributors).toBe(3);
  });
});

describe('missions catalog (FR-028)', () => {
  it('has >=20 unique EN/IT entries', () => {
    expect(MISSION_CATALOG.length).toBeGreaterThanOrEqual(20);
    expect(new Set(MISSION_CATALOG.map((m) => m.key)).size).toBe(MISSION_CATALOG.length);
    for (const m of MISSION_CATALOG) {
      expect(m.title.en && m.title.it && m.description.en && m.description.it).toBeTruthy();
      // safe/inclusive/voluntary: nothing physical, no alcohol, no appearance/age/money
      const text = `${m.title.en} ${m.description.en}`.toLowerCase();
      for (const bad of ['hug', 'kiss', 'drink', 'alcohol', 'dance', 'age', 'weight', 'salary'])
        expect(text).not.toMatch(new RegExp(`\\b${bad}\\b`));
    }
  });
  it('tops up to N distinct missions per person and never repeats one', () => {
    const rng = mulberry32(7);
    const ids = ['a', 'b', 'c'];
    const first = planMissionAssignments(ids, 2, new Map(), new Map(), rng);
    expect(first).toHaveLength(6);
    for (const id of ids) {
      const keys = first.filter((x) => x.participantId === id).map((x) => x.missionKey);
      expect(new Set(keys).size).toBe(2);
    }
    const used = new Map(
      ids.map((id) => [
        id,
        new Set(first.filter((x) => x.participantId === id).map((x) => x.missionKey)),
      ]),
    );
    const topUp = planMissionAssignments(ids, 2, used, new Map(ids.map((id) => [id, 2])), rng);
    expect(topUp).toHaveLength(0);
  });
});

describe('mini-game engine (FR-031/032)', () => {
  it('trivia bank has >=40 EN/IT questions with 4 distinct options and a valid answer', () => {
    expect(TRIVIA_BANK.length).toBeGreaterThanOrEqual(40);
    expect(new Set(TRIVIA_BANK.map((q) => q.id)).size).toBe(TRIVIA_BANK.length);
    for (const q of TRIVIA_BANK) {
      expect(q.prompt.en && q.prompt.it).toBeTruthy();
      expect(q.options).toHaveLength(4);
      expect(new Set(q.options.map((o) => o.en)).size).toBe(4);
      expect(q.correct).toBeGreaterThanOrEqual(0);
      expect(q.correct).toBeLessThan(4);
    }
  });
  it('trivia rounds: custom first, shuffled options keep the right answer', () => {
    const rounds = buildTriviaRounds(
      3,
      [
        {
          prompt: { en: 'Capital of Italy?' },
          options: [{ en: 'Rome' }, { en: 'Milan' }],
          correctIndex: 0,
        },
      ],
      mulberry32(3),
    );
    expect(rounds).toHaveLength(3);
    expect(rounds[0]!.prompt['en']).toBe('Capital of Italy?');
    const correct = rounds[0]!.options.find((o) => o.id === rounds[0]!.correctIds[0])!;
    expect(correct.label['en']).toBe('Rome');
    const bankRound = rounds[1]!;
    const q = TRIVIA_BANK.find((x) => x.prompt.en === bankRound.prompt['en'])!;
    expect(bankRound.options.find((o) => o.id === bankRound.correctIds[0])!.label['en']).toBe(
      q.options[q.correct]!.en,
    );
  });
  it('choice points: correct 100..150 by speed, wrong 0 (no negatives)', () => {
    const base = { startMs: 0, endMs: 10_000 };
    expect(choicePoints({ ...base, correct: true, submittedAtMs: 0 })).toBe(150);
    expect(choicePoints({ ...base, correct: true, submittedAtMs: 10_000 })).toBe(100);
    expect(choicePoints({ ...base, correct: false, submittedAtMs: 1 })).toBe(0);
  });
  it('speed points: by arrival order, shared rank on exact ties, floor 10', () => {
    const p = speedPoints(
      new Map([
        ['a', 5],
        ['b', 3],
        ['c', 3],
        ['d', 9],
      ]),
    );
    expect(p.get('b')).toBe(100);
    expect(p.get('c')).toBe(100);
    expect(p.get('a')).toBe(80);
    expect(p.get('d')).toBe(70);
    const many = speedPoints(new Map(Array.from({ length: 20 }, (_, i) => [`p${i}`, i] as const)));
    expect(Math.min(...many.values())).toBe(10);
  });
  it('speed rounds have a random GO delay and no options', () => {
    const r = buildSpeedRounds(4, 20, mulberry32(1));
    expect(r).toHaveLength(4);
    for (const x of r) {
      expect(x.options).toEqual([]);
      expect(x.delayMs).toBeGreaterThanOrEqual(1000);
      expect(x.delayMs).toBeLessThanOrEqual(6000);
    }
  });
  it('guess-the-gift: hint masks the name; options are aliases incl. the target; needs 2+ gifts', () => {
    expect(giftHint('Red Scarf')).toBe('2 · R__ S____');
    const gifts = [1, 2, 3, 4, 5].map((n) => ({ id: `g${n}`, aliasNo: n, name: `Thing ${n}` }));
    const rounds = buildGiftRounds(gifts, 3, mulberry32(9));
    expect(rounds).toHaveLength(3);
    for (const r of rounds) {
      expect(r.options).toHaveLength(4);
      expect(r.options.map((o) => o.id)).toContain(r.correctIds[0]);
      expect(r.options[0]!.label['en']).toMatch(/^Gift \d$/);
    }
    expect(buildGiftRounds(gifts.slice(0, 1), 3, mulberry32(9))).toEqual([]);
  });
  it('mystery santa: options are the people, no correct answer in the payload', () => {
    const rounds = buildMysteryRounds(
      [{ id: 'g1', aliasNo: 1, name: 'x' }],
      [
        { id: 'p1', displayName: 'Ann' },
        { id: 'p2', displayName: 'Bob' },
      ],
      5,
      mulberry32(2),
    );
    expect(rounds).toHaveLength(1);
    expect(rounds[0]!.correctIds).toEqual([]);
    expect(rounds[0]!.giftId).toBe('g1');
  });
  it('bingo: 25-cell cards with a free centre, distinct squares; lines need confirmed marks', () => {
    expect(BINGO_BANK.length).toBeGreaterThanOrEqual(30);
    const card = generateBingoCard(mulberry32(5));
    expect(card).toHaveLength(25);
    expect(card[BINGO_FREE_CELL]).toBeNull();
    const squares = card.filter((c): c is number => c !== null);
    expect(new Set(squares).size).toBe(24);
    expect(bingoLines(new Set())).toBe(0);
    expect(bingoLines(new Set([10, 11, 13, 14]))).toBe(1); // middle row with the free centre
    expect(bingoLines(new Set([0, 6, 18, 24]))).toBe(1); // diagonal
  });
});
