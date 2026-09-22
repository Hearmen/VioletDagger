import type Database from 'better-sqlite3';
import type { InsertMessageParams, Message, MessageType } from './types';

const SUMMARY_MAX_LEN = 80;

export function mapMessageRow(db: Database.Database, row: any): Message {
  const refs = db
    .prepare(`SELECT referenced_message_id FROM message_references WHERE room_id = ? AND message_id = ?`)
    .all(row.room_id, row.id) as { referenced_message_id: number }[];
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
    referencedMessageIds: refs.map((r) => r.referenced_message_id),
    exploringStatus: row.exploring_status,
    exploringNote: row.exploring_note,
    exploringEndReason: row.exploring_end_reason ?? null,
    exploringResultSummary: row.exploring_result_summary ?? null,
    exploringResultMessageIds: JSON.parse(row.exploring_result_message_ids ?? '[]'),
    createdAt: row.created_at,
  };
}

// 消息 id 是 room 内自增（见 docs/design/01-storage.md §5.5），所以必须带 roomId。
export function getMessageById(db: Database.Database, roomId: number, id: number): Message | null {
  const row = db.prepare(`SELECT * FROM messages WHERE room_id = ? AND id = ?`).get(roomId, id);
  return row ? mapMessageRow(db, row) : null;
}

