import type Database from 'better-sqlite3';
import type { Room, RoomSummary, RoomStatus, RoomAgentState } from './types';

const DEFAULT_MAX_SESSIONS = 20;

function mapRoomRow(row: any): Room {
  return {
    id: row.id,
    name: row.name,
    schedulingMode: row.scheduling_mode,
    status: row.status,
    maxSessions: row.max_sessions,
    workdir: row.workdir ?? '',
    createdAt: row.created_at,
  };
}

// 实例标识生成（见 docs/design/01-storage.md）：同一个注册表 key 只出现一次时实例标识就是该 key，
// 出现多次时按出现顺序编号 "codex-1"/"codex-2"……。
export function assignInstanceIds(
  registryKeys: string[],
): { agentId: string; registryKey: string }[] {
  const totals = new Map<string, number>();
  for (const key of registryKeys) totals.set(key, (totals.get(key) ?? 0) + 1);

  const seen = new Map<string, number>();
  const assigned = registryKeys.map((registryKey) => {
    if (totals.get(registryKey) === 1) return { agentId: registryKey, registryKey };
    const index = (seen.get(registryKey) ?? 0) + 1;
    seen.set(registryKey, index);
    return { agentId: `${registryKey}-${index}`, registryKey };
  });

  const unique = new Set(assigned.map((entry) => entry.agentId));
  if (unique.size !== assigned.length) {
    throw new Error(`agent instance id collision while creating room: ${assigned.map((a) => a.agentId).join(', ')}`);
  }
  return assigned;
}

export interface CreateRoomOptions {
  maxSessions?: number; // 正整数，缺省 20
  workdir?: string;     // 绝对路径（由 06 层解析/校验）；缺省写 ''，表示按服务端默认目录兜底
}

export function createRoom(
  db: Database.Database,
  name: string,
  agentIds: string[],
  schedulingMode: 'sequential',
  options: CreateRoomOptions = {},
): Room {
  const { maxSessions, workdir } = options;
  if (maxSessions != null && (!Number.isInteger(maxSessions) || maxSessions <= 0)) {
    throw new Error('maxSessions must be a positive integer');
  }
  const createdAt = new Date().toISOString();
  const agents = assignInstanceIds(agentIds);
  const maxSessionsValue = maxSessions ?? DEFAULT_MAX_SESSIONS;
  const workdirValue = workdir?.trim() ? workdir.trim() : '';
  const insertRoom = db.prepare(
    `INSERT INTO rooms (name, scheduling_mode, status, max_sessions, workdir, created_at) VALUES (?, ?, 'active', ?, ?, ?)`,
  );
  const insertAgent = db.prepare(
    `INSERT INTO room_agents (room_id, agent_id, registry_key, join_order, state) VALUES (?, ?, ?, ?, 'idle')`,
  );
  const roomId = db.transaction(() => {
    const info = insertRoom.run(name, schedulingMode, maxSessionsValue, workdirValue, createdAt);
    const id = info.lastInsertRowid as number;
    agents.forEach((agent, idx) => insertAgent.run(id, agent.agentId, agent.registryKey, idx));
    return id;
  })();
  return getRoom(db, roomId)!;
}

export function getRoom(db: Database.Database, roomId: number): Room | null {
  const row = db.prepare(`SELECT * FROM rooms WHERE id = ?`).get(roomId);
  return row ? mapRoomRow(row) : null;
}

export function listRooms(db: Database.Database): RoomSummary[] {
  const rows = db.prepare(`SELECT * FROM rooms ORDER BY id ASC`).all() as any[];
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    status: row.status,
    createdAt: row.created_at,
  }));
}

export function setRoomStatus(db: Database.Database, roomId: number, status: RoomStatus): void {
  db.prepare(`UPDATE rooms SET status = ? WHERE id = ?`).run(status, roomId);
}

export function increaseMaxSessions(db: Database.Database, roomId: number, additional: number): void {
  db.prepare(`UPDATE rooms SET max_sessions = max_sessions + ? WHERE id = ?`).run(additional, roomId);
}

// 级联删除一个 room 的全部数据（见 docs/design/01-storage.md）。只删 DB，不碰磁盘文件。
export function deleteRoom(db: Database.Database, roomId: number): void {
  db.transaction(() => {
    db.prepare(`DELETE FROM message_references WHERE room_id = ?`).run(roomId);
    db.prepare(`DELETE FROM messages WHERE room_id = ?`).run(roomId);
    db.prepare(`DELETE FROM session_events WHERE room_id = ?`).run(roomId);
    db.prepare(`DELETE FROM sessions WHERE room_id = ?`).run(roomId);
    db.prepare(`DELETE FROM room_agents WHERE room_id = ?`).run(roomId);
    db.prepare(`DELETE FROM rooms WHERE id = ?`).run(roomId);
  })();
}

function mapRoomAgentRow(row: any): RoomAgentState {
  return {
    roomId: row.room_id,
    agentId: row.agent_id,
    registryKey: row.registry_key,
    joinOrder: row.join_order,
    state: row.state,
    currentSessionSeq: row.current_session_seq,
    dispatchEnabled: row.dispatch_enabled !== 0,
  };
}

export function getRoomAgents(db: Database.Database, roomId: number): RoomAgentState[] {
  const rows = db
    .prepare(`SELECT * FROM room_agents WHERE room_id = ? ORDER BY join_order ASC`)
    .all(roomId) as any[];
  return rows.map(mapRoomAgentRow);
}

export function setAgentState(
  db: Database.Database,
  roomId: number,
  agentId: string,
  state: 'idle' | 'running' | 'stopping',
  sessionSeq: number | null = null,
): void {
  db.prepare(
    `UPDATE room_agents SET state = ?, current_session_seq = ? WHERE room_id = ? AND agent_id = ?`,
  ).run(state, sessionSeq, roomId, agentId);
}

export function setAgentEnabled(
  db: Database.Database,
  roomId: number,
  agentId: string,
  enabled: boolean,
): void {
  db.prepare(`UPDATE room_agents SET dispatch_enabled = ? WHERE room_id = ? AND agent_id = ?`)
    .run(enabled ? 1 : 0, roomId, agentId);
}
