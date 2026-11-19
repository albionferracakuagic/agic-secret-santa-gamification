import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AutopilotResponseSchema,
  AutopilotStateSchema,
  type AutopilotState,
} from '@santa/contracts';
import { api, ApiError } from '../api/client';
import { useOrganizer } from '../auth/session';

interface EventRow {
  id: string;
  name: string;
  startsAt: string;
  phase: string;
  autopilot?: AutopilotState;
}

export const errorKey = (e: unknown) =>
  e instanceof ApiError ? `error.${e.code}` : 'error.generic';

const SHOW_PHASES = new Set(['gift_opening', 'voting', 'games', 'reveal', 'awards']);

const embeddedAutopilot = (event: EventRow) => {
  const parsed = AutopilotStateSchema.safeParse(event.autopilot);
  return parsed.success ? parsed.data : undefined;
};

const nextStepEta = (state: AutopilotState) => {
  if (state.status !== 'running') return null;
  if (state.stepEndsAt) return state.stepEndsAt;
  return state.timeline.find((item) => item.status === 'pending' && item.eta)?.eta ?? null;
};

export const formatCountdown = (eta: string, now: number) => {
  const seconds = Math.max(0, Math.ceil((Date.parse(eta) - now) / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m${remainder > 0 ? ` ${remainder}s` : ''}` : `${seconds}s`;
};

function useCountdownNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function EventCard({ event }: { event: EventRow }) {
  const { t } = useTranslation();
  const listState = embeddedAutopilot(event);
  const needsDetail = !listState && SHOW_PHASES.has(event.phase);
  const detail = useQuery({
    queryKey: ['event-autopilot', event.id],
    queryFn: async () =>
      AutopilotResponseSchema.parse(
        await api(`/api/events/${encodeURIComponent(event.id)}/autopilot`),
      ).state,
    enabled: needsDetail,
    retry: false,
    refetchInterval: needsDetail ? 30_000 : false,
  });
  const autopilot = listState ?? detail.data;
  const eta = autopilot ? nextStepEta(autopilot) : null;
  const now = useCountdownNow(!!eta);
  const status = autopilot?.status;
  const statusLabel = status
    ? t(`org.autopilot.${status}`)
    : needsDetail && detail.isError
      ? t('org.autopilot.unavailable')
      : needsDetail
        ? t('org.autopilot.checking')
        : t('org.autopilot.manual');
  const chipStyle =
    status === 'running'
      ? 'bg-pine-900 text-white'
      : status === 'held'
        ? 'bg-gold-400 text-ink-900'
        : status === 'done'
          ? 'bg-pine-700 text-white'
          : 'bg-snow-100 text-ink-900';

  return (
    <li className="flex items-center justify-between gap-3 rounded border border-ink-900/20 bg-white p-3">
      <div className="min-w-0">
        <strong>{event.name}</strong>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
          <span>{t(`phase.${event.phase}`)}</span>
          <span
            className={`rounded-full px-2 py-1 text-xs font-semibold ${chipStyle}`}
            aria-label={t('org.autopilot.statusLabel', { status: statusLabel })}
          >
            {statusLabel}
          </span>
          {eta && (
            <time dateTime={eta} className="text-ink-700">
              {t('org.autopilot.nextStepIn', { time: formatCountdown(eta, now) })}
            </time>
          )}
        </div>
      </div>
      <Link
        to={`/o/events/${event.id}`}
        className="min-h-11 shrink-0 rounded bg-pine-900 px-3 py-2 text-white"
      >
        {t('org.open')}
      </Link>
    </li>
  );
}

export default function Dashboard() {
  const { t, i18n } = useTranslation();
  const me = useOrganizer();
  const qc = useQueryClient();
  const events = useQuery({
    queryKey: ['events'],
    enabled: !!me.data,
    queryFn: () => api<{ events: EventRow[] }>('/api/events'),
  });
  const [name, setName] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [max, setMax] = useState(100);
  const [locale, setLocale] = useState(i18n.language === 'it' ? 'it' : 'en');
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const create = useMutation({
    mutationFn: () =>
      api('/api/events', {
        method: 'POST',
        body: {
          name,
          startsAt: new Date(startsAt).toISOString(),
          timezone,
          defaultLocale: locale,
          maxParticipants: max,
        },
      }),
    onSuccess: () => {
      setName('');
      void qc.invalidateQueries({ queryKey: ['events'] });
    },
  });

  if (me.isLoading) return <p>{t('a11y.loading')}</p>;
  if (!me.data) return <Navigate to="/o/signin" replace />;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  const input = 'mt-1 block min-h-12 w-full rounded border border-ink-900/50 px-3';

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">{t('org.dashboard')}</h1>
      {events.data?.events.length === 0 && <p>{t('org.empty')}</p>}
      <ul className="space-y-2">
        {events.data?.events.map((event) => <EventCard key={event.id} event={event} />)}
      </ul>

      <form
        onSubmit={onSubmit}
        className="space-y-3 rounded bg-snow-100 p-4"
        aria-label={t('org.create')}
      >
        <h2 className="text-xl font-semibold">{t('org.create')}</h2>
        <label className="block">
          {t('org.name')}
          <input
            required
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={input}
          />
        </label>
        <label className="block">
          {t('org.startsAt')}
          <input
            required
            type="datetime-local"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
            className={input}
          />
        </label>
        <label className="block">
          {t('org.maxParticipants')}
          <input
            type="number"
            min={2}
            max={100}
            value={max}
            onChange={(e) => setMax(Number(e.target.value))}
            className={input}
          />
        </label>
        <label className="block">
          {t('org.locale')}
          <select value={locale} onChange={(e) => setLocale(e.target.value)} className={input}>
            <option value="en">English</option>
            <option value="it">Italiano</option>
          </select>
        </label>
        <p className="text-sm">{timezone}</p>
        <button
          type="submit"
          disabled={create.isPending}
          className="min-h-12 w-full rounded bg-santa-600 px-4 font-semibold text-white"
        >
          {t('org.create')}
        </button>
        {create.isError && (
          <p role="alert" className="rounded bg-santa-700 p-3 text-white">
            {t(errorKey(create.error))}
          </p>
        )}
      </form>
    </div>
  );
}
