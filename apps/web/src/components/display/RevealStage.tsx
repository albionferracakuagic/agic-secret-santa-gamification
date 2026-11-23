import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { RevealViewOutput } from '@santa/contracts';
import { effectiveIntensity, usePrefs } from '../../prefs/store';
import { useFxCap } from '../../fx/cap';
import { emitFx } from '../../fx/bus';
import { avatarGlyph } from '../../fx/avatars';
import { RECAP_PATH } from '../../routes/recap';
import { GiftPhoto } from '../GiftPhoto';
import { RevealChoice } from '../RevealChoice';
import { RevealTree } from './RevealTree';

function pairLabel(t: TFunction, pair: RevealViewOutput['revealed'][number]) {
  const giver = pair.giver.displayName;
  return pair.recipient
    ? t('reveal.pair', { giver, recipient: pair.recipient.displayName })
    : t('reveal.secretSanta', { name: giver });
}

/**
 * Display giver-reveal stage (1080p): drumroll -> card flip + giver zoom -> finale grid.
 * Server-driven (`countdownEndsAt` vs server clock). Only what the projection sent is rendered:
 * the current pair is withheld from both visible and live text until the server says revealed.
 * Reduced motion / intensity off: same content, no animation classes, no FX cue.
 */
export function RevealStage({
  reveal,
  now,
  snapshot,
}: {
  reveal: RevealViewOutput;
  now: () => number;
  snapshot: number;
}) {
  const { t } = useTranslation();
  const prefs = usePrefs();
  const cap = useFxCap((s) => s.cap);
  const animate = effectiveIntensity(prefs, cap) !== 'off';
  const { current, revealedCount, total, revealed } = reveal;
  const finale = current === null && total > 0 && revealedCount >= total;

  const [, tick] = useState(0);
  const left =
    current?.stage === 'drumroll' && reveal.countdownEndsAt
      ? Math.max(0, Math.ceil((Date.parse(reveal.countdownEndsAt) - now()) / 1000))
      : 0;
  useEffect(() => {
    if (current?.stage !== 'drumroll') return;
    const id = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, [current?.stage, current?.giftId]);

  // FX cues only for changes seen live (never on the initial snapshot).
  const key = finale ? 'finale' : current ? `${current.giftId}:${current.stage}` : 'idle';
  const prevKey = useRef<string | undefined>(undefined);
  useEffect(() => {
    const prev = prevKey.current;
    prevKey.current = key;
    if (prev === undefined || prev === key) return;
    if (key === 'finale') emitFx('grand_winner');
    else if (key.endsWith(':revealed')) emitFx('mystery_reveal');
  }, [key]);

  const recent = [...revealed].reverse().slice(0, 6);
  const announce = finale
    ? t('reveal.finaleAnnounce')
    : current?.stage === 'revealed'
      ? current.recipient
        ? t('reveal.announceRevealed', {
            giver: current.giver.displayName,
            recipient: current.recipient.displayName,
          })
        : t('reveal.announceRevealedUnknown', {
            giver: current.giver.displayName,
            alias: current.alias,
          })
      : current
        ? t('reveal.announceDrumroll')
        : '';

  return (
    <section
      aria-label={t('display.revealTitle')}
      data-testid="reveal-stage"
      className="flex h-full w-full flex-col items-center gap-8 p-16 text-center"
    >
      <p role="status" className="sr-only" data-testid="reveal-live">
        {announce}
      </p>
      <header className="grid w-full grid-cols-[1fr_2.8fr_1fr] items-center gap-8">
        <div className="space-y-2 text-3xl">
          <RevealChoice choice={reveal.choice} now={now} />
        </div>
        <div className="space-y-5">
          <h2 className="text-7xl font-bold">
            {finale ? t('reveal.finaleTitle') : t('display.revealTitle')}
          </h2>
          <div
            role="progressbar"
            aria-label={t('reveal.progressLabel')}
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={revealedCount}
            aria-valuetext={t('reveal.progress', { revealed: revealedCount, total })}
            data-testid="reveal-progress"
          >
            <div className="h-5 overflow-hidden rounded-full bg-white/20">
              <div
                className="h-full rounded-full bg-gold-400"
                style={{ width: `${total > 0 ? Math.min(100, (revealedCount / total) * 100) : 0}%` }}
              />
            </div>
            <p className="mt-2 text-4xl">{t('reveal.progress', { revealed: revealedCount, total })}</p>
          </div>
        </div>
        <div className="text-3xl">
          {reveal.lights !== undefined && (
            <RevealTree lights={reveal.lights} animate={animate} snapshot={snapshot} />
          )}
        </div>
      </header>

      {finale ? (
        <Finale revealed={revealed} />
      ) : !current ? (
        <p className="text-6xl">{t('reveal.waiting')}</p>
      ) : (
        <div className="flex flex-1 items-center" data-testid={`reveal-${current.stage}`}>
          <div
            key={current.stage}
            className={`flex max-w-[1680px] min-w-0 items-center gap-16 rounded-[2rem] bg-white/15 px-16 py-10 ${
              animate && current.stage === 'revealed' ? 'reveal-flip' : ''
            }`}
          >
            <GiftPhoto
              src={current.photoUrl}
              alt={current.giftName}
              className="h-[400px] w-[400px] shrink-0 rounded-2xl object-cover"
              testId="reveal-gift-photo"
              fallback={
                <p aria-hidden="true" className="text-[12rem]">
                  🎁
                </p>
              }
            />
            <div className="min-w-0 space-y-4 text-left wrap-anywhere">
              <p className="text-5xl text-gold-400">{current.alias}</p>
              <p className="text-7xl font-bold">{current.giftName}</p>
              {current.stage === 'drumroll' ? (
                <div className={animate ? 'reveal-pulse' : ''}>
                  <p className="text-5xl">{t('reveal.giftForSomeone')}</p>
                  <p aria-hidden="true" className="text-6xl">
                    🥁 {t('reveal.drumroll')}
                  </p>
                  {reveal.countdownEndsAt && (
                    <p
                      aria-hidden="true"
                      className="text-[10rem] font-extrabold leading-none tabular-nums text-gold-400"
                      data-testid="reveal-countdown"
                    >
                      {left}
                    </p>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-8" data-testid="reveal-giver">
                  <span
                    aria-hidden="true"
                    className={`text-[9rem] leading-none ${animate ? 'reveal-zoom' : ''}`}
                  >
                    {avatarGlyph(current.giver.avatar)}
                  </span>
                  <p className="text-7xl font-extrabold text-gold-400">
                    {pairLabel(t, current)}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {!finale && recent.length > 0 && (
        <div className="w-full max-w-[1700px]" data-testid="reveal-strip">
          <h3 className="mb-2 text-3xl opacity-80">{t('reveal.recent')}</h3>
          <ul className="flex flex-wrap justify-center gap-4 text-3xl">
            {recent.map((p) => (
              <li key={p.giftId} className="rounded-xl bg-white/15 px-5 py-2">
                <span aria-hidden="true">{avatarGlyph(p.giver.avatar)}</span>{' '}
                {pairLabel(t, p)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Finale({ revealed }: { revealed: RevealViewOutput['revealed'] }) {
  const { t } = useTranslation();
  return (
    <div className="flex w-full max-w-[1750px] flex-1 flex-col items-center gap-6">
      <ul
        className="grid w-full grid-cols-3 gap-4 text-3xl"
        data-testid="reveal-finale-grid"
        aria-label={t('reveal.finaleAll')}
      >
        {revealed.map((p) => (
          <li key={p.giftId} className="rounded-2xl bg-white/15 px-6 py-3 text-left">
            <span aria-hidden="true">{avatarGlyph(p.giver.avatar)}</span>{' '}
            {pairLabel(t, p)}
            <br />
            <span className="text-2xl opacity-80">🎁 {p.giftName}</span>
          </li>
        ))}
      </ul>
      <p className="text-5xl font-bold text-gold-400" data-testid="reveal-recap-hint">
        {t('reveal.finaleHint')} · {RECAP_PATH}
      </p>
    </div>
  );
}
