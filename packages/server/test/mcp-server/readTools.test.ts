import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../src/storage/db';
import { createRoom } from '../../src/storage/rooms';
import { createSession } from '../../src/storage/sessions';
import { insertMessage } from '../../src/storage/messages';
import { createGetOverviewHandler, createGetDetailHandler } from '../../src/mcp-server/readTools';
import { McpToolError } from '../../src/mcp-server/validation';

describe('createGetOverviewHandler', () => {
  it('returns the room overview without requiring session binding', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const s1 = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: s1.seq, authorId: 'human', content: 'the goal' });

    const getOverview = createGetOverviewHandler(db);
    expect(getOverview({ roomId: room.id }).goal).toBe('the goal');
  });

  it('rejects a missing room', () => {
    const db = createTestDb();
    const getOverview = createGetOverviewHandler(db);
    expect(() => getOverview({ roomId: 999 })).toThrow(McpToolError);
  });
});

describe('createGetDetailHandler', () => {
  it('returns a single message detail when messageId is given', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const s1 = createSession(db, room.id, 'codex');
    const { message } = insertMessage(db, {
      roomId: room.id, sessionSeq: s1.seq, authorId: 'codex', content: 'a fact', type: 'fact',
    });

    const getDetail = createGetDetailHandler(db);
    const detail = getDetail({ roomId: room.id, messageId: message.id }) as any;
    expect(detail.id).toBe(message.id);
  });

  it('returns all records for a type, including completed exploring', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const s1 = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: s1.seq, authorId: 'codex', content: 'exploring A', type: 'exploring' });
    const s2 = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: s2.seq, authorId: 'codex', content: 'exploring B', type: 'exploring' });

    const getDetail = createGetDetailHandler(db);
    const details = getDetail({ roomId: room.id, type: 'exploring' }) as any[];
    expect(details).toHaveLength(2);
  });

  it('rejects when both messageId and type are given', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const getDetail = createGetDetailHandler(db);
    expect(() => getDetail({ roomId: room.id, messageId: 1, type: 'fact' })).toThrow(McpToolError);
  });

  it('rejects when neither messageId nor type is given', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const getDetail = createGetDetailHandler(db);
    expect(() => getDetail({ roomId: room.id })).toThrow(McpToolError);
  });
});
