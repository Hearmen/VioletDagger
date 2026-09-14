import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../src/storage/db';
import { createRoom } from '../../src/storage/rooms';
import { createSession } from '../../src/storage/sessions';
import { insertMessage } from '../../src/storage/messages';
import { buildDetail } from '../../src/memory/detail';

describe('buildDetail', () => {
  it('returns a single message with its annotations when queried by messageId', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex', 'claude'], 'sequential');
    const s1 = createSession(db, room.id, 'codex');
    const fact = insertMessage(db, { roomId: room.id, sessionSeq: s1.seq, authorId: 'codex', content: 'a fact', type: 'fact' });
    const s2 = createSession(db, room.id, 'claude');
    insertMessage(db, {
      roomId: room.id, sessionSeq: s2.seq, authorId: 'claude', content: 'confirmed',
      type: 'verify', targetMessageId: fact.message.id,
    });
    const detail = buildDetail(db, room.id, { messageId: fact.message.id }) as any;
    expect(detail.id).toBe(fact.message.id);
    expect(detail.annotations).toHaveLength(1);
    expect(detail.annotations[0].type).toBe('verify');
  });

  it('throws when the messageId does not belong to the given room', () => {
    const db = createTestDb();
    const roomA = createRoom(db, 'a', ['codex'], 'sequential');
    const roomB = createRoom(db, 'b', ['codex'], 'sequential');
    const s1 = createSession(db, roomA.id, 'codex');
    const fact = insertMessage(db, { roomId: roomA.id, sessionSeq: s1.seq, authorId: 'codex', content: 'a fact', type: 'fact' });
    expect(() => buildDetail(db, roomB.id, { messageId: fact.message.id })).toThrow();
  });

  it('returns all exploring records regardless of active/completed status when queried by type', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const s1 = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: s1.seq, authorId: 'codex', content: 'exploring A', type: 'exploring' });
    const s2 = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: s2.seq, authorId: 'codex', content: 'exploring B', type: 'exploring' });
    const details = buildDetail(db, room.id, { type: 'exploring' }) as any[];
    expect(details.map((d) => d.content)).toEqual(['exploring A', 'exploring B']);
    expect(details[0].exploringStatus).toBe('completed');
    expect(details[1].exploringStatus).toBe('active');
  });

  it('attaches annotations to every message when queried by type', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex', 'claude'], 'sequential');
    const s1 = createSession(db, room.id, 'codex');
    const fact = insertMessage(db, { roomId: room.id, sessionSeq: s1.seq, authorId: 'codex', content: 'a fact', type: 'fact' });
    const s2 = createSession(db, room.id, 'claude');
    insertMessage(db, {
      roomId: room.id, sessionSeq: s2.seq, authorId: 'claude', content: 'endorsed',
      type: 'endorse', targetMessageId: fact.message.id,
    });
    const details = buildDetail(db, room.id, { type: 'fact' }) as any[];
    expect(details[0].annotations).toHaveLength(1);
  });
});
