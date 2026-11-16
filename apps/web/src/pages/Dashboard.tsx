import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { useOrganizer } from '../auth/session';

interface EventRow {
  id: string;
  name: string;
  startsAt: string;
  phase: string;
}

export const errorKey = (e: unknown) =>
  e instanceof ApiError ? `error.${e.code}` : 'error.generic';

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
        {events.data?.events.map((e) => (
          <li
            key={e.id}
            className="flex items-center justify-between gap-3 rounded border border-ink-900/20 bg-white p-3"
          >
            <span>
              <strong>{e.name}</strong>
              <br />
              <span className="text-sm">{t(`phase.${e.phase}`)}</span>
            </span>
            <Link
              to={`/o/events/${e.id}`}
              className="min-h-11 rounded bg-pine-900 px-3 py-2 text-white"
            >
              {t('org.open')}
            </Link>
          </li>
        ))}
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
