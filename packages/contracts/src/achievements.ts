import { z } from 'zod';
import { IsoDateSchema } from './common.js';

export type AchievementKind =
  | 'category_winner'
  | 'participation'
  | 'xp_champion'
  /** Phase 2: rank-1 of a canPublish-gated board (Santa Detective, Invisible Santa, Mission Master, game winner). */
  | 'published_winner';

export interface AchievementDef {
  key: string;
  kind: AchievementKind;
  /** Voting category whose (locked, publishable) winner earns it. */
  categoryKey?: string;
  name: { en: string; it: string };
  description: { en: string; it: string };
}

/**
 * MVP achievement catalog (FR-021). Vote-derived ones come only from awards that passed canPublish() and
 * unlock at the ceremony step, never earlier. Christmas Champion uses qualifying XP (no vote leak).
 */
export const ACHIEVEMENT_CATALOG: readonly AchievementDef[] = [
  {
    key: 'legendary_santa',
    kind: 'category_winner',
    categoryKey: 'best_overall',
    name: { en: 'Legendary Santa', it: 'Babbo Natale Leggendario' },
    description: { en: 'Won Best Overall Gift', it: 'Ha vinto Miglior Regalo in Assoluto' },
  },
  {
    key: 'creative_elf',
    kind: 'category_winner',
    categoryKey: 'most_creative',
    name: { en: 'Creative Elf', it: 'Elfo Creativo' },
    description: { en: 'Won Most Creative Gift', it: 'Ha vinto Regalo Più Creativo' },
  },
  {
    key: 'comedy_santa',
    kind: 'category_winner',
    categoryKey: 'funniest',
    name: { en: 'Comedy Santa', it: 'Babbo Natale Comico' },
    description: { en: 'Won Funniest Gift', it: 'Ha vinto Regalo Più Divertente' },
  },
  {
    key: 'heart_of_christmas',
    kind: 'category_winner',
    categoryKey: 'most_thoughtful',
    name: { en: 'Heart of Christmas', it: 'Cuore del Natale' },
    description: { en: 'Won Most Thoughtful Gift', it: 'Ha vinto Regalo Più Premuroso' },
  },
  {
    key: 'biggest_surprise',
    kind: 'category_winner',
    categoryKey: 'biggest_surprise',
    name: { en: 'Master of Surprise', it: 'Maestro della Sorpresa' },
    description: { en: 'Won Biggest Surprise', it: 'Ha vinto Più Sorprendente' },
  },
  {
    key: 'best_presentation',
    kind: 'category_winner',
    categoryKey: 'best_presentation',
    name: { en: 'Gift Wrap Wizard', it: 'Mago della Confezione' },
    description: { en: 'Won Best Presentation', it: 'Ha vinto Miglior Confezione' },
  },
  {
    key: 'christmas_champion',
    kind: 'xp_champion',
    name: { en: 'Christmas Champion', it: 'Campione di Natale' },
    description: { en: 'Highest qualifying XP', it: 'Più XP qualificanti' },
  },
  {
    key: 'christmas_spirit',
    kind: 'participation',
    name: { en: 'Christmas Spirit', it: 'Spirito Natalizio' },
    description: { en: 'Joined in on every activity', it: 'Ha partecipato a tutte le attività' },
  },
  /* Phase 2 (FR-027/030/031). Winners come only from canPublish()-published rank 1; badges are participation. */
  {
    key: 'santa_detective',
    kind: 'published_winner',
    name: { en: 'Santa Detective', it: 'Detective di Babbo Natale' },
    description: {
      en: 'Unmasked the most secret Santas',
      it: 'Ha smascherato più Babbo Natale segreti',
    },
  },
  {
    key: 'invisible_santa',
    kind: 'published_winner',
    name: { en: 'Invisible Santa', it: 'Babbo Natale Invisibile' },
    description: {
      en: 'Nobody guessed who gave this gift',
      it: 'Nessuno ha indovinato chi ha fatto questo regalo',
    },
  },
  {
    key: 'mission_master',
    kind: 'published_winner',
    name: { en: 'Mission Master', it: 'Maestro delle Missioni' },
    description: {
      en: 'Completed the most secret missions',
      it: 'Ha completato più missioni segrete',
    },
  },
  {
    key: 'game_champion',
    kind: 'published_winner',
    name: { en: 'Game Champion', it: 'Campione dei Giochi' },
    description: { en: 'Won a mini-game', it: 'Ha vinto un mini-gioco' },
  },
  {
    key: 'game_night',
    kind: 'participation',
    name: { en: 'Game Night', it: 'Serata di Giochi' },
    description: { en: 'Played a mini-game', it: 'Ha giocato a un mini-gioco' },
  },
  {
    key: 'game_marathon',
    kind: 'participation',
    name: { en: 'Game Marathon', it: 'Maratona di Giochi' },
    description: { en: 'Played three mini-games', it: 'Ha giocato a tre mini-giochi' },
  },
];
export const ACHIEVEMENT_KEYS = ACHIEVEMENT_CATALOG.map((a) => a.key);

/** GET /api/me/achievements: own unlocked achievements (after the ceremony step that announced them). */
export const MyAchievementsResponseSchema = z.strictObject({
  achievements: z.array(z.strictObject({ key: z.string(), unlockedAt: IsoDateSchema })),
});
