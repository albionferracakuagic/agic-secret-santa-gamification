import { describe, expect, it } from 'vitest';
import { levelFromXp, planAward, planAchievementAward, XP_ACTIVITIES } from './xp.js';

const values = { joined: 10, gift_registered: 20, voted: 15 };

describe('xp plan', () => {
  it('derives rewardKey server-side: once per event for joined/gift_registered/voted', () => {
    expect(planAward('joined', values)).toEqual({
      activity: 'joined',
      amount: 10,
      rewardKey: 'joined',
      qualifying: true,
    });
    expect(planAward('gift_registered', values).rewardKey).toBe('gift_registered');
    expect(planAward('voted', values)).toMatchObject({ rewardKey: 'voted', amount: 15 });
  });

  it('participation activities qualify; achievement unlocks never do (no vote-result leak via XP)', () => {
    for (const a of XP_ACTIVITIES) expect(planAward(a, values).qualifying).toBe(true);
    expect(planAchievementAward('best_gift', 50)).toEqual({
      activity: 'achievement_unlock',
      amount: 50,
      rewardKey: 'achievement:best_gift',
      qualifying: false,
    });
  });

  it('levels are monotonic and start at 1', () => {
    expect(levelFromXp(0)).toBe(1);
    expect(levelFromXp(99)).toBe(1);
    expect(levelFromXp(100)).toBe(2);
    expect(levelFromXp(1000)).toBeGreaterThan(levelFromXp(999));
  });
});
