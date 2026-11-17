import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate } from 'react-router-dom';
import { api } from '../api/client';
import { useOrganizer, useProviders } from '../auth/session';

export default function SignIn() {
  const { t } = useTranslation();
  const me = useOrganizer();
  const providers = useProviders();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(false);

  if (me.data) return <Navigate to="/o" replace />;

  const sendLink = async (e: FormEvent) => {
    e.preventDefault();
    setError(false);
    try {
      await api('/api/auth/sign-in/magic-link', {
        method: 'POST',
        body: { email, callbackURL: '/o' },
      });
      setSent(true);
    } catch {
      setError(true);
    }
  };

  const social = async (provider: 'google' | 'microsoft') => {
    const r = await api<{ url?: string }>('/api/auth/sign-in/social', {
      method: 'POST',
      body: { provider, callbackURL: '/o' },
    });
    if (r.url) window.location.href = r.url;
  };

  const btn =
    'min-h-12 w-full rounded bg-santa-600 px-4 font-semibold text-white hover:bg-santa-700';
  const p = providers.data?.providers;

  return (
    <section aria-labelledby="signin-title" className="space-y-4">
      <h1 id="signin-title" className="text-2xl font-bold">
        {t('signin.title')}
      </h1>
      <form onSubmit={sendLink} className="space-y-3">
        <label className="block">
          {t('signin.email')}
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 block min-h-12 w-full rounded border border-ink-900/50 px-3"
          />
        </label>
        <button type="submit" className={btn}>
          {t('signin.send')}
        </button>
      </form>
      <div role="status" aria-live="polite">
        {sent && <p className="rounded bg-pine-900 p-3 text-white">{t('signin.sent')}</p>}
      </div>
      {error && (
        <p role="alert" className="rounded bg-santa-700 p-3 text-white">
          {t('error.generic')}
        </p>
      )}
      {(p?.google || p?.microsoft) && (
        <>
          <p className="text-center">{t('signin.or')}</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            {p.google && (
              <button type="button" className={btn} onClick={() => void social('google')}>
                {t('signin.google')}
              </button>
            )}
            {p.microsoft && (
              <button type="button" className={btn} onClick={() => void social('microsoft')}>
                {t('signin.microsoft')}
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
