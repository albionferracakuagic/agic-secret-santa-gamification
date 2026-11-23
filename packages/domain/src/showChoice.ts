import type { ShowChoiceOption, ShowChoiceResult } from '@santa/contracts';
import { MIN_VOTERS_FLOOR } from './ranking.js';

export interface ShowChoiceBallot {
  voterId: string;
  choice: ShowChoiceOption;
}

/**
 * Snowstorm vs Sleigh Bells outcome (pure). Only the outcome ever leaves the server, never counts or voters.
 * FR-013: fewer distinct voters than max(minVoters, MIN_VOTERS_FLOOR) => `none`; a tie => `none`; no votes => `none`.
 * The three `none` causes are deliberately indistinguishable (a tie would otherwise leak "at least two voters").
 * One ballot per voter (the DB enforces it; duplicates here keep the first).
 */
export function decideShowChoice(
  ballots: readonly ShowChoiceBallot[],
  minVoters = MIN_VOTERS_FLOOR,
): ShowChoiceResult {
  const byVoter = new Map<string, ShowChoiceOption>();
  for (const b of ballots) if (!byVoter.has(b.voterId)) byVoter.set(b.voterId, b.choice);
  if (byVoter.size < Math.max(minVoters, MIN_VOTERS_FLOOR)) return 'none';
  let snow = 0;
  let bells = 0;
  for (const c of byVoter.values())
    if (c === 'snowstorm') snow++;
    else bells++;
  if (snow === bells) return 'none';
  return snow > bells ? 'snowstorm' : 'sleigh_bells';
}
