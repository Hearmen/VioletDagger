import type Database from 'better-sqlite3';
import type { Session, SessionEvent, SessionEventKind, SessionExitCause, SessionOutcome } from './types';

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
    exitCode: row.exit_code ?? null,
    exitSignal: row.exit_signal ?? null,
    stopIntent: row.stop_intent ?? null,
    cleanupStartedAt: row.cleanup_started_at ?? null,
    exitCause: row.exit_cause ?? null,
  };
}

function mapSessionEventRow(row: any): SessionEvent {
  return {
    id: row.id,
    roomId: row.room_id,
    sessionSeq: row.session_seq,
    kind: row.kind,
    attemptId: row.attempt_id,
    detail: row.detail ?? null,
    createdAt: row.created_at,
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

export function setSessionRawLogPath(db: Database.Database, roomId: number, seq: number, rawLogPath: string): void {
  db.prepare(`UPDATE sessions SET raw_log_path = ? WHERE room_id = ? AND seq = ?`).run(rawLogPath, roomId, seq);
}

// 人工终止把 running 置 stopping（stopIntent=terminate），只在确认退出或从未启动后才结算 terminated。
// 返回是否发生了迁移，供调用方决定是否重复记录终止事件。
export function markSessionTerminating(
  db: Database.Database,
  roomId: number,
  seq: number,
): { changed: boolean; session: Session | null } {
  const result = db
    .prepare(
      `UPDATE sessions SET outcome = 'stopping', stop_intent = 'terminate'
       WHERE room_id = ? AND seq = ? AND outcome = 'running'`,
    )
    .run(roomId, seq);
  return { changed: result.changes > 0, session: getSession(db, roomId, seq) };
}

export function markSessionCleanupStarted(
  db: Database.Database,
  roomId: number,
  seq: number,
  _attemptId: string,
): void {
  db.prepare(
    `UPDATE sessions SET cleanup_started_at = COALESCE(cleanup_started_at, ?)
     WHERE room_id = ? AND seq = ?`,
  ).run(new Date().toISOString(), roomId, seq);
}

// 事件只追加；一次性事件用 (room_id, session_seq, kind, attempt_id) 唯一索引做幂等（INSERT OR IGNORE）。
export function appendSessionEvent(
  db: Database.Database,
  roomId: number,
  seq: number,
  kind: SessionEventKind,
  detail?: string,
  attemptId = '',
): void {
  db.prepare(
    `INSERT OR IGNORE INTO session_events (room_id, session_seq, kind, attempt_id, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(roomId, seq, kind, attemptId, detail ?? null, new Date().toISOString());
}

export function listSessionEvents(db: Database.Database, roomId: number, seq: number): SessionEvent[] {
  const rows = db
    .prepare(`SELECT * FROM session_events WHERE room_id = ? AND session_seq = ? ORDER BY id ASC`)
    .all(roomId, seq) as any[];
  return rows.map(mapSessionEventRow);
}

export function finishSession(
  db: Database.Database,
  roomId: number,
  seq: number,
  outcome: Exclude<SessionOutcome, 'running' | 'stopping'>,
  rawLogPath?: string,
  exit?: { exitCode: number | null; signal: string | null; exitCause: SessionExitCause },
): void {
  const endedAt = new Date().toISOString();
  db.prepare(
    `UPDATE sessions SET
       outcome = ?, ended_at = ?, raw_log_path = COALESCE(?, raw_log_path),
       exit_code = COALESCE(?, exit_code), exit_signal = COALESCE(?, exit_signal),
       exit_cause = COALESCE(?, exit_cause)
     WHERE room_id = ? AND seq = ?`,
  ).run(
    outcome,
    endedAt,
    rawLogPath ?? null,
    exit?.exitCode ?? null,
    exit?.signal ?? null,
    exit?.exitCause ?? null,
    roomId,
    seq,
  );
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

// 该 agent 在本 room 最近一次 session 的开始时间；从没跑过返回 null（见 03 §1.2 派发判定）。
export function getLatestSessionStartedAt(db: Database.Database, roomId: number, agentId: string): string | null {
  const row = db.prepare(
    `SELECT MAX(started_at) AS latest FROM sessions WHERE room_id = ? AND agent_id = ?`,
  ).get(roomId, agentId) as { latest: string | null } | undefined;
  return row?.latest ?? null;
}

// 计入 maxSessions 上限的 session 数 = outcome != 'error' 的数量（error 不占配额）。
// session 的 seq 仍由 createSession 内部 MAX(seq)+1 生成，与本函数无关。
export function countSessions(db: Database.Database, roomId: number): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM sessions WHERE room_id = ? AND outcome != 'error'`)
    .get(roomId) as { count: number };
  return row.count;
}
