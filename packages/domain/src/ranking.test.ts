import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  canPublish,
  canPublishBallots,
  fingerprint,
  fullRanking,
  tally,
  type Ballot,
  type PublishConfig,
} from './ranking.js';

const ballots = (choices: string[]): Ballot[] =>
  choices.map((entryId, i) => ({ voterId: `v${i}`, entryId }));
const cfg: PublishConfig = { topN: 3 };
const rep = (id: string, n: number) => Array<string>(n).fill(id);

describe('canPublish floors', () => {
  it('fails below 5 distinct voters with neutral fallback', () => {
    const r = canPublishBallots(ballots(['a', 'b', 'c', 'd']), cfg);
    expect(r).toEqual({ ok: false, reason: 'insufficient_voters', fallback: 'christmas_magic' });
  });

  it('config cannot lower floors', () => {
    const r = canPublishBallots(ballots(['a', 'b', 'c', 'd']), {
      topN: 3,
      minVoters: 1,
      hiddenMin: 0,
      minTotalVotes: 0,
    });
    expect(r.ok).toBe(false);
  });

  it('safe-N keeps hiddenMin entries unpublished', () => {
    // 5 voters, 3 eligible entries -> only 1 shown
    const r = canPublishBallots(ballots(['a', 'a', 'a', 'b', 'c']), { topN: 3 });
    expect(r.ok && r.entries.map((e) => e.entryId)).toEqual(['a']);
  });

  it('fails when nothing safe to show (eligible <= hiddenMin)', () => {
    const r = canPublishBallots(ballots(['a', 'a', 'a', 'b', 'b']), cfg);
    expect(r).toMatchObject({ ok: false, reason: 'no_safe_entries' });
  });

  it('only entries with >=1 vote are eligible and no totals by default', () => {
    const r = canPublish(
      {
        scores: [
          { entryId: 'a', score: 4 },
          { entryId: 'b', score: 2 },
          { entryId: 'c', score: 1 },
          { entryId: 'd', score: 1 },
          { entryId: 'z', score: 0 },
        ],
        contributors: 8,
      },
      cfg,
    );
    expect(r.ok && r.entries).toEqual([
      { entryId: 'a', rank: 1, tied: false },
      { entryId: 'b', rank: 2, tied: false },
    ]);
  });

  it('min total votes can be stricter than floor', () => {
    const r = canPublishBallots(ballots(rep('a', 3).concat(rep('b', 2), rep('c', 2), 'd')), {
      topN: 3,
      minTotalVotes: 20,
    });
    expect(r).toMatchObject({ ok: false, reason: 'insufficient_votes' });
  });

  it('showTotals opt-in exposes scores', () => {
    const r = canPublishBallots(ballots(rep('a', 4).concat(rep('b', 2), 'c', 'd')), {
      topN: 3,
      showTotals: true,
    });
    expect(r.ok && r.entries[0]).toMatchObject({ entryId: 'a', score: 4 });
  });
});

describe('ties', () => {
  const base = [
    { entryId: 'a', score: 5 },
    { entryId: 'b', score: 3 },
    { entryId: 'c', score: 3 },
    { entryId: 'd', score: 1 },
    { entryId: 'e', score: 1 },
    { entryId: 'f', score: 1 },
  ];

  it('tie straddling cutoff is cut above the group when hiddenMin would break', () => {
    // eligible 6 -> limit 4; topN 2: group b,c would give 3 entries, within limit -> kept whole
    const kept = canPublish({ scores: base, contributors: 14 }, { topN: 2 });
    expect(kept.ok && kept.entries.map((e) => e.entryId)).toEqual(['a', 'b', 'c']);
    // eligible 4 -> limit 2: group b,c would break hiddenMin -> cut above
    const cut = canPublish({ scores: base.slice(0, 4), contributors: 12 }, { topN: 2 });
    expect(cut.ok && cut.entries.map((e) => e.entryId)).toEqual(['a']);
  });

  it('shared: tied entries share rank', () => {
    const r = canPublish({ scores: base, contributors: 14 }, { topN: 3 });
    expect(r.ok && r.entries.map((e) => [e.entryId, e.rank, e.tied])).toEqual([
      ['a', 1, false],
      ['b', 2, true],
      ['c', 2, true],
    ]);
  });

  it('secondary category breaks ties', () => {
    const r = canPublish(
      { scores: base, contributors: 14, secondary: [{ entryId: 'c', score: 2 }] },
      { topN: 3, tieBreak: 'secondary' },
    );
    expect(r.ok && r.entries.map((e) => e.entryId)).toEqual(['a', 'c', 'b']);
    expect(r.ok && r.entries.every((e) => !e.tied)).toBe(true);
  });

  it('organizer-decides: unresolved top tie blocks final publication only', () => {
    const tiedTop = [
      { entryId: 'a', score: 3 },
      { entryId: 'b', score: 3 },
      { entryId: 'c', score: 2 },
      { entryId: 'd', score: 1 },
      { entryId: 'e', score: 1 },
    ];
    const conf: PublishConfig = { topN: 1, tieBreak: 'organizer' };
    const live = canPublish({ scores: tiedTop, contributors: 10 }, conf);
    expect(live.ok && live.unresolvedTie).toBe(true);
    const final = canPublish({ scores: tiedTop, contributors: 10, purpose: 'final' }, conf);
    expect(final).toMatchObject({ ok: false, reason: 'organizer_decision_required' });
    const decided = canPublish(
      { scores: tiedTop, contributors: 10, purpose: 'final', organizerOrder: ['b'] },
      conf,
    );
    expect(decided.ok && decided.entries.map((e) => e.entryId)).toEqual(['b']);
  });
});

