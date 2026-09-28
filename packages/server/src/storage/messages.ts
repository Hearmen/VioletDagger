import type Database from 'better-sqlite3';
import type {
  ChainStatus, CloseReason, InsertMessageParams, Message, MessageType, StateTransition,
} from './types';

const SUMMARY_MAX_LEN = 80;

function rowToMessage(row: any, referencedMessageIds: number[]): Message {
  return {
    id: row.id,
    roomId: row.room_id,
    sessionSeq: row.session_seq,
    authorId: row.author_id,
    type: row.type,
    content: row.content,
    summary: row.summary,
    targetMessageId: row.target_message_id,
    targetAgentId: row.target_agent_id ?? null,
    referencedMessageIds,
    questionStatus: row.question_status ?? null,
    questionCloseReason: row.question_close_reason ?? null,
    questionClosedBy: row.question_closed_by ?? null,
    chainStatus: row.chain_status ?? null,
    closesQuestion: row.closes_question === 1,
    chainResolution: row.chain_resolution ?? null,
    verifyVerdict: row.verify_verdict == null ? null : row.verify_verdict === 1,
    exploringStatus: row.exploring_status,
    exploringNote: row.exploring_note,
    exploringEndReason: row.exploring_end_reason ?? null,
    exploringResultSummary: row.exploring_result_summary ?? null,
    exploringResultMessageIds: JSON.parse(row.exploring_result_message_ids ?? '[]'),
    createdAt: row.created_at,
  };
}

export function mapMessageRow(db: Database.Database, row: any): Message {
  const refs = db
    .prepare(`SELECT referenced_message_id FROM message_references WHERE room_id = ? AND message_id = ?`)
    .all(row.room_id, row.id) as { referenced_message_id: number }[];
  return rowToMessage(row, refs.map((r) => r.referenced_message_id));
}

// 把核心的一次"校验 → 插入 → 状态转换"包成一个事务（better-sqlite3 的 db.transaction 允许嵌套）。
export function runInTransaction<T>(db: Database.Database, fn: () => T): T {
  return db.transaction(fn)();
}

// 消息 id 是 room 内自增（见 docs/design/01-storage.md §5.5），所以必须带 roomId。
export function getMessageById(db: Database.Database, roomId: number, id: number): Message | null {
  const row = db.prepare(`SELECT * FROM messages WHERE room_id = ? AND id = ?`).get(roomId, id);
  return row ? mapMessageRow(db, row) : null;
}

