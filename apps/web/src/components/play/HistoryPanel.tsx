import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  usePhase3Api,
  type Archive,
  type HallOfFame,
  type Lifetime as LifetimeData,
} from '../../api/phase3';
import { useLocalized } from '../../lib/localized';
import { avatarGlyph } from '../../fx/avatars';
import { Winners } from './GamePanel';
import { errorKey } from '../../pages/Dashboard';

type EventArchive = NonNullable<Archive['archive']>;

/** FR-042: public results of a completed event (nothing private is in the archive). Shared by participants and the organizer. */
export function ArchiveView({ archive }: { archive: EventArchive }) {
  const { t } = useTranslation();
  const loc = useLocalized();
  return (
    <div className="space-y-3" data-testid="archive">
      <h3 className="text-lg font-semibold">
        {archive.name} ({archive.year})
      </h3>
      {archive.champion && (
        <p>
          🏆 {t('history.champion')}: {archive.champion.displayName}
        </p>
      )}
      <h4 className="font-semibold">{t('history.winners')}</h4>
      <ul className="space-y-1">
        {archive.winners.map((w) => (
          <li key={w.boardKey}>
            {w.grand ? '🌟 ' : '🎁 '}
            {loc(w.name)}: {w.giftName} — {t('history.from')}{' '}
            <span aria-hidden="true">{avatarGlyph(w.giver.avatar)}</span> {w.giver.displayName}
          </li>
        ))}
      </ul>
      {archive.achievements.length > 0 && (
        <>
          <h4 className="font-semibold">{t('history.achievements')}</h4>
          <ul className="space-y-1">
            {archive.achievements.map((a) => (
              <li key={`${a.key}-${a.person.participantId}`}>
                🏅 {a.key.replace(/_/g, ' ')}: {a.person.displayName}
              </li>
            ))}
          </ul>
        </>
      )}
      {archive.games.length > 0 && (
        <>
          <h4 className="font-semibold">{t('history.games')}</h4>
          <ul className="space-y-2">
            {archive.games.map((g, i) => (
              <li key={`${g.kind}-${i}`}>
                {loc(g.title)}
                <Winners results={g.winners} />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** FR-044: positive accomplishments only; seasons come through canPublish (>= 5 contributors, no totals). */
export function HallOfFameView({ hof }: { hof: HallOfFame }) {
  const { t } = useTranslation();
  const loc = useLocalized();
  if (hof.years.length === 0 && hof.seasons.length === 0) return <p>{t('history.hofNone')}</p>;
  return (
    <div className="space-y-3" data-testid="hall-of-fame">
      {hof.years.map((y) => (
        <section key={y.year} aria-label={String(y.year)}>
          <h4 className="font-semibold">{y.year}</h4>
          {y.events.map((e) => (
            <div key={e.name}>
              <p>{e.name}</p>
              <ul className="space-y-1">
                {e.champions.map((c, i) => (
                  <li key={`${c.kind}-${c.person.participantId}-${i}`}>
                    🏆 {t(`history.kind.${c.kind}`)} · {loc(c.title)}: {c.person.displayName}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ))}
      {hof.seasons.map((s) => (
        <section key={`s${s.year}`} aria-label={`${t('history.seasons')} ${s.year}`}>
          <h4 className="font-semibold">
            {t('history.seasons')} {s.year}
          </h4>
          <Winners results={s.board} />
        </section>
      ))}
    </div>
  );
}

/** Participant: my event history (once completed), Hall of Fame, lifetime titles and the account-link flow. Hidden while history is off. */
export function HistoryPanel() {
  const { t } = useTranslation();
  const api = usePhase3Api();
  const hist = useQuery({ queryKey: ['history'], queryFn: () => api.myHistory() });
  const hof = useQuery({ queryKey: ['hof'], queryFn: () => api.myHallOfFame() });
  const life = useQuery({ queryKey: ['lifetime'], queryFn: () => api.myLifetime() });
  if (!hist.data?.enabled && !hof.data?.enabled) return null;
  return (
    <section aria-labelledby="history-title" className="space-y-4" data-testid="history-panel">
      <h2 id="history-title" className="text-xl font-semibold">
        {t('history.title')}
      </h2>
      {hist.data?.archive ? (
        <ArchiveView archive={hist.data.archive} />
      ) : (
        <p>{t('history.none')}</p>
      )}
      <section aria-labelledby="hof-title" className="space-y-2">
        <h3 id="hof-title" className="font-semibold">
          {t('history.hof')}
        </h3>
        {hof.data && <HallOfFameView hof={hof.data} />}
      </section>
      <LifetimeSection linked={life.data?.linked ?? false} profile={life.data?.profile ?? null} />
    </section>
  );
}

function LifetimeSection({
  linked,
  profile,
}: {
  linked: boolean;
  profile: LifetimeData['profile'];
}) {
  const { t } = useTranslation();
  const api = usePhase3Api();
  const loc = useLocalized();
  const [email, setEmail] = useState('');
  const send = useMutation({ mutationFn: (e: string) => api.startAccountLink(e) });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    send.mutate(email.trim());
  };
  return (
    <section aria-labelledby="life-title" className="space-y-2">
      <h3 id="life-title" className="font-semibold">
        {t('history.lifetime')}
      </h3>
      {linked && profile ? (
        <div data-testid="lifetime">
          <p>{t('history.events', { n: profile.events })}</p>
          {profile.participationYears.length > 0 && (
            <p>{t('history.years', { years: profile.participationYears.join(', ') })}</p>
          )}
          <ul className="space-y-1">
            {profile.titles.map((x) => (
              <li key={`${x.key}-${x.year}-${x.eventName}`}>
                {x.trophy ? '🏆' : '🏅'} {loc(x.title)} — {x.eventName} {x.year}
              </li>
            ))}
          </ul>
          <p>{t('history.totalAchievements', { n: profile.totalAchievements })}</p>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-2">
          <p>{t('history.notLinked')}</p>
          <label className="block">
            {t('history.linkEmail')}
            <input
              type="email"
              autoComplete="email"
              className="mt-1 block min-h-12 w-full rounded border border-ink-900/40 bg-white px-3"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <button
            className="min-h-12 rounded bg-pine-900 px-4 font-semibold text-white disabled:opacity-50"
            disabled={!email.includes('@') || send.isPending}
          >
            {t('history.linkSend')}
          </button>
          <p role="status">
            {send.isSuccess ? t('history.linkSent') : ''}
            {send.isError ? t(errorKey(send.error)) : ''}
          </p>
        </form>
      )}
    </section>
  );
}
