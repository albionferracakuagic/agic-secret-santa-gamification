import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ACHIEVEMENT_CATALOG, type AnyAnnouncementOutput } from '@santa/contracts';
import { usePlayApi } from '../../api/play';
import { emitFx } from '../../fx/bus';
import { useLocalized } from '../../lib/localized';

const ANNOUNCE_MS = 8000;

export function useAchievementName() {
  const { i18n, t } = useTranslation();
  return (key: string) => {
    const def = ACHIEVEMENT_CATALOG.find((a) => a.key === key);
    const lang = i18n.language === 'it' ? 'it' : 'en';
    return def ? def.name[lang] : t(`achievement.${key}`, { defaultValue: key.replace(/_/g, ' ') });
  };
}

/** The caller's own unlocked achievements. */
export function MyAchievements() {
  const { t } = useTranslation();
  const api = usePlayApi();
  const name = useAchievementName();
  const q = useQuery({ queryKey: ['my-achievements'], queryFn: () => api.myAchievements() });
  const list = q.data?.achievements ?? [];
  return (
    <section aria-labelledby="ach-title" className="space-y-2">
      <h2 id="ach-title" className="font-semibold">
        {t('achievements.title')}
      </h2>
      {list.length === 0 ? (
        <p>{t('achievements.none')}</p>
      ) : (
        <ul className="flex flex-wrap gap-2" data-testid="my-achievements">
          {list.map((a) => (
            <li
              key={a.key}
              className="rounded-full bg-gold-400 px-4 py-2 font-semibold text-ink-900"
            >
              🏅 {name(a.key)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** FX cue per announcement type. Positive only: an incorrect guess gets a friendly wink. */
export function announcementFx(a: AnyAnnouncementOutput) {
  switch (a.type) {
    case 'achievement':
      return 'achievement_earned' as const;
    case 'clue':
      return 'achievement_earned' as const;
    case 'mission_completed':
      return 'mission_completed' as const;
    case 'guess_result':
      return a.outcome === 'correct' ? ('correct_guess' as const) : ('guess_wink' as const);
    case 'auction_won':
      return 'auction_won' as const;
    case 'mystery_reveal':
      return 'mystery_reveal' as const;
  }
}

/** One announcement on the caller's stream -> FX cue, visible/ARIA text, and refresh of the lists it affects. */
export function AchievementUnlock({
  announcement,
  ready,
}: {
  announcement: AnyAnnouncementOutput | undefined;
  ready: boolean;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const name = useAchievementName();
  const loc = useLocalized();
  const [shown, setShown] = useState<AnyAnnouncementOutput>();
  const baseline = useRef<{ set: boolean; at?: string | undefined }>({ set: false });
  useEffect(() => {
    if (!ready) return;
    if (!baseline.current.set) {
      baseline.current = { set: true, at: announcement?.at };
      return;
    }
    if (!announcement || announcement.at === baseline.current.at) return;
    baseline.current.at = announcement.at;
    setShown(announcement);
    emitFx(announcementFx(announcement));
    if (announcement.type === 'achievement') {
      void qc.invalidateQueries({ queryKey: ['my-achievements'] });
      void qc.invalidateQueries({ queryKey: ['my-certificates'] });
    }
    if (announcement.type === 'clue' || announcement.type === 'guess_result')
      void qc.invalidateQueries({ queryKey: ['guess'] });
    if (announcement.type === 'auction_won' || announcement.type === 'mystery_reveal') {
      void qc.invalidateQueries({ queryKey: ['auction'] });
      void qc.invalidateQueries({ queryKey: ['coins'] });
    }
    const id = setTimeout(() => setShown(undefined), ANNOUNCE_MS);
    return () => clearTimeout(id);
  }, [announcement, ready, qc]);
  const line = shown && announcementLine(shown, t, name, loc);
  return (
    <div role="status" data-testid="achievement-unlock">
      {line && (
        <p className="rounded bg-gold-400 p-3 font-semibold text-ink-900">
          {line.icon} {line.text}
        </p>
      )}
    </div>
  );
}

/** Visible/ARIA text of one announcement (the display passes its own person-aware wording for achievements). */
export function announcementLine(
  a: AnyAnnouncementOutput,
  t: TFunction,
  achievementName: (key: string) => string,
  loc: (text: Record<string, string>) => string,
): { icon: string; text: string } {
  switch (a.type) {
    case 'achievement':
      return { icon: '🏅', text: t('achievements.unlocked', { name: achievementName(a.key) }) };
    case 'clue':
      return { icon: '💡', text: t('guess.newClue', { alias: a.alias, text: a.text }) };
    case 'mission_completed':
      return { icon: '🧝', text: t('display.missionLine') };
    case 'guess_result':
      return a.outcome === 'correct'
        ? { icon: '🎉', text: t('guess.correct', { xp: a.xp }) }
        : { icon: '😉', text: t('guess.incorrect') };
    case 'auction_won':
      return {
        icon: '🎁',
        text: t('auction.wonLine', { name: a.winner.displayName, title: loc(a.title) }),
      };
    case 'mystery_reveal':
      return {
        icon: '✨',
        text: t('auction.revealLine', { title: loc(a.title), reveal: loc(a.reveal) }),
      };
  }
}
