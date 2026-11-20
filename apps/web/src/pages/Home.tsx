import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

export default function Home() {
  const { t } = useTranslation();
  return (
    <section aria-labelledby="home-title" className="space-y-4">
      <h1 id="home-title" className="text-3xl font-bold">
        {t('app.title')}
      </h1>
      <p>{t('home.intro')}</p>
      <div className="flex flex-wrap gap-3">
        <Link
          to="/create"
          className="inline-flex min-h-12 items-center rounded bg-santa-600 px-4 font-bold text-white hover:bg-santa-700"
        >
          {t('org.create')}
        </Link>
        <Link
          to="/j"
          className="inline-flex min-h-12 items-center rounded border border-pine-900 px-4 font-bold text-pine-900 hover:bg-snow-100"
        >
          {t('route.join')}
        </Link>
      </div>
    </section>
  );
}
