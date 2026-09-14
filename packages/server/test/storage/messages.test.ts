import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../src/storage/db';
import { createRoom } from '../../src/storage/rooms';
import { createSession } from '../../src/storage/sessions';
import { insertMessage } from '../../src/storage/messages';

describe('insertMessage', () => {
  it('inserts a plain chat message with an auto-truncated summary', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    const { message, supersededExploringId } = insertMessage(db, {
      roomId: room.id,
      sessionSeq: session.seq,
      authorId: 'codex',
      content: 'hello room',
    });
    expect(message.type).toBeNull();
    expect(message.summary).toBe('hello room');
    expect(supersededExploringId).toBeNull();
  });

  it('auto-supersedes the author\'s previous active exploring message', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const s1 = createSession(db, room.id, 'codex');
    const first = insertMessage(db, {
      roomId: room.id, sessionSeq: s1.seq, authorId: 'codex',
      content: 'looking at storage layer', type: 'exploring',
    });
    expect(first.message.exploringStatus).toBe('active');

    const s2 = createSession(db, room.id, 'codex');
    const second = insertMessage(db, {
      roomId: room.id, sessionSeq: s2.seq, authorId: 'codex',
      content: 'now looking at mcp server', type: 'exploring',
    });
    expect(second.supersededExploringId).toBe(first.message.id);
  });

  it('does not supersede exploring messages from a different author', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex', 'claude'], 'sequential');
    const s1 = createSession(db, room.id, 'codex');
    insertMessage(db, {
      roomId: room.id, sessionSeq: s1.seq, authorId: 'codex',
      content: 'exploring A', type: 'exploring',
    });
    const s2 = createSession(db, room.id, 'claude');
    const result = insertMessage(db, {
      roomId: room.id, sessionSeq: s2.seq, authorId: 'claude',
      content: 'exploring B', type: 'exploring',
    });
    expect(result.supersededExploringId).toBeNull();
  });

  it('persists referencedMessageIds for chain messages', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const s1 = createSession(db, room.id, 'codex');
    const fact = insertMessage(db, {
      roomId: room.id, sessionSeq: s1.seq, authorId: 'codex',
      content: 'db uses sqlite', type: 'fact',
    });
    const chain = insertMessage(db, {
      roomId: room.id, sessionSeq: s1.seq, authorId: 'codex',
      content: 'end to end plan', type: 'chain',
      referencedMessageIds: [fact.message.id],
    });
    expect(chain.message.referencedMessageIds).toEqual([fact.message.id]);
  });

  it('respects an explicitly provided summary', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const s1 = createSession(db, room.id, 'codex');
    const { message } = insertMessage(db, {
      roomId: room.id, sessionSeq: s1.seq, authorId: 'codex',
      content: 'a very long message '.repeat(10), summary: 'short summary',
    });
    expect(message.summary).toBe('short summary');
  });
});
