import type Database from 'better-sqlite3';
import type {
  DispatchScope, Session, SessionEvent, SessionEventKind, SessionExitCause, SessionOutcome, SessionUsage, UsageTotals,
} from './types';

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
    inputTokens: row.input_tokens ?? null,
    outputTokens: row.output_tokens ?? null,
    cacheReadTokens: row.cache_read_tokens ?? null,
    cacheWriteTokens: row.cache_write_tokens ?? null,
    costUsd: row.cost_usd ?? null,
    dispatchScope: row.dispatch_scope ?? 'broadcast',
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

// dispatchScope：'broadcast'（因广播触发型消息派发，默认）/ 'directed'（因定向给它的 @ 消息派发，
// 见需求 3.3.2），由调用方（checkAndDispatch）按 03 §1.2 的判定结果传入；不传按 'broadcast'
// 处理，兼容既有调用方（人工终止重试、测试夹具等不关心定向语义的场景）。
export function createSession(
  db: Database.Database,
  roomId: number,
  agentId: string,
  dispatchScope: DispatchScope = 'broadcast',
): Session {
  const startedAt = new Date().toISOString();
  const seq = db.transaction(() => {
    const row = db
      .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq FROM sessions WHERE room_id = ?`)
      .get(roomId) as { nextSeq: number };
    db.prepare(
      `INSERT INTO sessions (room_id, seq, agent_id, outcome, started_at, dispatch_scope) VALUES (?, ?, ?, 'running', ?, ?)`,
    ).run(roomId, row.nextSeq, agentId, startedAt, dispatchScope);
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
  usage?: SessionUsage,
): void {
  const endedAt = new Date().toISOString();
  db.prepare(
    `UPDATE sessions SET
       outcome = ?, ended_at = ?, raw_log_path = COALESCE(?, raw_log_path),
       exit_code = COALESCE(?, exit_code), exit_signal = COALESCE(?, exit_signal),
       exit_cause = COALESCE(?, exit_cause),
       input_tokens = COALESCE(?, input_tokens), output_tokens = COALESCE(?, output_tokens),
       cache_read_tokens = COALESCE(?, cache_read_tokens), cache_write_tokens = COALESCE(?, cache_write_tokens),
       cost_usd = COALESCE(?, cost_usd)
     WHERE room_id = ? AND seq = ?`,
  ).run(
    outcome,
    endedAt,
    rawLogPath ?? null,
    exit?.exitCode ?? null,
    exit?.signal ?? null,
    exit?.exitCause ?? null,
    usage?.inputTokens ?? null,
    usage?.outputTokens ?? null,
    usage?.cacheReadTokens ?? null,
    usage?.cacheWriteTokens ?? null,
    usage?.costUsd ?? null,
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

// 计入 maxSessions 上限的 session 数 = 本 room 的 session 总数（不区分 outcome，error 同样计入，需求 3.3）。
export function countSessions(db: Database.Database, roomId: number): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM sessions WHERE room_id = ?`)
    .get(roomId) as { count: number };
  return row.count;
}

function emptyUsageTotals(): UsageTotals {
  return {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    costUsd: null, sessionCount: 0, sessionsWithoutTokens: 0, sessionsWithoutCost: 0,
  };
}

function accumulateUsage(totals: UsageTotals, row: {
  inputTokens: number | null; outputTokens: number | null;
  cacheReadTokens: number | null; cacheWriteTokens: number | null; costUsd: number | null;
}): void {
  totals.sessionCount += 1;
  const hasAnyTokens =
    row.inputTokens != null || row.outputTokens != null || row.cacheReadTokens != null || row.cacheWriteTokens != null;
  if (!hasAnyTokens) totals.sessionsWithoutTokens += 1;
  totals.inputTokens += row.inputTokens ?? 0;
  totals.outputTokens += row.outputTokens ?? 0;
  totals.cacheReadTokens += row.cacheReadTokens ?? 0;
  totals.cacheWriteTokens += row.cacheWriteTokens ?? 0;
  if (row.costUsd == null) {
    totals.sessionsWithoutCost += 1;
  } else {
    totals.costUsd = (totals.costUsd ?? 0) + row.costUsd;
  }
}

// 按 agent 和整个房间两级聚合用量（01-storage.md 用量统计修订）。只统计已结束的 session
// （outcome 非 running/stopping）——还在跑的 session 用量没定，不计入，也不算"缺数据"。
export function getUsageTotals(
  db: Database.Database,
  roomId: number,
): { byAgent: Record<string, UsageTotals>; room: UsageTotals } {
  const rows = db
    .prepare(
      `SELECT agent_id AS agentId, input_tokens AS inputTokens, output_tokens AS outputTokens,
         cache_read_tokens AS cacheReadTokens, cache_write_tokens AS cacheWriteTokens, cost_usd AS costUsd
       FROM sessions WHERE room_id = ? AND outcome NOT IN ('running', 'stopping')`,
    )
    .all(roomId) as {
    agentId: string; inputTokens: number | null; outputTokens: number | null;
    cacheReadTokens: number | null; cacheWriteTokens: number | null; costUsd: number | null;
  }[];

  const byAgent: Record<string, UsageTotals> = {};
  const room = emptyUsageTotals();
  for (const row of rows) {
    if (!byAgent[row.agentId]) byAgent[row.agentId] = emptyUsageTotals();
    accumulateUsage(byAgent[row.agentId], row);
    accumulateUsage(room, row);
  }
  return { byAgent, room };
}
