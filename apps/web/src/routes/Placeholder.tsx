import { useTranslation } from 'react-i18next';

type RouteKey = 'organizer' | 'participant' | 'display' | 'join';

export function Placeholder({ routeKey }: { routeKey: RouteKey }) {
  const { t } = useTranslation();
  return (
    <section className="p-4">
      <h1 className="text-xl font-semibold">{t(`route.${routeKey}`)}</h1>
    </section>
  );
}
