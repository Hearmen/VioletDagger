import { describe, it, expect } from 'vitest';
import { createTestDb, createDb } from '../../src/storage/db';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRoom, getRoom, recordCompletion } from '../../src/storage/rooms';
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
  it('backfills auto_confirm_on_silence/completion_reason on legacy rooms without a manual migration', () => {
    const dir = mkdtempSync(join(tmpdir(), 'violet-completion-migration-'));
    const file = join(dir, 'test.db');
    try {
      const first = createDb(file);
      const active = createRoom(first, 'still active', ['codex'], 'sequential');
      const completed = createRoom(first, 'already done', ['codex'], 'sequential');
      recordCompletion(first, completed.id, 'manual');
      first.exec('ALTER TABLE rooms DROP COLUMN auto_confirm_on_silence');
      first.exec('ALTER TABLE rooms DROP COLUMN completion_reason');
      first.exec('ALTER TABLE rooms DROP COLUMN completion_reference_message_id');
      first.close();

      const migrated = createDb(file);
      // 老库一律按"从未开启过"补齐（见 01-storage.md §5.6）。
      expect(getRoom(migrated, active.id)).toMatchObject({ autoConfirmOnSilence: false, completionReason: null });
      // 老库里已经 completed 的房间在这个功能存在之前只可能是人工确认的，回填为 'manual'，不留空白。
      expect(getRoom(migrated, completed.id)).toMatchObject({
        status: 'completed', autoConfirmOnSilence: false, completionReason: 'manual', completionReferenceMessageId: null,
      });
      migrated.close();
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
