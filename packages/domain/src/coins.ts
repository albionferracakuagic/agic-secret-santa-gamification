import type { AuctionRules, CoinRules } from '@santa/contracts';

/** Coin earn rules keyed by the XP activity that triggered them (FR-033). Anything else earns nothing. */
export const COIN_ACTIVITIES = [
  'game_play',
  'game_win',
  'mission_completed',
  'guess_correct',
  'achievement_unlock',
] as const satisfies ReadonlyArray<keyof CoinRules>;
export type CoinActivity = (typeof COIN_ACTIVITIES)[number];

const isCoinActivity = (a: string): a is CoinActivity =>
  (COIN_ACTIVITIES as readonly string[]).includes(a);

/** Coins for an activity (0 when the activity is not a coin source or the rule is off). */
export function coinsForActivity(activity: string, rules: CoinRules): number {
  return isCoinActivity(activity) ? rules[activity] : 0;
}

/** Server-derived idempotency key: one payout per XP award, never taken from a request. */
export const coinRewardKey = (xpRewardKey: string) => `xp:${xpRewardKey}`;

/** Organizer grants: one payout per (grant key, participant). */
export const grantRewardKey = (grantKey: string) => `grant:${grantKey}`;

export const bidHoldKey = (bidId: string) => `hold:${bidId}`;
export const bidReleaseKey = (bidId: string) => `release:${bidId}`;

/** What the next bid must reach: the prize minimum on the first bid, current + increment afterwards. */
export function minNextBid(p: {
  currentBid: number | null;
  minBid: number;
  rules: Pick<AuctionRules, 'minIncrement'>;
}): number {
  return p.currentBid === null ? p.minBid : p.currentBid + p.rules.minIncrement;
}

export interface SnipeInput {
  now: Date;
  endsAt: Date;
  extensions: number;
  rules: Pick<AuctionRules, 'antiSnipeSeconds' | 'extensionSeconds' | 'maxExtensions'>;
}

/** Anti-snipe: a bid inside the closing window pushes the deadline (bounded by `maxExtensions`). */
export function antiSnipe(i: SnipeInput): { endsAt: Date; extended: boolean } {
  const { antiSnipeSeconds, extensionSeconds, maxExtensions } = i.rules;
  const inWindow = antiSnipeSeconds > 0 && i.endsAt.getTime() - i.now.getTime() <= antiSnipeSeconds * 1000;
  if (!inWindow || i.extensions >= maxExtensions) return { endsAt: i.endsAt, extended: false };
  return { endsAt: new Date(i.endsAt.getTime() + extensionSeconds * 1000), extended: true };
}
