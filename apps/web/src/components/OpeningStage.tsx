import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PublicGiftOutput } from '@santa/contracts';
import { effectiveIntensity, usePrefs } from '../prefs/store';
import { useFxCap } from '../fx/cap';
import { emitFx } from '../fx/bus';
import { avatarGlyph } from '../fx/avatars';

/**
 * Gift-opening stage shared by the display and participant app: animated box -> server countdown -> reveal.
 * The countdown is server-driven (`countdownEndsAt` against the server clock); with visuals off
 * (reduced motion / intensity off) the reveal is immediate and the same text is shown.
 */
export function OpeningStage({
  current,
  openedCount,
  total,
  countdownEndsAt,
  now,
  big = false,
}: {
  current: PublicGiftOutput | null;
  openedCount: number;
  total: number;
  countdownEndsAt: string | null;
  now: () => number;
  big?: boolean;
}) {
  const { t } = useTranslation();
  const prefs = usePrefs();
  const cap = useFxCap((s) => s.cap);
  const animate = effectiveIntensity(prefs, cap) !== 'off';
  const [, tick] = useState(0);
  const id = current?.giftId;
  const remainingMs =
    animate && current && countdownEndsAt ? Date.parse(countdownEndsAt) - now() : 0;
  const left = remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;

  useEffect(() => {
    if (left === 0) return;
    const timer = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(timer);
  }, [left === 0, id]);
  const revealed = !!current && left === 0;
  useEffect(() => {
    if (revealed && animate) emitFx('auction_won');
  }, [revealed, id, animate]);

  const size = big ? 'text-6xl' : 'text-2xl';
  return (
    <div className="space-y-4 text-center" data-testid="opening-stage">
      <p className={big ? 'text-4xl' : 'text-lg'}>
        {t('opening.progress', { opened: openedCount, total })}
      </p>
      {!current && <p className={size}>{t('opening.waiting')}</p>}
      {current && !revealed && (
        <div className="space-y-2">
          <p aria-hidden="true" className={`${big ? 'text-[10rem]' : 'text-8xl'} gift-box-shake`}>
            🎁
          </p>
          <p aria-hidden="true" className={`${big ? 'text-8xl' : 'text-5xl'} font-extrabold`}>
            {left}
          </p>
          <p role="status" className="sr-only">
            {t('opening.opening', { alias: current.alias })}
          </p>
        </div>
      )}
      {revealed && current && (
        <div className="space-y-3" data-testid="opening-revealed">
          <p aria-hidden="true" className={big ? 'text-9xl' : 'text-6xl'}>
            🎉
          </p>
          <h3 className={`${big ? 'text-7xl' : 'text-3xl'} font-bold`}>
            {t('opening.revealed', { alias: current.alias })}: {current.name}
          </h3>
          <p role="status" className="sr-only">
            {t('opening.revealed', { alias: current.alias })}: {current.name}
          </p>
          {current.description && (
            <p className={big ? 'text-4xl' : 'text-lg'}>{current.description}</p>
          )}
          {current.photoUrl && (
            <img
              src={current.photoUrl}
              alt={current.name}
              className={`mx-auto rounded-xl object-cover ${big ? 'h-[420px]' : 'h-48'}`}
            />
          )}
          {current.status === 'revealed' && (
            <p className={big ? 'text-5xl' : 'text-xl'}>
              {t('reveal.from')} <span aria-hidden="true">{avatarGlyph(current.giver.avatar)}</span>{' '}
              {current.giver.displayName}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
