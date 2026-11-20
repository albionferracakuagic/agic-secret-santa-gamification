import { NavLink, useMatch } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useOrganizer } from '../auth/session';

const navLink = ({ isActive }: { isActive: boolean }) =>
  `inline-flex min-h-11 items-center rounded px-3 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white ${
    isActive
      ? 'bg-white text-santa-700 underline decoration-2 underline-offset-4'
      : 'hover:bg-santa-700'
  }`;

function DashboardLink() {
  const { t } = useTranslation();
  const me = useOrganizer();
  if (!me.isSuccess || !me.data) return null;
  return (
    <NavLink to="/o" end className={navLink}>
      {t('nav.dashboard')}
    </NavLink>
  );
}

export function SiteNav() {
  const { t } = useTranslation();
  const home = useMatch('/');
  const organizer = useMatch('/o/*');
  return (
    <nav aria-label={t('nav.primary')} className="flex flex-wrap gap-1">
      <NavLink to="/" end className={navLink}>
        {t('nav.home')}
      </NavLink>
      <NavLink to="/j" className={navLink}>
        {t('route.join')}
      </NavLink>
      {/* Guest/claim/play routes never query or advertise organizer access, even in a shared browser. */}
      {(home || organizer) && <DashboardLink />}
    </nav>
  );
}
