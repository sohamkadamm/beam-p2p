import { Route, Routes } from 'react-router-dom';
import HostPage from './pages/HostPage';
import GuestPage from './pages/GuestPage';
import StatsPage from './pages/StatsPage';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HostPage />} />
      <Route path="/r/:token" element={<GuestPage />} />
      <Route path="/stats" element={<StatsPage />} />
      <Route path="*" element={<HostPage />} />
    </Routes>
  );
}
