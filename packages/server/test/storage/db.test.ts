import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../src/storage/db';

describe('createTestDb', () => {
  it('creates all five tables', () => {
    const db = createTestDb();
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all()
      .map((r: any) => r.name);
    expect(tables).toEqual([
      'message_references', 'messages', 'room_agents', 'rooms', 'sessions',
    ]);
  });
});
