import type { Room, RoomStatusPayload } from '../api/types';

export function RoomHeader(props: {
  room: Room;
  status: RoomStatusPayload;
  onPause: () => void;
  onResume: (additionalSessions?: number) => void;
  onConfirmCompletion: () => void;
}) {
  const { room, status, onPause, onResume, onConfirmCompletion } = props;
  const readOnly = status.status === 'completed';

  function handleResume() {
    if (status.status === 'paused_limit') {
      const raw = window.prompt('additionalSessions (required)');
      if (!raw) return;
      onResume(Number(raw));
    } else {
      onResume();
    }
  }

  return (
    <header>
      <h1>{room.name}</h1>
      <span>{status.status}</span>
      <span>{status.currentSessionCount}/{room.maxSessions} sessions</span>
      {!readOnly && status.status === 'active' && <button onClick={onPause}>Pause</button>}
      {!readOnly && status.status !== 'active' && <button onClick={handleResume}>Resume</button>}
      {!readOnly && <button onClick={onConfirmCompletion}>Confirm Completion</button>}
    </header>
  );
}
