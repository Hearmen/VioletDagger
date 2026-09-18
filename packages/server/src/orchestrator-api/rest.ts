import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

// 工作目录解析（见 01-storage.md §5.4 / 06-orchestrator-api.md 第 1 节）：
// 「~」展开 → 绝对化 → 校验存在且是目录；不填用 VIOLETDAGGER_WORKDIR，再退回 server cwd。
export function resolveWorkdir(input?: string): string {
  const raw = typeof input === 'string' && input.trim() !== ''
    ? input.trim()
    : (process.env.VIOLETDAGGER_WORKDIR ?? process.cwd());
  const expanded = raw === '~' ? os.homedir() : raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw;
  const absolute = path.resolve(expanded);
  let stat;
  try {
    stat = statSync(absolute);
  } catch {
    throw new ApiError(`workdir does not exist: ${absolute}`);
  }
  if (!stat.isDirectory()) {
    throw new ApiError(`workdir is not a directory: ${absolute}`);
  }
  return absolute;
}

export function listRoomsHandler(db: Database.Database): RoomSummary[] {
  return listRooms(db);
}

export function getRoomHandler(db: Database.Database, roomId: number): Room {
  const room = getRoom(db, roomId);
  if (!room) throw new ApiError(`room not found: ${roomId}`, 404);
  return room;
}

// 注意：这里的 agentId 是注册表 key（如 "codex"），不是房间内的实例标识——见 06-orchestrator-api.md 第 1 节。
// 四个内置 agent 均已适配；available=false 预留给未来"未通过 session 身份隔离适配"的 CLI（07 §17）。
export function listAgentsHandler(
  registry: AgentRegistry,
): { agentId: string; available: boolean; unavailableReason?: string }[] {
  return Object.keys(registry.agents).map((agentId) => ({ agentId, available: true }));
}

export function createRoomHandler(
  db: Database.Database,
  registry: AgentRegistry,
  body: { name: string; agentIds: string[]; schedulingMode: string; maxSessions?: number; workdir?: string },
): Room {
  if (typeof body.name !== 'string' || body.name.length === 0) {
    throw new ApiError('name must be a non-empty string');
  }
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
  if (body.maxSessions != null && (!Number.isInteger(body.maxSessions) || body.maxSessions <= 0)) {
    throw new ApiError('maxSessions must be a positive integer');
  }
  if (body.workdir != null && typeof body.workdir !== 'string') {
    throw new ApiError('workdir must be a string');
  }
  const workdir = resolveWorkdir(body.workdir);
  try {
    return createRoom(db, body.name, body.agentIds, 'sequential', { maxSessions: body.maxSessions, workdir });
  } catch (err) {
    throw new ApiError(err instanceof Error ? err.message : 'failed to create room');
  }
}
