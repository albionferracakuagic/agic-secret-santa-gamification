import { useEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ACHIEVEMENT_CATALOG, type CeremonyViewOutput } from '@santa/contracts';
import { avatarGlyph } from '../fx/avatars';
import { emitFx } from '../fx/bus';
import { Countdown } from './Countdown';

type Step = NonNullable<CeremonyViewOutput['step']>;

const loc = (m: Record<string, string>, lang: string) =>
  m[lang] ?? m['en'] ?? Object.values(m)[0] ?? '';

/** Show-wide cue for each step (non-blocking; text equivalents come from the visible text itself). */
function cueFor(step: Step) {
  switch (step.type) {
    case 'category':
      return emitFx('voting_started');
    case 'nominees':
      return emitFx('leaderboard_entry');
    case 'winner':
      return emitFx(step.grand ? 'grand_winner' : 'correct_guess');
    case 'achievement':
    case 'spirit':
      return emitFx('achievement_earned');
    case 'champion':
      return emitFx('grand_winner'); // golden fireworks
    default:
      return;
  }
}

/** One screen of the awards show. Shared by the display (big) and the participant app (compact). */
export function CeremonyScene({
  view,
  now,
  big = false,
}: {
  view: CeremonyViewOutput;
  now: () => number;
  big?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const last = useRef<string | undefined>(undefined);
  const key = `${view.index}:${view.step?.type ?? ''}`;
  useEffect(() => {
    if (
      last.current !== undefined &&
      last.current !== key &&
      view.step &&
      view.status === 'running'
    )
      cueFor(view.step);
    last.current = key;
  }, [key, view.step, view.status]);

  const h = big ? 'text-8xl' : 'text-3xl';
  const p = big ? 'text-5xl' : 'text-lg';
  const Wrap = ({ children, title }: { children?: ReactNode; title: string }) => (
    <section
      aria-label={t('ceremony.title')}
      className={`flex flex-col items-center justify-center text-center ${big ? 'h-full w-full gap-10 p-24' : 'gap-3'}`}
      data-testid="ceremony-scene"
    >
      <h2 className={`${h} font-bold`}>{title}</h2>
      {children}
      {view.status === 'paused' && (
        <p role="status" className={p}>
          {t('ceremony.paused')}
        </p>
      )}
    </section>
  );

  const s = view.step;
  if (!s || view.status === 'idle')
    return <Wrap title={t(view.status === 'cancelled' ? 'ceremony.cancelled' : 'ceremony.soon')} />;
  if (view.status === 'cancelled') return <Wrap title={t('ceremony.cancelled')} />;

  switch (s.type) {
    case 'intro':
      return <Wrap title={t('ceremony.intro')} />;
    case 'category':
      return (
        <Wrap title={loc(s.name, lang)}>
          {s.grand && <p className={p}>🏆 {t('ceremony.grand')}</p>}
        </Wrap>
      );
    case 'category_skipped':
      return (
        <Wrap title={loc(s.name, lang)}>
          <p className={p}>{t('ceremony.skipped')}</p>
        </Wrap>
      );
    case 'nominees':
      return (
        <Wrap title={t('ceremony.nominees')}>
          <ul className={`flex flex-wrap justify-center ${big ? 'gap-8 text-5xl' : 'gap-3'}`}>
            {s.entries.map((e) => (
              <li key={e.entryId} className="rounded-2xl bg-white/15 px-6 py-3">
                ⭐ {e.label}
              </li>
            ))}
          </ul>
        </Wrap>
      );
    case 'countdown':
      return (
        <Wrap title={t('ceremony.countdown')}>
          {view.endsAt ? (
            <Countdown
              endsAt={view.endsAt}
              now={now}
              className={big ? 'text-[12rem]' : 'text-5xl'}
            />
          ) : (
            <p className={big ? 'text-[12rem]' : 'text-5xl'}>{s.seconds}</p>
          )}
        </Wrap>
      );
    case 'winner':
      return (
        <Wrap
          title={t(s.grand ? 'ceremony.grandWinner' : 'ceremony.winner', {
            name: loc(s.name, lang),
          })}
        >
          {s.tied && <p className={p}>{t('ceremony.shared')}</p>}
          <ul className="space-y-4" data-testid="ceremony-winners">
            {s.winners.map((w) => (
              <li key={w.entryId} className={p}>
                <span aria-hidden="true">🎁</span> {w.label}
                <br />
                {t('reveal.from')} <span aria-hidden="true">{avatarGlyph(w.giver.avatar)}</span>{' '}
                {w.giver.displayName}
              </li>
            ))}
          </ul>
        </Wrap>
      );
    case 'achievement': {
      const def = ACHIEVEMENT_CATALOG.find((a) => a.key === s.achievementKey);
      return (
        <Wrap
          title={
            def
              ? loc(def.name, lang)
              : t(`achievement.${s.achievementKey}`, { defaultValue: s.achievementKey })
          }
        >
          <ul className={p}>
            {s.recipients.map((r) => (
              <li key={r.participantId}>
                <span aria-hidden="true">{avatarGlyph(r.avatar)}</span> {r.displayName}
              </li>
            ))}
          </ul>
        </Wrap>
      );
    }
    case 'spirit':
      return (
        <Wrap title={t('ceremony.spirit')}>
          <p className={p}>{t('ceremony.spiritCount', { count: s.recipientCount })}</p>
        </Wrap>
      );
    case 'champion':
      return (
        <Wrap title={t('ceremony.champion')}>
          <p className={big ? 'text-9xl' : 'text-6xl'} aria-hidden="true">
            👑 {avatarGlyph(s.person.avatar)}
          </p>
          <p className={`${p} font-bold`}>{s.person.displayName}</p>
        </Wrap>
      );
    case 'outro':
      return <Wrap title={t('ceremony.outro')} />;
  }
}
