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
    referencedMessageIds: refs.map((r) => r.referenced_message_id),
    exploringStatus: row.exploring_status,
    exploringNote: row.exploring_note,
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
        db.prepare(`UPDATE messages SET exploring_status = 'completed' WHERE room_id = ? AND id = ?`)
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
      `INSERT INTO messages (room_id, id, session_seq, author_id, type, content, summary, target_message_id, exploring_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      params.roomId, id, params.sessionSeq, params.authorId, params.type ?? null,
      params.content, summary, params.targetMessageId ?? null, exploringStatus, createdAt,
    );

    if (params.referencedMessageIds?.length) {
      const insertRef = db.prepare(
        `INSERT INTO message_references (room_id, message_id, referenced_message_id) VALUES (?, ?, ?)`,
      );
      for (const refId of params.referencedMessageIds) insertRef.run(params.roomId, id, refId);
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
    .prepare(`SELECT * FROM messages WHERE room_id = ? AND target_message_id = ? ORDER BY id ASC`)
    .all(roomId, messageId) as any[];
  return rows.map((row) => mapMessageRow(db, row));
}

export function completeExploring(db: Database.Database, roomId: number, messageId: number, note?: string): void {
  db.prepare(
    `UPDATE messages SET exploring_status = 'completed', exploring_note = COALESCE(?, exploring_note)
     WHERE room_id = ? AND id = ? AND type = 'exploring'`,
  ).run(note ?? null, roomId, messageId);
}
