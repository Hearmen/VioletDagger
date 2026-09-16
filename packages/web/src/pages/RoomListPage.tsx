import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchRooms, fetchAgents, createRoom } from '../api/rest';
import type { RoomSummary } from '../api/types';

export function RoomListPage() {
  const navigate = useNavigate();
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchRooms().then(setRooms).catch((err: Error) => setError(err.message));
    fetchAgents()
      .then((agents) => setAgentIds(agents.map((a) => a.agentId)))
      .catch((err: Error) => setError(err.message));
  }, []);

  function toggleAgent(agentId: string) {
    setSelectedAgents((prev) =>
      prev.includes(agentId) ? prev.filter((id) => id !== agentId) : [...prev, agentId],
    );
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const room = await createRoom({ name, agentIds: selectedAgents, schedulingMode: 'sequential' });
      navigate(`/rooms/${room.id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div>
      <h1>Rooms</h1>
      {error && <p role="alert">{error}</p>}
      <ul>
        {rooms.map((room) => (
          <li key={room.id}>
            <a href={`/rooms/${room.id}`}>{room.name}</a> — {room.status}
          </li>
        ))}
      </ul>
      <form onSubmit={handleSubmit}>
        <input aria-label="room name" value={name} onChange={(e) => setName(e.target.value)} />
        {agentIds.map((agentId) => (
          <label key={agentId}>
            <input
              type="checkbox"
              aria-label={agentId}
              checked={selectedAgents.includes(agentId)}
              onChange={() => toggleAgent(agentId)}
            />
            {agentId}
          </label>
        ))}
        <label>
          <input type="radio" checked readOnly /> sequential
        </label>
        <button type="submit" disabled={!name || selectedAgents.length === 0}>
          Create
        </button>
      </form>
    </div>
  );
}
