import type Database from 'better-sqlite3';
import type { Session, SessionOutcome } from './types';

function mapSessionRow(row: any): Session {
  return {
    roomId: row.room_id,
    seq: row.seq,
    agentId: row.agent_id,
    outcome: row.outcome,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    pgid: row.pgid,
    rawLogPath: row.raw_log_path,
  };
}

export function createSession(db: Database.Database, roomId: number, agentId: string): Session {
  const startedAt = new Date().toISOString();
  const seq = db.transaction(() => {
    const row = db
      .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq FROM sessions WHERE room_id = ?`)
      .get(roomId) as { nextSeq: number };
    db.prepare(
      `INSERT INTO sessions (room_id, seq, agent_id, outcome, started_at) VALUES (?, ?, ?, 'running', ?)`,
    ).run(roomId, row.nextSeq, agentId, startedAt);
    return row.nextSeq;
  })();
  return getSession(db, roomId, seq)!;
}

export function setSessionPgid(db: Database.Database, roomId: number, seq: number, pgid: number): void {
  db.prepare(`UPDATE sessions SET pgid = ? WHERE room_id = ? AND seq = ?`).run(pgid, roomId, seq);
}

export function finishSession(
  db: Database.Database,
  roomId: number,
  seq: number,
  outcome: SessionOutcome,
  rawLogPath?: string,
): void {
  const endedAt = new Date().toISOString();
  db.prepare(
    `UPDATE sessions SET outcome = ?, ended_at = ?, raw_log_path = COALESCE(?, raw_log_path) WHERE room_id = ? AND seq = ?`,
  ).run(outcome, endedAt, rawLogPath ?? null, roomId, seq);
}

export function getSession(db: Database.Database, roomId: number, seq: number): Session | null {
  const row = db.prepare(`SELECT * FROM sessions WHERE room_id = ? AND seq = ?`).get(roomId, seq);
  return row ? mapSessionRow(row) : null;
}

export function listSessions(db: Database.Database, roomId: number): Session[] {
  const rows = db
    .prepare(`SELECT * FROM sessions WHERE room_id = ? ORDER BY seq ASC`)
    .all(roomId) as any[];
  return rows.map(mapSessionRow);
}

export function countSessions(db: Database.Database, roomId: number): number {
  const row = db
    .prepare(`SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM sessions WHERE room_id = ?`)
    .get(roomId) as { maxSeq: number };
  return row.maxSeq;
}
