import type { Phase, SpotlightKind } from '@santa/contracts';
import type { XpAward } from './xp.js';

/** Guesses and clues: from the first opened gift until that gift's giver is revealed. */
export const GUESS_PHASES: readonly Phase[] = ['gift_opening', 'voting', 'games', 'reveal'];
/** Missions are handed out while the party is on and can be completed until the awards start. */
export const MISSION_ASSIGN_PHASES: readonly Phase[] = [
  'gift_registration',
  'gift_opening',
  'voting',
  'games',
];
export const MISSION_SUBMIT_PHASES: readonly Phase[] = [
  'gift_registration',
  'gift_opening',
  'voting',
  'games',
  'reveal',
  'awards',
];
/** Mini-games run in the `games` phase only. */
export const GAMES_PHASE: Phase = 'games';

/** Guess boards need revealed gifts; the mission board is available from the games phase. */
export const PRESENT_PHASES: Record<SpotlightKind, readonly Phase[]> = {
  santa_detective: ['reveal', 'awards', 'completed'],
  invisible_santa: ['reveal', 'awards', 'completed'],
  mission_master: ['games', 'reveal', 'awards', 'completed'],
};

/** Phase 2 XP is always non-qualifying: guesses/games/missions must not leak into Christmas Champion. */
export const planPhase2Award = (
  activity: Extract<
    XpAward['activity'],
    'guess_correct' | 'mission_completed' | 'game_play' | 'game_win'
  >,
  amount: number,
  rewardKey: string,
): XpAward => ({ activity, amount, rewardKey, qualifying: false });
