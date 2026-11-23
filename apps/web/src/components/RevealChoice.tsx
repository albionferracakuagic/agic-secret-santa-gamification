import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ShowChoiceViewOutput } from '@santa/contracts';
import { useTranslation } from 'react-i18next';
import { emitFx } from '../fx/bus';

/** Snapshot hydration/recovery is silent, including when React batches disconnect + resnapshot. */
export function useRevealChoiceFx(
  choice: ShowChoiceViewOutput | null | undefined,
  live: boolean,
  snapshot: number,
  eventId: string | undefined,
) {
  const prev = useRef<{ choice: typeof choice; snapshot: number; eventId: typeof eventId }>(
    undefined,
  );
  useEffect(() => {
    const before = prev.current;
    prev.current = live ? { choice, snapshot, eventId } : undefined;
    if (
      live &&
      eventId &&
      before?.eventId === eventId &&
      before.snapshot === snapshot &&
      before.choice?.status === 'open' &&
      choice?.status === 'closed' &&
      before.choice.round === choice.round &&
      choice.result !== 'none'
    ) {
      // The visible round result also provides the live text; don't announce it twice.
      emitFx(choice.result === 'snowstorm' ? 'show_snowstorm' : 'show_sleigh_bells', {
        announce: false,
      });
    }
  }, [choice, live, snapshot, eventId]);
}

function useSecondsLeft(endsAt: string | undefined, now: () => number) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!endsAt) return;
    const timer = setInterval(() => tick((n) => n + 1), 200);
    return () => clearInterval(timer);
  }, [endsAt]);
  return endsAt ? Math.max(0, Math.ceil((Date.parse(endsAt) - now()) / 1000)) : 0;
}

export function RevealChoice({
  choice,
  now,
  children,
}: {
  choice: ShowChoiceViewOutput | null | undefined;
  now: () => number;
  children?: (remaining: number) => ReactNode;
}) {
  const { t } = useTranslation();
  const left = useSecondsLeft(choice?.status === 'open' ? choice.endsAt : undefined, now);
  return (
    <>
      <div role="status" className={choice ? 'font-semibold' : 'sr-only'}>
        {choice?.status === 'open' &&
          t(
            left > 0
              ? children
                ? 'revealShow.open'
                : 'revealShow.matchup'
              : 'revealShow.finishing',
          )}
        {choice?.status === 'closed' && (
          <p data-testid="reveal-choice-result">{t(`revealShow.result.${choice.result}`)}</p>
        )}
      </div>
      {choice?.status === 'open' && left > 0 && (
        <p
          role="timer"
          aria-label={t('display.countdown')}
          className="font-bold tabular-nums"
          data-testid="reveal-choice-countdown"
        >
          {t('revealShow.seconds', { count: left })}
        </p>
      )}
      {choice?.status === 'open' && children?.(left)}
    </>
  );
}
