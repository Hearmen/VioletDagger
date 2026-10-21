import { describe, it, expect } from 'vitest';
import { createTestDb, createDb } from '../../src/storage/db';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRoom, getRoom, listRooms } from '../../src/storage/rooms';
import { insertMessage, getMessageById } from '../../src/storage/messages';

describe('createTestDb', () => {
  it('keeps data across reopen when the schema is current', () => {
    const dir = mkdtempSync(join(tmpdir(), 'violet-schema-current-'));
    const file = join(dir, 'test.db');
    try {
      const first = createDb(file);
      const room = createRoom(first, 'current', ['codex'], 'parallel');
      const message = insertMessage(first, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'goal', type: 'open_question' });
      first.close();
      const reopened = createDb(file);
      expect(getRoom(reopened, room.id)!.name).toBe('current');
      expect(getMessageById(reopened, room.id, message.id)).toEqual(message);
      reopened.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each([
    ['a knowledge-state column is missing', (db: ReturnType<typeof createDb>) => db.exec('ALTER TABLE messages DROP COLUMN chain_resolution')],
    ['the state_transition_log table is missing', (db: ReturnType<typeof createDb>) => db.exec('DROP TABLE state_transition_log')],
    ['the room flag columns are missing', (db: ReturnType<typeof createDb>) => db.exec('ALTER TABLE rooms DROP COLUMN pending_author_id')],
    ['the directed flag column is missing', (db: ReturnType<typeof createDb>) => db.exec('ALTER TABLE room_agents DROP COLUMN directed_pending')],
  ])('rebuilds the whole database when %s', (_label, corrupt) => {
    const dir = mkdtempSync(join(tmpdir(), 'violet-schema-rebuild-'));
    const file = join(dir, 'test.db');
    try {
      const first = createDb(file);
      createRoom(first, 'old', ['codex'], 'parallel');
      corrupt(first);
      first.close();
      const rebuilt = createDb(file);
      expect(listRooms(rebuilt)).toEqual([]);
      const columns = (rebuilt.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).map((c) => c.name);
      expect(columns).toEqual(expect.arrayContaining(['question_status', 'chain_status', 'chain_resolution', 'question_closed_by']));
      rebuilt.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('creates all tables including session_events and state_transition_log', () => {
    const db = createTestDb();
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all()
      .map((r: any) => r.name);
    expect(tables).toEqual([
      'message_references', 'messages', 'room_agents', 'rooms', 'session_events', 'sessions', 'state_transition_log',
    ]);
  });
});

describe('additive columns (01-storage.md §5.7)', () => {
  it('adds missing nullable columns in place without dropping data', () => {
    const dir = mkdtempSync(join(tmpdir(), 'violet-schema-additive-'));
    const file = join(dir, 'test.db');
    try {
      const first = createDb(file);
      const room = createRoom(first, 'keep', ['codex'], 'parallel');
      first.exec('ALTER TABLE rooms DROP COLUMN completed_at');
      for (const column of ['dispatch_trigger', 'native_session_id', 'native_storage', 'native_original_path', 'native_copy_path']) {
        first.exec(`ALTER TABLE sessions DROP COLUMN ${column}`);
      }
      first.close();
      const reopened = createDb(file);
      expect(getRoom(reopened, room.id)).toMatchObject({ name: 'keep', completedAt: null });
      const columns = (reopened.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map((c) => c.name);
      expect(columns).toEqual(expect.arrayContaining(['dispatch_trigger', 'native_session_id', 'native_copy_path']));
      reopened.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('scheduling_mode rewrite (01-storage.md §5.8)', () => {
  it('rewrites sequential rows to parallel exactly once, guarded by user_version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'violet-schema-mode-'));
    const file = join(dir, 'test.db');
    try {
      const first = createDb(file);
      const old = createRoom(first, 'old', ['codex'], 'sequential');
      // 模拟改写之前的数据库。
      first.pragma('user_version = 0');
      first.close();

      const migrated = createDb(file);
      expect(getRoom(migrated, old.id)!.schedulingMode).toBe('parallel');
      expect(migrated.pragma('user_version', { simple: true })).toBe(1);
      const fresh = createRoom(migrated, 'new', ['codex'], 'sequential');
      migrated.close();

      const reopened = createDb(file);
      expect(getRoom(reopened, fresh.id)!.schedulingMode).toBe('sequential');
      expect(getRoom(reopened, old.id)!.schedulingMode).toBe('parallel');
      reopened.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('marks a brand-new database as already rewritten', () => {
    const dir = mkdtempSync(join(tmpdir(), 'violet-schema-mode-new-'));
    const file = join(dir, 'test.db');
    try {
      const db = createDb(file);
      expect(db.pragma('user_version', { simple: true })).toBe(1);
      const room = createRoom(db, 'r', ['codex'], 'sequential');
      db.close();
      const reopened = createDb(file);
      expect(getRoom(reopened, room.id)!.schedulingMode).toBe('sequential');
      reopened.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('creates rooms.scheduling_mode with a parallel default', () => {
    const db = createTestDb();
    const column = (db.prepare('PRAGMA table_info(rooms)').all() as { name: string; dflt_value: string }[])
      .find((c) => c.name === 'scheduling_mode')!;
    expect(column.dflt_value).toBe("'parallel'");
  });
});
