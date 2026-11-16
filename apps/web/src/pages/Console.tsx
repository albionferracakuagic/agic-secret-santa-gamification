import { useTranslation } from 'react-i18next';
import { Link, Navigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PHASES, type Phase } from '@santa/contracts';
import { api } from '../api/client';
import { useOrganizer } from '../auth/session';
import { errorKey } from './Dashboard';

interface OrganizerState {
  role: string;
  eventState: {
    name: string;
    phase: Phase;
    paused: boolean;
    counts: { participants: number; giftsRegistered: number };
    organizer: {
      roster: { unclaimed: number; pending: number; active: number; removed: number };
      warnings: string[];
    };
  };
}

/** Phase the "next" button targets (games is skippable straight to reveal). */
export const nextPhase = (p: Phase): Phase | undefined => PHASES[PHASES.indexOf(p) + 1];
export const prevPhase = (p: Phase): Phase | undefined => PHASES[PHASES.indexOf(p) - 1];

export default function Console() {
  const { t } = useTranslation();
  const { eventId = '' } = useParams();
  const me = useOrganizer();
  const qc = useQueryClient();
  const key = ['event', eventId];
  const state = useQuery({
    queryKey: key,
    enabled: !!me.data,
    refetchInterval: 15_000,
    queryFn: () => api<OrganizerState>(`/api/events/${eventId}/organizer-state`),
  });
  const act = useMutation({
    mutationFn: (a: { path: string; body: unknown }) =>
      api(`/api/events/${eventId}/${a.path}`, { method: 'POST', body: a.body }),
    onSettled: () => void qc.invalidateQueries({ queryKey: key }),
  });

  if (me.isLoading || state.isLoading) return <p>{t('a11y.loading')}</p>;
  if (!me.data) return <Navigate to="/o/signin" replace />;
  const s = state.data?.eventState;
  if (!s) return <p role="alert">{t('error.forbidden')}</p>;

  const next = nextPhase(s.phase);
  const prev = prevPhase(s.phase);
  const go = (to: Phase) => act.mutate({ path: 'phase', body: { to } });
  const big = 'min-h-12 w-full rounded px-4 font-semibold disabled:opacity-50';
  const r = s.organizer.roster;

  return (
    <div className="space-y-4">
      <Link to="/o" className="underline">
        {t('console.back')}
      </Link>
      <h1 className="text-2xl font-bold">{s.name}</h1>
      <p>
        {t('console.currentPhase')}: <strong>{t(`phase.${s.phase}`)}</strong>
      </p>
      {s.paused && (
        <p role="status" className="rounded bg-gold-400 p-3 font-semibold text-ink-900">
          {t('console.paused')}
        </p>
      )}
      {s.organizer.warnings.map((w) => (
        <p key={w} role="alert" className="rounded border-2 border-gold-700 bg-snow-100 p-3">
          {t(`console.warnings.${w}`)}
        </p>
      ))}
      <p>
        {t('console.roster')}:{' '}
        {t('console.rosterCounts', {
          active: r.active,
          pending: r.pending,
          unclaimed: r.unclaimed,
        })}
      </p>
      <p className="text-sm">{t('console.masked')}</p>

      <div className="space-y-2">
        {next && (
          <button
            type="button"
            disabled={act.isPending}
            className={`${big} bg-pine-900 text-white`}
            onClick={() => go(next)}
          >
            {t('console.next', { phase: t(`phase.${next}`) })}
          </button>
        )}
        {s.phase === 'voting' && (
          <button
            type="button"
            disabled={act.isPending}
            className={`${big} border border-pine-900`}
            onClick={() => go('reveal')}
          >
            {t('console.skipGames')}
          </button>
        )}
        {prev && (
          <button
            type="button"
            disabled={act.isPending}
            className={`${big} border border-ink-900`}
            onClick={() => go(prev)}
          >
            {t('console.previous', { phase: t(`phase.${prev}`) })}
          </button>
        )}
        <button
          type="button"
          disabled={act.isPending}
          className={`${big} bg-santa-600 text-white`}
          onClick={() => act.mutate({ path: 'pause', body: { paused: !s.paused } })}
        >
          {s.paused ? t('console.resume') : t('console.pause')}
        </button>
      </div>
      {act.isError && (
        <p role="alert" className="rounded bg-santa-700 p-3 text-white">
          {t(errorKey(act.error))}
        </p>
      )}
    </div>
  );
}
