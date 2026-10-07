import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { RoomListPage } from './pages/RoomListPage';
import { RoomDashboardPage } from './pages/RoomDashboardPage';
import { LocaleProvider } from './i18n/LocaleProvider';

export function App() {
  return (
    <LocaleProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<RoomListPage />} />
          <Route path="/rooms/:roomId" element={<RoomDashboardPage />} />
        </Routes>
      </BrowserRouter>
    </LocaleProvider>
  );
}
