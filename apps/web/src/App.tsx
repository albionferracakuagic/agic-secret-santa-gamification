import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Layout } from './components/Layout';
import { Placeholder } from './routes/Placeholder';

const SignIn = lazy(() => import('./pages/SignIn'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Console = lazy(() => import('./pages/Console'));

export function App() {
  const { t } = useTranslation();
  return (
    <Suspense fallback={<p>{t('a11y.loading')}</p>}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/o" element={<Dashboard />} />
          <Route path="/o/signin" element={<SignIn />} />
          <Route path="/o/events/:eventId" element={<Console />} />
          <Route path="/e/*" element={<Placeholder routeKey="participant" />} />
          <Route path="/d/*" element={<Placeholder routeKey="display" />} />
          <Route path="/j/*" element={<Placeholder routeKey="join" />} />
          <Route path="*" element={<Navigate to="/j" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