describe('helpers', () => {
  it('tally keeps one active ballot per voter', () => {
    const t = tally([
      { voterId: 'v1', entryId: 'a' },
      { voterId: 'v1', entryId: 'b' },
    ]);
    expect(t.contributors).toBe(1);
    expect(t.scores).toEqual([{ entryId: 'b', score: 1 }]);
  });

  it('fullRanking includes everyone (unmasked only) and fingerprint tracks changes', () => {
    expect(
      fullRanking([
        { entryId: 'a', score: 1 },
        { entryId: 'b', score: 2 },
      ]).map((e) => e.entryId),
    ).toEqual(['b', 'a']);
    const a = canPublishBallots(ballots(['a', 'a', 'a', 'b', 'c', 'd']), cfg);
    const b = canPublishBallots(ballots(['a', 'a', 'b', 'b', 'b', 'c', 'd']), cfg);
    expect(fingerprint(a)).not.toEqual(fingerprint(b));
  });
});

describe('properties', () => {
  const arbBallots = fc
    .array(fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f', 'g'), { minLength: 0, maxLength: 40 })
    .map(ballots);
  const arbCfg = fc.record({
    topN: fc.integer({ min: 0, max: 6 }),
    hiddenMin: fc.option(fc.integer({ min: 0, max: 4 }), { nil: undefined }),
    tieBreak: fc.constantFrom('shared' as const, 'secondary' as const, 'organizer' as const),
  });

  it('never exposes last place, ranks beyond topN, totals, or non-eligible entries', () => {
    fc.assert(
      fc.property(arbBallots, arbCfg, (bs, c) => {
        const r = canPublishBallots(bs, c as PublishConfig);
        if (!r.ok) return true;
        const { scores, contributors } = tally(bs);
        const eligible = scores.filter((s) => s.score > 0).length;
        const lowest = Math.min(...scores.map((s) => s.score));
        const lastPlace = scores.filter((s) => s.score === lowest).map((s) => s.entryId);
        expect(contributors).toBeGreaterThanOrEqual(5);
        expect(r.entries.length).toBeLessThanOrEqual(eligible - 2);
        expect(Math.max(...r.entries.map((e) => e.rank))).toBeLessThanOrEqual(c.topN);
        expect(r.entries.every((e) => !('score' in e))).toBe(true);
        // last place only ever visible if everyone is tied for it as top, impossible with hiddenMin >= 2
        expect(
          r.entries.some(
            (e) =>
              lastPlace.includes(e.entryId) && lowest < Math.max(...scores.map((s) => s.score)),
          ),
        ).toBe(false);
        return true;
      }),
      { numRuns: 500 },
    );
  });

  it('is deterministic and recomputes on vote change', () => {
    fc.assert(
      fc.property(
        arbBallots,
        fc.nat(39),
        fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f', 'g'),
        (bs, idx, to) => {
          const c: PublishConfig = { topN: 3 };
          expect(fingerprint(canPublishBallots(bs, c))).toEqual(
            fingerprint(canPublishBallots([...bs], c)),
          );
          if (bs.length === 0) return true;
          const i = idx % bs.length;
          const edited = bs.map((b, j) => (j === i ? { ...b, entryId: to } : b));
          const expected = canPublishBallots(edited, c);
          // the cached projection must equal a fresh recompute (no hidden state)
          expect(fingerprint(canPublishBallots(edited, c))).toEqual(fingerprint(expected));
          return true;
        },
      ),
    );
  });

  it('shown set is invariant to ballot order (no registration-order leak)', () => {
    fc.assert(
      fc.property(arbBallots, (bs) => {
        const c: PublishConfig = { topN: 3 };
        expect(fingerprint(canPublishBallots(bs, c))).toEqual(
          fingerprint(canPublishBallots([...bs].reverse(), c)),
        );
      }),
    );
  });
});
