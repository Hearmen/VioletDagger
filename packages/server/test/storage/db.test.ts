import { describe, it, expect } from 'vitest';
import { createTestDb, createDb } from '../../src/storage/db';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRoom } from '../../src/storage/rooms';
import { insertMessage, getMessageById } from '../../src/storage/messages';

describe('createTestDb', () => {
  it('adds exploration fields to existing databases without changing historical messages', () => {
    const dir = mkdtempSync(join(tmpdir(), 'violet-memory-migration-'));
    const file = join(dir, 'test.db');
    try {
      const first = createDb(file);
      const room = createRoom(first, 'old', ['codex'], 'sequential');
      const { message } = insertMessage(first, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'legacy hypothesis', type: 'hypothesis' });
      first.exec('ALTER TABLE messages DROP COLUMN exploring_end_reason');
      first.exec('ALTER TABLE messages DROP COLUMN exploring_result_summary');
      first.exec('ALTER TABLE messages DROP COLUMN exploring_result_message_ids');
      first.close();
      const migrated = createDb(file);
      const stored = getMessageById(migrated, room.id, message.id)!;
      expect(stored.content).toBe('legacy hypothesis');
      expect(stored.targetMessageId).toBeNull();
      expect(stored.exploringEndReason).toBeNull();
      expect(stored.exploringResultMessageIds).toEqual([]);
      migrated.close();
      const reopened = createDb(file);
      expect(getMessageById(reopened, room.id, message.id)).toEqual(stored);
      reopened.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('creates all tables including session_events', () => {
    const db = createTestDb();
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all()
      .map((r: any) => r.name);
    expect(tables).toEqual([
      'message_references', 'messages', 'room_agents', 'rooms', 'session_events', 'sessions',
    ]);
  });
});
