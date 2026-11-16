import { describe, expect, it } from 'vitest';
import { ACHIEVEMENT_CATALOG, ACHIEVEMENT_KEYS } from '@santa/contracts';
import {
  autoAdvanceSeconds,
  buildCeremonyScript,
  spiritQualifiers,
  type AwardInput,
} from './ceremony.js';

const opts = {
  grandBoard: 'best_overall',
  countdownSeconds: 5,
  includeSpirit: true,
  includeChampion: true,
};
const a = (boardKey: string, publishable = true, hasNominees = true): AwardInput => ({
  boardKey,
  publishable,
  hasNominees,
});

describe('ceremony script', () => {
  it('orders: intro, categories, spirit, champion, GRAND CHAMPION last, outro', () => {
    const s = buildCeremonyScript([a('best_overall'), a('funniest'), a('most_creative')], opts);
    const types = s.map((x) => x.type);
    expect(types[0]).toBe('intro');
    expect(types.at(-1)).toBe('outro');
    const grandIdx = s.findIndex((x) => x.type === 'category' && x.grand);
    expect(grandIdx).toBeGreaterThan(s.findIndex((x) => x.type === 'champion'));
    expect(s.filter((x) => x.type === 'winner' && x.grand)).toHaveLength(1);
    expect(
      s.filter((x) => x.type === 'winner').map((x) => (x as { boardKey: string }).boardKey),
    ).toEqual(['funniest', 'most_creative', 'best_overall']);
    expect(
      s
        .filter((x) => x.type === 'achievement')
        .map((x) => (x as { achievementKey: string }).achievementKey),
    ).toEqual(['comedy_santa', 'creative_elf', 'legendary_santa']);
  });

  it('unsafe categories become a single neutral skip: no nominees, winner or achievement', () => {
    const s = buildCeremonyScript([a('funniest', false), a('best_overall', false)], opts);
    expect(s.filter((x) => x.type === 'category_skipped')).toHaveLength(2);
    expect(s.some((x) => ['nominees', 'winner', 'achievement', 'countdown'].includes(x.type))).toBe(
      false,
    );
  });

  it('nominees step only when canPublish produced leading gifts; countdown is the only auto-advancing step', () => {
    const s = buildCeremonyScript([a('funniest', true, false)], {
      ...opts,
      includeSpirit: false,
      includeChampion: false,
    });
    expect(s.some((x) => x.type === 'nominees')).toBe(false);
    expect(s.map(autoAdvanceSeconds).filter((x) => x !== null)).toEqual([5]);
  });

  it('works without a grand board (skipped) and without optional steps', () => {
    const s = buildCeremonyScript([a('funniest')], {
      ...opts,
      includeSpirit: false,
      includeChampion: false,
    });
    expect(s.some((x) => x.type === 'category' && x.grand)).toBe(false);
    expect(s.some((x) => x.type === 'spirit' || x.type === 'champion')).toBe(false);
  });
});

describe('achievements', () => {
  it('catalog has EN+IT texts, unique keys and the plan set; every default category maps to one', () => {
    expect(new Set(ACHIEVEMENT_KEYS).size).toBe(ACHIEVEMENT_KEYS.length);
    for (const k of [
      'legendary_santa',
      'creative_elf',
      'comedy_santa',
      'heart_of_christmas',
      'christmas_champion',
      'christmas_spirit',
      'biggest_surprise',
      'best_presentation',
    ]) {
      expect(ACHIEVEMENT_KEYS).toContain(k);
    }
    for (const d of ACHIEVEMENT_CATALOG) {
      expect(d.name.en && d.name.it && d.description.en && d.description.it).toBeTruthy();
    }
  });

  it('Christmas Spirit needs every participation activity and ignores non-qualifying XP', () => {
    const row = (participantId: string, rewardKey: string, qualifying = true) => ({
      participantId,
      rewardKey,
      qualifying,
    });
    const rows = [
      row('A', 'joined'),
      row('A', 'gift_registered'),
      row('A', 'voted'),
      row('B', 'joined'),
      row('B', 'gift_registered'),
      row('C', 'joined'),
      row('C', 'gift_registered'),
      row('C', 'voted', false),
    ];
    expect(spiritQualifiers(rows)).toEqual(['A']);
  });
});
