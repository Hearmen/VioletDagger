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
    createdAt: row.created_at,
  };
}

export function createRoom(
  db: Database.Database,
  name: string,
  agentIds: string[],
  schedulingMode: 'sequential',
): Room {
  const createdAt = new Date().toISOString();
  const insertRoom = db.prepare(
    `INSERT INTO rooms (name, scheduling_mode, status, max_sessions, created_at) VALUES (?, ?, 'active', ?, ?)`,
  );
  const insertAgent = db.prepare(
    `INSERT INTO room_agents (room_id, agent_id, join_order, state) VALUES (?, ?, ?, 'idle')`,
  );
  const roomId = db.transaction(() => {
    const info = insertRoom.run(name, schedulingMode, DEFAULT_MAX_SESSIONS, createdAt);
    const id = info.lastInsertRowid as number;
    agentIds.forEach((agentId, idx) => insertAgent.run(id, agentId, idx));
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

function mapRoomAgentRow(row: any): RoomAgentState {
  return {
    roomId: row.room_id,
    agentId: row.agent_id,
    joinOrder: row.join_order,
    state: row.state,
    currentSessionSeq: row.current_session_seq,
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
  state: 'idle' | 'running',
  sessionSeq: number | null = null,
): void {
  db.prepare(
    `UPDATE room_agents SET state = ?, current_session_seq = ? WHERE room_id = ? AND agent_id = ?`,
  ).run(state, sessionSeq, roomId, agentId);
}
