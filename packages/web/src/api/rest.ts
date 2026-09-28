import type { AgentInfo, Room, RoomSummary } from './types';

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    if (body?.error?.message) return body.error.message as string;
  } catch {
    // ignore body parse failure
  }
  return fallback;
}

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

// GET /api/agents 的 agentId 是注册表 key（如 "codex"），不是房间内的 agent 实例标识。
export async function fetchAgents(): Promise<AgentInfo[]> {
  const res = await fetch('/api/agents');
  if (!res.ok) throw new Error('failed to fetch agents');
  return res.json();
}

export async function createRoom(body: {
  name: string;
  agentIds: string[];
  schedulingMode: 'sequential';
  maxSessions?: number;
  workdir?: string;
}): Promise<Room> {
  const res = await fetch('/api/rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errorMessage(res, 'failed to create room'));
  return res.json();
}

export async function deleteRoom(roomId: number): Promise<void> {
  const res = await fetch(`/api/rooms/${roomId}`, { method: 'DELETE' });
  if (!res.ok) {
    let message = 'failed to delete room';
    try {
      const body = await res.json();
      if (body?.error?.message) message = body.error.message;
    } catch {
      // ignore body parse failure
    }
    throw new Error(message);
  }
}