// 纯插入：生成 room 内 id、summary 自动截断、按 type 写初始状态、写 message_references。
// 不做业务校验、不做状态转换——这些都在编排器核心的 submitMessage 里（见 01-storage.md §2）。
export function insertMessage(db: Database.Database, params: InsertMessageParams): Message {
  const createdAt = new Date().toISOString();
  const summary = params.summary ?? params.content.slice(0, SUMMARY_MAX_LEN);
  const type = params.type ?? null;
  const isChain = type === 'chain';
  const closesQuestion = isChain && params.closesQuestion === true;

  const id = db.transaction(() => {
    // room 内自增 id，在同一事务内生成，配合主键 (room_id, id) 保证并发也不会重复。
    const next = db
      .prepare(`SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM messages WHERE room_id = ?`)
      .get(params.roomId) as { nextId: number };
    const nextId = next.nextId;

    db.prepare(
      `INSERT INTO messages (
         room_id, id, session_seq, author_id, type, content, summary, target_message_id, target_agent_id,
         question_status, chain_status, closes_question, chain_resolution, verify_verdict, exploring_status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      params.roomId, nextId, params.sessionSeq, params.authorId, type,
      params.content, summary, params.targetMessageId ?? null, params.targetAgentId ?? null,
      type === 'open_question' ? 'OPEN' : null,
      isChain ? 'CANDIDATE' : null,
      closesQuestion ? 1 : 0,
      closesQuestion ? params.chainResolution ?? null : null,
      type === 'verify' && params.verifyVerdict != null ? (params.verifyVerdict ? 1 : 0) : null,
      type === 'exploring' ? 'active' : null,
      createdAt,
    );

    if (params.referencedMessageIds?.length) {
      const insertRef = db.prepare(
        `INSERT INTO message_references (room_id, message_id, referenced_message_id) VALUES (?, ?, ?)`,
      );
      for (const refId of new Set(params.referencedMessageIds)) insertRef.run(params.roomId, nextId, refId);
    }
    return nextId;
  })();

  return getMessageById(db, params.roomId, id)!;
}

// room 内 id 最小的一条消息，即 goal。
export function getFirstMessage(db: Database.Database, roomId: number): Message | null {
  const row = db.prepare(`SELECT * FROM messages WHERE room_id = ? ORDER BY id ASC LIMIT 1`).get(roomId);
  return row ? mapMessageRow(db, row) : null;
}

export function countMessages(db: Database.Database, roomId: number): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM messages WHERE room_id = ?`).get(roomId) as { count: number };
  return row.count;
}

export function getMessagesBySession(db: Database.Database, roomId: number, seq: number): Message[] {
  const rows = db
    .prepare(`SELECT * FROM messages WHERE room_id = ? AND session_seq = ? ORDER BY id ASC`)
    .all(roomId, seq) as any[];
  return rows.map((row) => mapMessageRow(db, row));
}

export function listMessages(
  db: Database.Database,
  roomId: number,
  cursor?: number,
  limit = 30,
): { messages: Message[]; nextCursor: number | null } {
  const rows = (
    cursor !== undefined
      ? db
          .prepare(`SELECT * FROM messages WHERE room_id = ? AND id < ? ORDER BY id DESC LIMIT ?`)
          .all(roomId, cursor, limit + 1)
      : db
          .prepare(`SELECT * FROM messages WHERE room_id = ? ORDER BY id DESC LIMIT ?`)
          .all(roomId, limit + 1)
  ) as any[];
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const messages = pageRows.map((row) => mapMessageRow(db, row)).reverse();
  const nextCursor = hasMore && messages.length > 0 ? messages[0].id : null;
  return { messages, nextCursor };
}

// 按当前 type 查。
export function getMessagesByType(db: Database.Database, roomId: number, type: MessageType): Message[] {
  const rows = db
    .prepare(`SELECT * FROM messages WHERE room_id = ? AND type = ? ORDER BY id ASC`)
    .all(roomId, type) as any[];
  return rows.map((row) => mapMessageRow(db, row));
}

// 批量读取 room 全部消息（含 referencedMessageIds），供记忆投影一次性建表，避免逐条查询。
export function getRoomMessages(db: Database.Database, roomId: number): Message[] {
  const rows = db.prepare('SELECT * FROM messages WHERE room_id = ? ORDER BY id').all(roomId) as any[];
  const references = db
    .prepare('SELECT message_id, referenced_message_id FROM message_references WHERE room_id = ? ORDER BY referenced_message_id')
    .all(roomId) as { message_id: number; referenced_message_id: number }[];
  const refs = new Map<number, number[]>();
  for (const ref of references) {
    if (!refs.has(ref.message_id)) refs.set(ref.message_id, []);
    refs.get(ref.message_id)!.push(ref.referenced_message_id);
  }
  return rows.map((row) => rowToMessage(row, refs.get(row.id) ?? []));
}

export function getRecentRawMessages(db: Database.Database, roomId: number, n: number): Message[] {
  const rows = db
    .prepare(`SELECT * FROM messages WHERE room_id = ? ORDER BY id DESC LIMIT ?`)
    .all(roomId, n) as any[];
  return rows.map((row) => mapMessageRow(db, row)).reverse();
}

export function getActiveExploring(db: Database.Database, roomId: number): Message[] {
  const rows = db
    .prepare(
      `SELECT * FROM messages WHERE room_id = ? AND type = 'exploring' AND exploring_status = 'active' ORDER BY id ASC`,
    )
    .all(roomId) as any[];
  return rows.map((row) => mapMessageRow(db, row));
}

export function getActiveExploringByAuthor(db: Database.Database, roomId: number, authorId: string): Message | null {
  const row = db
    .prepare(
      `SELECT * FROM messages WHERE room_id = ? AND author_id = ? AND type = 'exploring' AND exploring_status = 'active'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(roomId, authorId);
  return row ? mapMessageRow(db, row) : null;
}

export type CompleteExploringEnd =
  | { reason: 'explicit'; resultSummary: string; resultMessageIds?: number[] }
  | { reason: 'human_terminated'; note: string };

// 只允许 active → completed 一次，结束原因与结果原子写入；已 completed 时抛错。
export function completeExploring(
  db: Database.Database,
  roomId: number,
  messageId: number,
  end: CompleteExploringEnd,
): void {
  const explicit = end.reason === 'explicit';
  const updated = db.prepare(
    `UPDATE messages SET exploring_status = 'completed', exploring_note = ?, exploring_end_reason = ?,
      exploring_result_summary = ?, exploring_result_message_ids = ?
     WHERE room_id = ? AND id = ? AND type = 'exploring' AND exploring_status = 'active'`,
  ).run(
    explicit ? null : end.note,
    end.reason,
    explicit ? end.resultSummary : null,
    JSON.stringify(explicit ? [...new Set(end.resultMessageIds ?? [])] : []),
    roomId,
    messageId,
  );
  if (!updated.changes) throw new Error('exploring is not active');
}

// ---- 状态转换（每个函数在同一事务内追加一条 state_transition_log，见 01-storage.md §2）----

function appendTransition(
  db: Database.Database,
  roomId: number,
  messageId: number,
  change: { fromType?: string | null; toType?: string | null; fromStatus?: string | null; toStatus?: string | null },
  triggerMessageId: number,
  reason?: string,
): void {
  const next = db
    .prepare(`SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM state_transition_log WHERE room_id = ?`)
    .get(roomId) as { nextId: number };
  db.prepare(
    `INSERT INTO state_transition_log
       (room_id, id, message_id, from_type, to_type, from_status, to_status, trigger_message_id, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    roomId, next.nextId, messageId, change.fromType ?? null, change.toType ?? null,
    change.fromStatus ?? null, change.toStatus ?? null, triggerMessageId, reason ?? null, new Date().toISOString(),
  );
}

function requireMessage(db: Database.Database, roomId: number, messageId: number): any {
  const row = db.prepare(`SELECT * FROM messages WHERE room_id = ? AND id = ?`).get(roomId, messageId);
  if (!row) throw new Error(`message ${messageId} not found in room ${roomId}`);
  return row;
}

export function setMessageType(
  db: Database.Database,
  roomId: number,
  messageId: number,
  toType: 'hypothesis' | 'fact' | 'boundary',
  triggerMessageId: number,
  reason?: string,
): void {
  db.transaction(() => {
    const row = requireMessage(db, roomId, messageId);
    if (!['hypothesis', 'fact', 'boundary'].includes(row.type)) {
      throw new Error(`message ${messageId} of type ${row.type} cannot change type`);
    }
    db.prepare(`UPDATE messages SET type = ? WHERE room_id = ? AND id = ?`).run(toType, roomId, messageId);
    appendTransition(db, roomId, messageId, { fromType: row.type, toType }, triggerMessageId, reason);
  })();
}

// open_question 的状态串：OPEN / CLOSED/RESOLVED / CLOSED/UNRESOLVED（关闭原因并入状态串，见 01-storage.md §1）。
function questionStatusString(status: string, closeReason: string | null): string {
  return status === 'CLOSED' ? `CLOSED/${closeReason}` : status;
}

export function setQuestionStatus(
  db: Database.Database,
  roomId: number,
  messageId: number,
  next: { status: 'OPEN' } | { status: 'CLOSED'; closeReason: CloseReason; closedBy: number },
  triggerMessageId: number,
  reason?: string,
): void {
  db.transaction(() => {
    const row = requireMessage(db, roomId, messageId);
    if (row.type !== 'open_question') throw new Error(`message ${messageId} is not an open_question`);
    const closeReason = next.status === 'CLOSED' ? next.closeReason : null;
    const closedBy = next.status === 'CLOSED' ? next.closedBy : null;
    db.prepare(
      `UPDATE messages SET question_status = ?, question_close_reason = ?, question_closed_by = ? WHERE room_id = ? AND id = ?`,
    ).run(next.status, closeReason, closedBy, roomId, messageId);
    appendTransition(db, roomId, messageId, {
      fromStatus: questionStatusString(row.question_status, row.question_close_reason),
      toStatus: questionStatusString(next.status, closeReason),
    }, triggerMessageId, reason);
  })();
}

export function setChainStatus(
  db: Database.Database,
  roomId: number,
  messageId: number,
  toStatus: ChainStatus,
  triggerMessageId: number,
  reason?: string,
): void {
  db.transaction(() => {
    const row = requireMessage(db, roomId, messageId);
    if (row.type !== 'chain') throw new Error(`message ${messageId} is not a chain`);
    db.prepare(`UPDATE messages SET chain_status = ? WHERE room_id = ? AND id = ?`).run(toStatus, roomId, messageId);
    appendTransition(db, roomId, messageId, { fromStatus: row.chain_status, toStatus }, triggerMessageId, reason);
  })();
}

function mapTransitionRow(row: any): StateTransition {
  return {
    id: row.id,
    roomId: row.room_id,
    messageId: row.message_id,
    fromType: row.from_type ?? null,
    toType: row.to_type ?? null,
    fromStatus: row.from_status ?? null,
    toStatus: row.to_status ?? null,
    triggerMessageId: row.trigger_message_id,
    reason: row.reason ?? null,
    createdAt: row.created_at,
  };
}

export function getStateTransitions(db: Database.Database, roomId: number, messageId: number): StateTransition[] {
  const rows = db
    .prepare(`SELECT * FROM state_transition_log WHERE room_id = ? AND message_id = ? ORDER BY id ASC`)
    .all(roomId, messageId) as any[];
  return rows.map(mapTransitionRow);
}

export function getRoomStateTransitions(db: Database.Database, roomId: number): StateTransition[] {
  const rows = db
    .prepare(`SELECT * FROM state_transition_log WHERE room_id = ? ORDER BY id ASC`)
    .all(roomId) as any[];
  return rows.map(mapTransitionRow);
}
