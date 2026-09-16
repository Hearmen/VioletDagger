import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { RoomListPage } from './pages/RoomListPage';
import { RoomPage } from './pages/RoomPage';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<RoomListPage />} />
        <Route path="/rooms/:roomId" element={<RoomPage />} />
      </Routes>
    </BrowserRouter>
  );
}
