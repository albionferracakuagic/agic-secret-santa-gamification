import { describe, expect, it } from 'vitest';
import { canPublish, fingerprint, type PublishConfig, type Score } from './ranking.js';

/**
 * Brute-force ballot-deduction check (ADR-0003).
 * Model: n voters (voter 0 = attacker, knows own ballot), m candidate entries, each voter picks one.
 * For every published projection and attacker ballot, enumerate ALL consistent ballot assignments;
 * the policy is violated if some other voter's choice is identical in all of them (uniquely deducible).
 * Limits: final (single) projection only; timing correlation across live publications is the
 * accepted residual risk in ADR-0003. Own-gift voting restriction is not modelled (only helps attacker
 * if it exists; revisit when voting rules are fixed).
 */
function deducibleVoters(n: number, m: number, config: PublishConfig) {
  const digits = new Uint8Array(n);
  const counts = new Int32Array(m);
  counts[0] = n;
  const memo = new Map<number, number>();
  const projIds = new Map<string, number>();
  const masks = new Map<number, Uint16Array>();
  let publishedAssignments = 0;

  for (;;) {
    let code = 0;
    for (let e = 0; e < m; e++) code = code * (n + 1) + counts[e]!;
    let proj = memo.get(code);
    if (proj === undefined) {
      const scores: Score[] = [];
      for (let e = 0; e < m; e++) scores.push({ entryId: `e${e}`, score: counts[e]! });
      const res = canPublish({ scores, contributors: n, purpose: 'final' }, config);
      if (res.ok) {
        const fp = fingerprint(res);
        proj = projIds.get(fp) ?? projIds.size;
        projIds.set(fp, proj);
      } else proj = -1;
      memo.set(code, proj);
    }
    if (proj >= 0) {
      publishedAssignments++;
      const key = proj * m + digits[0]!;
      let mk = masks.get(key);
      if (!mk) masks.set(key, (mk = new Uint16Array(n)));
      for (let v = 1; v < n; v++) mk[v]! |= 1 << digits[v]!;
    }
    let i = n - 1;
    while (i >= 0) {
      counts[digits[i]!]!--;
      digits[i]!++;
      if (digits[i] === m) {
        digits[i] = 0;
        counts[0]!++;
        i--;
      } else {
        counts[digits[i]!]!++;
        break;
      }
    }
    if (i < 0) break;
  }

  let deducible = 0;
  for (const mk of masks.values()) {
    for (let v = 1; v < n; v++) {
      const bits = mk[v]!;
      if (bits !== 0 && (bits & (bits - 1)) === 0) deducible++;
    }
  }
  return { projections: projIds.size, publishedAssignments, deducible };
}

describe('brute-force ballot deduction', () => {
  const config: PublishConfig = { topN: 3 };

  it('cohorts 3..4 publish nothing (below voter floor)', () => {
    for (const n of [3, 4]) {
      expect(deducibleVoters(n, 4, config).projections).toBe(0);
    }
  });

  it.each([
    [4, 12],
    [5, 9],
  ])(
    'm=%i entries: no voter ballot uniquely deducible for cohorts 5..%i',
    { timeout: 120_000 },
    (m, maxN) => {
      for (let n = 5; n <= maxN; n++) {
        const r = deducibleVoters(n, m, config);
        expect(r.projections, `non-vacuous n=${n} m=${m}`).toBeGreaterThan(0);
        expect(r.deducible, `n=${n} m=${m} projections=${r.projections}`).toBe(0);
      }
    },
  );
});
