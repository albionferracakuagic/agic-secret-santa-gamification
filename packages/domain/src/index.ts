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

export type Phase = (typeof PHASES)[number];