export function insertMessage(
  db: Database.Database,
  params: InsertMessageParams,
): { message: Message; supersededExploringId: number | null } {
  const createdAt = new Date().toISOString();
  const summary = params.summary ?? params.content.slice(0, SUMMARY_MAX_LEN);
  const exploringStatus = params.type === 'exploring' ? 'active' : null;

  const result = db.transaction(() => {
    let supersededExploringId: number | null = null;

    if (params.type === 'exploring') {
      const prev = db
        .prepare(
          `SELECT id FROM messages WHERE room_id = ? AND author_id = ? AND type = 'exploring' AND exploring_status = 'active'`,
        )
        .get(params.roomId, params.authorId) as { id: number } | undefined;
      if (prev) {
        db.prepare(`UPDATE messages SET exploring_status = 'completed', exploring_end_reason = 'superseded' WHERE room_id = ? AND id = ?`)
          .run(params.roomId, prev.id);
        supersededExploringId = prev.id;
      }
    }

    // room 内自增 id，在同一事务内生成，配合主键 (room_id, id) 保证并发也不会重复。
    const next = db
      .prepare(`SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM messages WHERE room_id = ?`)
      .get(params.roomId) as { nextId: number };
    const id = next.nextId;

    db.prepare(
      `INSERT INTO messages (room_id, id, session_seq, author_id, type, content, summary, target_message_id, target_agent_id, exploring_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      params.roomId, id, params.sessionSeq, params.authorId, params.type ?? null,
      params.content, summary, params.targetMessageId ?? null, params.targetAgentId ?? null, exploringStatus, createdAt,
    );

    if (params.referencedMessageIds?.length) {
      const insertRef = db.prepare(
        `INSERT INTO message_references (room_id, message_id, referenced_message_id) VALUES (?, ?, ?)`,
      );
      for (const refId of new Set(params.referencedMessageIds)) insertRef.run(params.roomId, id, refId);
    }

    return { id, supersededExploringId };
  })();

  return { message: getMessageById(db, params.roomId, result.id)!, supersededExploringId: result.supersededExploringId };
}

export function getFirstMessage(db: Database.Database, roomId: number): Message | null {
  const row = db.prepare(`SELECT * FROM messages WHERE room_id = ? ORDER BY id ASC LIMIT 1`).get(roomId);
  return row ? mapMessageRow(db, row) : null;
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

export function getMessagesByType(db: Database.Database, roomId: number, type: MessageType): Message[] {
  const rows = db
    .prepare(`SELECT * FROM messages WHERE room_id = ? AND type = ? ORDER BY id ASC`)
    .all(roomId, type) as any[];
  return rows.map((row) => mapMessageRow(db, row));
}

export function getActiveExploring(db: Database.Database, roomId: number): Message[] {
  const rows = db
    .prepare(
      `SELECT * FROM messages WHERE room_id = ? AND type = 'exploring' AND exploring_status = 'active' ORDER BY id ASC`,
    )
    .all(roomId) as any[];
  return rows.map((row) => mapMessageRow(db, row));
}

export function getRecentRawMessages(db: Database.Database, roomId: number, n: number): Message[] {
  const rows = db
    .prepare(`SELECT * FROM messages WHERE room_id = ? ORDER BY id DESC LIMIT ?`)
    .all(roomId, n) as any[];
  return rows.map((row) => mapMessageRow(db, row)).reverse();
}

export function getAnnotations(db: Database.Database, roomId: number, messageId: number): Message[] {
  const rows = db
    .prepare(`SELECT * FROM messages WHERE room_id = ? AND target_message_id = ? AND type IN ('endorse', 'challenge', 'verify', 'open_question') ORDER BY id ASC`)
    .all(roomId, messageId) as any[];
  return rows.map((row) => mapMessageRow(db, row));
}

export function completeExploring(db: Database.Database, roomId: number, messageId: number, note?: string,
  result?: { resultSummary: string; resultMessageIds?: number[] }): void {
  const updated = db.prepare(
    `UPDATE messages SET exploring_status = 'completed', exploring_note = ?, exploring_end_reason = ?,
      exploring_result_summary = ?, exploring_result_message_ids = ?
     WHERE room_id = ? AND id = ? AND type = 'exploring' AND exploring_status = 'active'`,
  ).run(note ?? null, note ? 'human_terminated' : 'explicit', result?.resultSummary ?? null,
    JSON.stringify([...new Set(result?.resultMessageIds ?? [])]), roomId, messageId);
  if (!updated.changes) throw new Error('exploring is not active');
}

// Bulk load references once for the shared memory projection.
export function getRoomMessages(db: Database.Database, roomId: number): Message[] {
  const rows = db.prepare('SELECT * FROM messages WHERE room_id = ? ORDER BY id').all(roomId) as any[];
  const references = db.prepare('SELECT message_id, referenced_message_id FROM message_references WHERE room_id = ? ORDER BY referenced_message_id').all(roomId) as { message_id: number; referenced_message_id: number }[];
  const refs = new Map<number, number[]>();
  for (const ref of references) {
    if (!refs.has(ref.message_id)) refs.set(ref.message_id, []);
    refs.get(ref.message_id)!.push(ref.referenced_message_id);
  }
  return rows.map((row) => ({
    id: row.id, roomId: row.room_id, sessionSeq: row.session_seq, authorId: row.author_id,
    type: row.type, content: row.content, summary: row.summary, targetMessageId: row.target_message_id,
    targetAgentId: row.target_agent_id ?? null,
    referencedMessageIds: refs.get(row.id) ?? [], exploringStatus: row.exploring_status,
    exploringNote: row.exploring_note, exploringEndReason: row.exploring_end_reason ?? null,
    exploringResultSummary: row.exploring_result_summary ?? null,
    exploringResultMessageIds: JSON.parse(row.exploring_result_message_ids ?? '[]'), createdAt: row.created_at,
  }));
}

const MESSAGE_TYPES: MessageType[] = [
  'fact', 'hypothesis', 'boundary', 'open_question', 'chain',
  'exploring', 'propose_completion', 'endorse', 'challenge', 'verify',
];

// 一条消息是否"参与跨-agent 自动化判定"（待派发/静默收敛，见需求 3.3.2、01-storage.md §2 新增不变量）：
// 排除定向给别人的消息（target_agent_id 非空）和 dispatch_scope='directed' session 的产出——
// 两者都只对触发那次定向 session 的那个 agent 有意义，不该唤醒/影响其他 agent 或房间级别的判定。
const NOT_DISPATCH_RELEVANT_SQL = `
  messages.target_agent_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM sessions
    WHERE sessions.room_id = messages.room_id AND sessions.seq = messages.session_seq
      AND sessions.dispatch_scope = 'directed'
  )
`;

// 触发派发的消息里，除调用 agent 自己以外的最新一条的时间（人类消息一律算，见 03 §1.2）。
// 排除定向给别人的消息、以及定向 session 产出的消息（见需求 3.3.2）。
export function getLatestDispatchTriggerAt(
  db: Database.Database,
  roomId: number,
  excludeAuthorId: string,
  triggerTypes: MessageType[],
): string | null {
  const placeholders = triggerTypes.map(() => '?').join(', ');
  const row = db.prepare(
    `SELECT MAX(created_at) AS latest FROM messages
     WHERE room_id = ? AND author_id != ? AND (author_id = 'human' OR type IN (${placeholders}))
       AND ${NOT_DISPATCH_RELEVANT_SQL}`,
  ).get(roomId, excludeAuthorId, ...triggerTypes) as { latest: string | null } | undefined;
  return row?.latest ?? null;
}

// 该 agent 作为 target_agent_id 的最新一条消息（只可能是人类发的，见需求 3.3.2）；不存在返回 null。
// 供核心判定"待派发"的定向条件（03 §1.2），不比较时间戳——由调用方结合 getLatestSessionStartedAt 判定。
export function getLatestDirectedMessage(db: Database.Database, roomId: number, targetAgentId: string): Message | null {
  const row = db.prepare(
    `SELECT * FROM messages WHERE room_id = ? AND target_agent_id = ? ORDER BY id DESC LIMIT 1`,
  ).get(roomId, targetAgentId);
  return row ? mapMessageRow(db, row) : null;
}

// 房间内 type ∈ types 里 id 最大的一条消息，不排除任何 author、不比较时间戳（但排除定向 session 的产出，
// 见需求 3.3.2）；供静默收敛自动确认判定"最新一条信号类消息是不是 propose_completion"用
// （03-orchestrator-core.md §1.4），跟 getLatestDispatchTriggerAt（逐 agent 判定"待派发"）用途不同、不复用。
export function getLatestMessageByTypes(db: Database.Database, roomId: number, types: MessageType[]): Message | null {
  const placeholders = types.map(() => '?').join(', ');
  const row = db.prepare(
    `SELECT * FROM messages WHERE room_id = ? AND type IN (${placeholders}) AND ${NOT_DISPATCH_RELEVANT_SQL} ORDER BY id DESC LIMIT 1`,
  ).get(roomId, ...types);
  return row ? mapMessageRow(db, row) : null;
}

export function validateMessageRelations(db: Database.Database, roomId: number, params: Pick<InsertMessageParams, 'type' | 'targetMessageId' | 'referencedMessageIds'>): void {
  if (params.type != null && !MESSAGE_TYPES.includes(params.type)) {
    throw new Error(`unknown message type "${params.type}"`);
  }
  for (const id of [params.targetMessageId, ...(params.referencedMessageIds ?? [])]) {
    if (id != null && (!Number.isInteger(id) || id <= 0)) throw new Error('message IDs must be positive integers');
  }
  if (['hypothesis', 'endorse', 'challenge', 'verify'].includes(params.type ?? '') && params.targetMessageId == null) {
    throw new Error(`targetMessageId is required for type "${params.type}"`);
  }
  if (params.targetMessageId != null) {
    const target = getMessageById(db, roomId, params.targetMessageId);
    if (!target) throw new Error(`targetMessageId ${params.targetMessageId} not found in room ${roomId}`);
    if (['hypothesis', 'fact'].includes(params.type ?? '') && target.type !== 'open_question') {
      throw new Error('answer targetMessageId must refer to an open_question');
    }
  }
  if (params.referencedMessageIds !== undefined && params.type == null) throw new Error('referencedMessageIds requires a typed message');
  for (const id of params.referencedMessageIds ?? []) {
    if (!getMessageById(db, roomId, id)) throw new Error(`referencedMessageIds contains ${id} which is not found in room ${roomId}`);
  }
}
