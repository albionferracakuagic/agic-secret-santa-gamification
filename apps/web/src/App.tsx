import { Navigate, Route, Routes } from 'react-router-dom';
import { Placeholder } from './routes/Placeholder';

export function App() {
  return (
    <Routes>
      <Route path="/o/*" element={<Placeholder routeKey="organizer" />} />
      <Route path="/e/*" element={<Placeholder routeKey="participant" />} />
      <Route path="/d/*" element={<Placeholder routeKey="display" />} />
      <Route path="/j/*" element={<Placeholder routeKey="join" />} />
      <Route path="*" element={<Navigate to="/j" replace />} />
    </Routes>
  );
}
