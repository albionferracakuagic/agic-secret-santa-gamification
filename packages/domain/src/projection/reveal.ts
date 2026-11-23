import type { RevealViewOutput, ShowChoiceViewOutput, ShowChoiceOption } from '@santa/contracts';
import type { GiftSource, ParticipantSource } from './sources.js';

export interface RevealInput {
  gifts: readonly GiftSource[];
  people: readonly ParticipantSource[];
  /** Gift on stage (null = none yet / finale). */
  currentGiftId: string | null;
  /** Drumroll deadline of the staged gift (server time). */
  countdownEndsAt: string | null;
  /**
   * Reveal-show extras (already public-safe: totals/outcomes only). When given, they are copied verbatim; the
   * caller (server) always passes them. Never pass ballots or tap rows here.
   */
  show?: {
    lights: number;
    choice: ShowChoiceViewOutput | null;
    effect: ShowChoiceOption | null;
  };
}

const person = (people: readonly ParticipantSource[], id: string) => {
  const p = people.find((x) => x.id === id);
  return p ? { participantId: p.id, displayName: p.displayName, avatar: p.avatar } : null;
};

/**
 * Public reveal view (display + participants). FR-046 rule 6: a giver appears ONLY for gifts whose giver is
 * revealed server-side (status `revealed`); a staged-but-unrevealed gift is a drumroll with `giver: null`.
 * Hidden (moderated) and unopened gifts never appear. `revealed` is sorted by alias (never opening/pairing order).
 */
export function projectReveal(i: RevealInput): RevealViewOutput {
  const real = i.gifts.filter((g) => !g.hidden && g.status !== 'registered');
  const core = (g: GiftSource) => ({
    giftId: g.id,
    alias: `Gift ${g.aliasNo}`,
    giftName: g.name,
    photoUrl: g.photoUrl,
    recipient: person(i.people, g.recipientId),
  });
  const revealed = real
    .filter((g) => g.status === 'revealed')
    .sort((a, b) => a.aliasNo - b.aliasNo)
    .flatMap((g) => {
      const giver = person(i.people, g.giverId);
      return giver ? [{ ...core(g), giver }] : [];
    });
  const cur = real.find((g) => g.id === i.currentGiftId);
  const curGiver = cur?.status === 'revealed' ? person(i.people, cur.giverId) : null;
  const current = !cur
    ? null
    : curGiver
      ? { ...core(cur), stage: 'revealed' as const, giver: curGiver }
      : { ...core(cur), stage: 'drumroll' as const, giver: null };
  return {
    current,
    countdownEndsAt: current?.stage === 'drumroll' ? i.countdownEndsAt : null,
    revealedCount: real.filter((g) => g.status === 'revealed').length,
    total: real.length,
    revealed,
    ...(i.show
      ? {
          lights: i.show.lights,
          // an open round never carries a result, whatever the caller passed
          choice:
            i.show.choice?.status === 'open' ? { ...i.show.choice, result: null } : i.show.choice,
          effect: i.show.effect,
        }
      : {}),
  };
}
