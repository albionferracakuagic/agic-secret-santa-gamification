import { z } from 'zod';

export const PHASES = [
  'preparation',
  'registration',
  'gift_registration',
  'gift_opening',
  'voting',
  'games',
  'reveal',
  'awards',
  'completed',
] as const;
export const PhaseSchema = z.enum(PHASES);
export type Phase = z.infer<typeof PhaseSchema>;

export const LocaleSchema = z.enum(['en', 'it']);
export type Locale = z.infer<typeof LocaleSchema>;

export const IdSchema = z.string().min(1).max(64);
export const IsoDateSchema = z.iso.datetime({ offset: true });

export const ParticipantStatusSchema = z.enum(['unclaimed', 'pending', 'active', 'removed']);

/** Fixed positive reaction set (FR-046.7): validated server-side, no free text. */
export const REACTION_KINDS = ['heart', 'clap', 'sparkle', 'tree', 'gift'] as const;
export const ReactionKindSchema = z.enum(REACTION_KINDS);
export type ReactionKind = z.infer<typeof ReactionKindSchema>;

export const ROLES = ['participant', 'display', 'organizer_masked', 'organizer_unmasked'] as const;
export const RoleSchema = z.enum(ROLES);
export type Role = z.infer<typeof RoleSchema>;
