/**
 * FR-036 event -> animation catalog. Every cue is celebratory: there are NO negative/failure cues
 * (FR-046.4). Each cue has an i18n text equivalent under `fx.<id>` for ARIA-live / reduced motion.
 */
export const FX_EVENTS = [
  'participant_joined',
  'gift_registered',
  'voting_started',
  'vote_submitted',
  'leaderboard_entry',
  'correct_guess',
  'achievement_earned',
  'mission_completed',
  'guess_wink',
  'mystery_reveal',
  'auction_won',
  'grand_winner',
  'reaction_received',
  'show_snowstorm',
  'show_sleigh_bells',
] as const;
export type FxEvent = (typeof FX_EVENTS)[number];

export const SFX_IDS = ['bell', 'chime', 'whoosh', 'sparkle'] as const;
export type SfxId = (typeof SFX_IDS)[number];

export type FxVisual =
  | { kind: 'emoji'; glyph: string; count: number; durationMs: number }
  | { kind: 'confetti'; count: number }
  | { kind: 'fireworks'; bursts: number };

export interface FxCue {
  id: string;
  visual: FxVisual;
  sfx?: SfxId;
}

export const FX_CATALOG = {
  participant_joined: {
    id: 'participant_joined',
    visual: { kind: 'emoji', glyph: '🎅', count: 1, durationMs: 2600 },
    sfx: 'bell',
  },
  gift_to_sleigh: {
    id: 'gift_to_sleigh',
    visual: { kind: 'emoji', glyph: '🎁', count: 1, durationMs: 2200 },
    sfx: 'whoosh',
  },
  bells: {
    id: 'bells',
    visual: { kind: 'emoji', glyph: '🔔', count: 3, durationMs: 2400 },
    sfx: 'bell',
  },
  star_up: {
    id: 'star_up',
    visual: { kind: 'emoji', glyph: '⭐', count: 1, durationMs: 1800 },
    sfx: 'chime',
  },
  gift_rises: {
    id: 'gift_rises',
    visual: { kind: 'emoji', glyph: '🎁', count: 1, durationMs: 2200 },
    sfx: 'whoosh',
  },
  confetti_sparkle: {
    id: 'confetti_sparkle',
    visual: { kind: 'confetti', count: 90 },
    sfx: 'sparkle',
  },
  badge_reveal: {
    id: 'badge_reveal',
    visual: { kind: 'emoji', glyph: '🏅', count: 1, durationMs: 2600 },
    sfx: 'chime',
  },
  elf_celebration: {
    id: 'elf_celebration',
    visual: { kind: 'emoji', glyph: '🧝', count: 4, durationMs: 2600 },
    sfx: 'sparkle',
  },
  mystery_box: {
    id: 'mystery_box',
    visual: { kind: 'emoji', glyph: '🎁', count: 2, durationMs: 2400 },
    sfx: 'sparkle',
  },
  trophy_fireworks: {
    id: 'trophy_fireworks',
    visual: { kind: 'fireworks', bursts: 5 },
    sfx: 'bell',
  },
  box_open: {
    id: 'box_open',
    visual: { kind: 'confetti', count: 140 },
    sfx: 'sparkle',
  },
  wink_sparkle: {
    id: 'wink_sparkle',
    visual: { kind: 'emoji', glyph: '😉', count: 1, durationMs: 2200 },
    sfx: 'chime',
  },
  reaction: { id: 'reaction', visual: { kind: 'emoji', glyph: '❤️', count: 1, durationMs: 2000 } },
  show_snowstorm: {
    id: 'show_snowstorm',
    visual: { kind: 'emoji', glyph: '❄️', count: 12, durationMs: 3000 },
    sfx: 'whoosh',
  },
} as const satisfies Record<string, FxCue>;

export type FxCueId = keyof typeof FX_CATALOG;

export const EVENT_TO_CUE: Record<FxEvent, FxCueId> = {
  participant_joined: 'participant_joined',
  gift_registered: 'gift_to_sleigh',
  voting_started: 'bells',
  vote_submitted: 'star_up',
  leaderboard_entry: 'gift_rises',
  correct_guess: 'confetti_sparkle',
  achievement_earned: 'badge_reveal',
  mission_completed: 'elf_celebration',
  guess_wink: 'wink_sparkle',
  mystery_reveal: 'box_open',
  auction_won: 'mystery_box',
  grand_winner: 'trophy_fireworks',
  reaction_received: 'reaction',
  show_snowstorm: 'show_snowstorm',
  show_sleigh_bells: 'bells',
};

/** Ambient scene (not event-driven): snowfall + lights. */
export const AMBIENT = { snowTextKey: 'fx.snowfall' } as const;
