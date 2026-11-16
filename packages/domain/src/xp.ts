/** Participation activities: once per event, qualifying for Christmas Champion (ADR-0003). */
export const XP_ACTIVITIES = ['joined', 'gift_registered', 'voted'] as const;
export type XpActivity = (typeof XP_ACTIVITIES)[number];
export type XpValues = Record<XpActivity, number>;

export interface XpAward {
  activity: XpActivity | 'achievement_unlock';
  amount: number;
  /** Unique per (event, participant): the DB constraint makes re-awarding impossible. */
  rewardKey: string;
  qualifying: boolean;
}

/** rewardKey is derived here (server-side), never taken from a request or idempotency key. */
export function planAward(activity: XpActivity, values: XpValues): XpAward {
  return { activity, amount: values[activity], rewardKey: activity, qualifying: true };
}

/** Achievement XP is non-qualifying so it cannot leak vote results into the XP champion. */
export function planAchievementAward(achievementKey: string, amount: number): XpAward {
  return {
    activity: 'achievement_unlock',
    amount,
    rewardKey: `achievement:${achievementKey}`,
    qualifying: false,
  };
}

export const levelFromXp = (xp: number) => Math.floor(Math.max(0, xp) / 100) + 1;
