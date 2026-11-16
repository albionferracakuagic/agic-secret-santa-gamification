import type { ReactionKind } from '@santa/contracts';
import { emitFx } from './bus';

/** Positive-only glyphs per contract reaction kind (FR-046.7); the kind set itself comes from the contract. */
export const REACTION_GLYPH: Record<ReactionKind, string> = {
  heart: '❤️',
  clap: '👏',
  sparkle: '✨',
  tree: '🎄',
  gift: '🎁',
};

export const glyphFor = (kind: string): string | undefined =>
  (REACTION_GLYPH as Record<string, string>)[kind];

/** Floating icon for a reaction (own tap or one received from the stream). */
export const floatReaction = (kind: string) =>
  emitFx('reaction_received', { glyph: glyphFor(kind) ?? '❤️' });
