import { useEffect, useRef } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { SiteNav } from './SiteNav';
import { PrefsPanel } from './PrefsPanel';
import { FxOverlay } from '../fx/Overlay';
import { CookieNotice } from './CookieNotice';

/** App chrome: skip link, language sync, focus moves to <main> on route change, FX overlay (non-blocking). */
export function Layout() {
  const { t, i18n } = useTranslation();
  const main = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  const bare = pathname === '/d' || pathname.startsWith('/d/'); // public display: full-screen, no chrome

  useEffect(() => {
    document.documentElement.lang = i18n.language;
    document.title = t('app.title');
  }, [i18n.language, t]);

  useEffect(() => {
    main.current?.focus({ preventScroll: false });
  }, [pathname]);

  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[60] focus:rounded focus:bg-ink-900 focus:px-4 focus:py-2 focus:text-white"
        onClick={(e) => {
          e.preventDefault();
          main.current?.focus();
        }}
      >
        {t('a11y.skip')}
      </a>
      {!bare && (
        <header className="bg-santa-600 text-white">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-4 py-3 sm:gap-4">
            <Link
              to="/"
              className="inline-flex min-h-11 basis-full items-center rounded text-lg font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white sm:basis-auto"
            >
              {t('app.title')}
            </Link>
            <SiteNav />
            <div className="ml-auto">
              <PrefsPanel />
            </div>
          </div>
        </header>
      )}
      <main
        id="main"
        ref={main}
        tabIndex={-1}
        className={bare ? 'outline-none' : 'mx-auto max-w-3xl p-4 outline-none'}
      >
        <Outlet />
      </main>
      {!bare && (
        <footer className="mx-auto max-w-3xl p-4 text-sm">
          <nav aria-label={t('legal.nav')} className="flex flex-wrap gap-4">
            <Link to="/legal/privacy" className="underline">
              {t('legal.privacy')}
            </Link>
            <Link to="/legal/terms" className="underline">
              {t('legal.terms')}
            </Link>
            <Link to="/legal/cookies" className="underline">
              {t('legal.cookies')}
            </Link>
            <Link to="/credits" className="underline">
              {t('credits.link')}
            </Link>
          </nav>
        </footer>
      )}
      {!bare && <CookieNotice />}
      <FxOverlay />
    </>
  );
}
