import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { usePlayApi } from '../api/play';
import { useAchievementName } from '../components/play/Achievements';
import { avatarGlyph } from '../fx/avatars';

/** /e/profile/:id — another participant's public profile: name, avatar, achievements only. */
export default function ProfilePage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const api = usePlayApi();
  const name = useAchievementName();
  const q = useQuery({ queryKey: ['profile', id], queryFn: () => api.profile(id), retry: false });
  return (
    <section aria-labelledby="profile-page-title" className="space-y-4">
      <Link to="/e" className="underline">
        {t('profilePage.back')}
      </Link>
      <h1 id="profile-page-title" className="text-2xl font-bold">
        {q.data ? (
          <>
            <span aria-hidden="true">{avatarGlyph(q.data.avatar)}</span> {q.data.displayName}
          </>
        ) : (
          t('profilePage.title')
        )}
      </h1>
      {q.isLoading && <p role="status">{t('a11y.loading')}</p>}
      {q.isError && <p role="alert">{t('profilePage.notFound')}</p>}
      {q.data &&
        (q.data.achievements.length === 0 ? (
          <p>{t('profilePage.none')}</p>
        ) : (
          <ul className="flex flex-wrap gap-2" data-testid="profile-achievements">
            {q.data.achievements.map((k) => (
              <li key={k} className="rounded-full bg-gold-400 px-4 py-2 font-semibold text-ink-900">
                🏅 {name(k)}
              </li>
            ))}
          </ul>
        ))}
    </section>
  );
}
