import { ACHIEVEMENT_CATALOG } from '@santa/contracts';

export interface AwardInput {
  boardKey: string;
  /** Locked at voting close through canPublish(final). */
  publishable: boolean;
  /** Something to show before the winner (leading gifts that passed canPublish). */
  hasNominees: boolean;
}

/** Persisted script step: ids/keys only. Content (names, givers) is resolved when the step is shown. */
export type CeremonyStep =
  | { type: 'intro' }
  | { type: 'category'; boardKey: string; grand: boolean }
  | { type: 'category_skipped'; boardKey: string }
  | { type: 'nominees'; boardKey: string }
  | { type: 'countdown'; seconds: number }
  | { type: 'winner'; boardKey: string; grand: boolean }
  | { type: 'achievement'; boardKey: string; achievementKey: string }
  | { type: 'spirit' }
  | { type: 'champion'; participantId?: string }
  | { type: 'outro' };

export interface ScriptOptions {
  grandBoard: string;
  countdownSeconds: number;
  includeSpirit: boolean;
  includeChampion: boolean;
  /** Organizer-defined winner achievements: categoryKey -> achievement key (custom categories only). */
  extraAchievements?: Readonly<Record<string, string>>;
}

const achievementOf = (boardKey: string, extra: Readonly<Record<string, string>> = {}) =>
  extra[boardKey] ??
  ACHIEVEMENT_CATALOG.find((a) => a.kind === 'category_winner' && a.categoryKey === boardKey)?.key;

function categorySteps(
  a: AwardInput,
  grand: boolean,
  countdown: number,
  extra?: Readonly<Record<string, string>>,
): CeremonyStep[] {
  // Unsafe categories are skipped with a neutral message: no nominees, no winner, no promise of a reveal.
  if (!a.publishable) return [{ type: 'category_skipped', boardKey: a.boardKey }];
  const ach = achievementOf(a.boardKey, extra);
  return [
    { type: 'category', boardKey: a.boardKey, grand },
    ...(a.hasNominees ? [{ type: 'nominees', boardKey: a.boardKey } as const] : []),
    { type: 'countdown', seconds: countdown },
    { type: 'winner', boardKey: a.boardKey, grand },
    ...(ach ? [{ type: 'achievement', boardKey: a.boardKey, achievementKey: ach } as const] : []),
  ];
}

/** Intro -> categories (each: title, nominees, countdown, winner, achievement) -> spirit -> champion -> GRAND CHAMPION -> outro. */
export function buildCeremonyScript(
  awards: readonly AwardInput[],
  o: ScriptOptions,
): CeremonyStep[] {
  const grand = awards.find((a) => a.boardKey === o.grandBoard);
  const steps: CeremonyStep[] = [{ type: 'intro' }];
  for (const a of awards) {
    if (a.boardKey !== o.grandBoard) steps.push(...categorySteps(a, false, o.countdownSeconds, o.extraAchievements));
  }
  if (o.includeSpirit) steps.push({ type: 'spirit' });
  if (o.includeChampion) steps.push({ type: 'champion' });
  if (grand) steps.push(...categorySteps(grand, true, o.countdownSeconds, o.extraAchievements));
  steps.push({ type: 'outro' });
  return steps;
}

/** Only countdowns advance on their own (durable timer); everything else waits for the organizer. */
export const autoAdvanceSeconds = (s: CeremonyStep): number | null =>
  s.type === 'countdown' ? s.seconds : null;

export interface LedgerRow {
  participantId: string;
  rewardKey: string;
  qualifying: boolean;
}

/** Christmas Spirit: took part in every participation activity (joined, gift registered, voted). Vote-independent. */
export function spiritQualifiers(rows: readonly LedgerRow[]): string[] {
  const need = ['joined', 'gift_registered', 'voted'];
  const by = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.qualifying) continue;
    by.set(r.participantId, (by.get(r.participantId) ?? new Set()).add(r.rewardKey));
  }
  return [...by].filter(([, keys]) => need.every((k) => keys.has(k))).map(([id]) => id);
}
