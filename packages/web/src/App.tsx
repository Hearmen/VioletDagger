import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { RoomListPage } from './pages/RoomListPage';
import { RoomDashboardPage } from './pages/RoomDashboardPage';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<RoomListPage />} />
        <Route path="/rooms/:roomId" element={<RoomDashboardPage />} />
      </Routes>
    </BrowserRouter>
  );
}
