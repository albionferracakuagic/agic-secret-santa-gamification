import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ACHIEVEMENT_CATALOG, type AnnouncementOutput } from '@santa/contracts';
import { usePlayApi } from '../../api/play';
import { emitFx } from '../../fx/bus';

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

/** Unlock moment: a new announcement on the caller's stream -> FX cue, visible/ARIA text, and a list refresh. */
export function AchievementUnlock({
  announcement,
  ready,
}: {
  announcement: AnnouncementOutput | undefined;
  ready: boolean;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const name = useAchievementName();
  const [shown, setShown] = useState<AnnouncementOutput>();
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
    emitFx('achievement_earned');
    void qc.invalidateQueries({ queryKey: ['my-achievements'] });
    const id = setTimeout(() => setShown(undefined), ANNOUNCE_MS);
    return () => clearTimeout(id);
  }, [announcement, ready, qc]);
  return (
    <div role="status" data-testid="achievement-unlock">
      {shown && (
        <p className="rounded bg-gold-400 p-3 font-semibold text-ink-900">
          🏅 {t('achievements.unlocked', { name: name(shown.key) })}
        </p>
      )}
    </div>
  );
}
