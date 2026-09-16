import type { Room, RoomSummary } from './types';

export async function fetchRooms(): Promise<RoomSummary[]> {
  const res = await fetch('/api/rooms');
  if (!res.ok) throw new Error('failed to fetch rooms');
  return res.json();
}

export async function fetchRoom(roomId: number): Promise<Room> {
  const res = await fetch(`/api/rooms/${roomId}`);
  if (!res.ok) throw new Error('failed to fetch room');
  return res.json();
}

export async function fetchAgents(): Promise<{ agentId: string }[]> {
  const res = await fetch('/api/agents');
  if (!res.ok) throw new Error('failed to fetch agents');
  return res.json();
}

export async function createRoom(body: {
  name: string;
  agentIds: string[];
  schedulingMode: 'sequential';
}): Promise<Room> {
  const res = await fetch('/api/rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('failed to create room');
  return res.json();
}
