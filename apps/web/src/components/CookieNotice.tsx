import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

const KEY = 'sg.cookieNotice';

/** Essential cookies only: an information notice (no consent choice needed), dismissible and remembered locally. */
export function CookieNotice() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(() => localStorage.getItem(KEY) !== 'ack');
  if (!open) return null;
  return (
    <aside
      aria-label={t('cookie.title')}
      className="fixed inset-x-2 bottom-2 z-[55] mx-auto max-w-xl rounded-lg bg-ink-900 p-3 text-white shadow-lg"
      data-testid="cookie-notice"
    >
      <p>
        {t('cookie.text')}{' '}
        <Link to="/legal/cookies" className="underline">
          {t('cookie.more')}
        </Link>
      </p>
      <button
        type="button"
        className="mt-2 min-h-11 rounded bg-gold-400 px-4 font-semibold text-ink-900"
        onClick={() => {
          localStorage.setItem(KEY, 'ack');
          setOpen(false);
        }}
      >
        {t('cookie.ok')}
      </button>
    </aside>
  );
}
