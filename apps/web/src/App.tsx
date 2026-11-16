import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Layout } from './components/Layout';

const SignIn = lazy(() => import('./pages/SignIn'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Console = lazy(() => import('./pages/Console'));
const Join = lazy(() => import('./pages/Join'));
const Participant = lazy(() => import('./pages/Participant'));
const Display = lazy(() => import('./pages/Display'));

export function App() {
  const { t } = useTranslation();
  return (
    <Suspense fallback={<p>{t('a11y.loading')}</p>}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/o" element={<Dashboard />} />
          <Route path="/o/signin" element={<SignIn />} />
          <Route path="/o/events/:eventId" element={<Console />} />
          <Route path="/e/*" element={<Participant />} />
          <Route path="/d/*" element={<Display />} />
          <Route path="/j/*" element={<Join />} />
          <Route path="*" element={<Navigate to="/j" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
