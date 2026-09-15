import type Database from 'better-sqlite3';
import { createRoom, getRoom, listRooms } from '../storage';
import type { Room, RoomSummary } from '../storage';
import type { AgentRegistry } from '../agent-invocation';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export function listRoomsHandler(db: Database.Database): RoomSummary[] {
  return listRooms(db);
}

export function getRoomHandler(db: Database.Database, roomId: number): Room {
  const room = getRoom(db, roomId);
  if (!room) throw new ApiError(`room not found: ${roomId}`, 404);
  return room;
}

export function listAgentsHandler(registry: AgentRegistry): { agentId: string }[] {
  return Object.keys(registry.agents).map((agentId) => ({ agentId }));
}

export function createRoomHandler(
  db: Database.Database,
  registry: AgentRegistry,
  body: { name: string; agentIds: string[]; schedulingMode: string },
): Room {
  if (!body.agentIds || body.agentIds.length === 0) {
    throw new ApiError('agentIds must be a non-empty array');
  }
  for (const agentId of body.agentIds) {
    if (!registry.agents[agentId]) {
      throw new ApiError(`unknown agentId: ${agentId}`);
    }
  }
  if (body.schedulingMode !== 'sequential') {
    throw new ApiError('schedulingMode must be "sequential" in v1');
  }
  return createRoom(db, body.name, body.agentIds, 'sequential');
}
