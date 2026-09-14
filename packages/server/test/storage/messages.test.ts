import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../src/storage/db';
import { createRoom } from '../../src/storage/rooms';
import { createSession } from '../../src/storage/sessions';
import {
  insertMessage,
  getFirstMessage, getMessagesBySession, listMessages, getMessagesByType,
  getActiveExploring, getRecentRawMessages, getAnnotations, getMessageById, completeExploring,
} from '../../src/storage/messages';

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

describe('message read queries', () => {
  it('getFirstMessage returns the room\'s earliest message', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const s1 = createSession(db, room.id, 'codex');
    const first = insertMessage(db, { roomId: room.id, sessionSeq: s1.seq, authorId: 'codex', content: 'goal: build X' });
    insertMessage(db, { roomId: room.id, sessionSeq: s1.seq, authorId: 'codex', content: 'second message' });
    expect(getFirstMessage(db, room.id)!.id).toBe(first.message.id);
  });

  it('getMessagesBySession returns only that session\'s messages in order', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const s1 = createSession(db, room.id, 'codex');
    const s2 = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: s1.seq, authorId: 'codex', content: 'in session 1' });
    insertMessage(db, { roomId: room.id, sessionSeq: s2.seq, authorId: 'codex', content: 'in session 2' });
    const msgs = getMessagesBySession(db, room.id, s1.seq);
    expect(msgs.map((m) => m.content)).toEqual(['in session 1']);
  });

  it('listMessages paginates newest-first with a cursor for older history', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const s1 = createSession(db, room.id, 'codex');
    for (let i = 1; i <= 5; i++) {
      insertMessage(db, { roomId: room.id, sessionSeq: s1.seq, authorId: 'codex', content: `m${i}` });
    }
    const page1 = listMessages(db, room.id, undefined, 2);
    expect(page1.messages.map((m) => m.content)).toEqual(['m4', 'm5']);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = listMessages(db, room.id, page1.nextCursor!, 2);
    expect(page2.messages.map((m) => m.content)).toEqual(['m2', 'm3']);
  });

  it('getMessagesByType filters by type within the room', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const s1 = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: s1.seq, authorId: 'codex', content: 'a fact', type: 'fact' });
    insertMessage(db, { roomId: room.id, sessionSeq: s1.seq, authorId: 'codex', content: 'chit chat' });
    expect(getMessagesByType(db, room.id, 'fact').map((m) => m.content)).toEqual(['a fact']);
  });

  it('getActiveExploring returns only active exploring messages', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const s1 = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: s1.seq, authorId: 'codex', content: 'exploring X', type: 'exploring' });
    const s2 = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: s2.seq, authorId: 'codex', content: 'exploring Y', type: 'exploring' });
    const active = getActiveExploring(db, room.id);
    expect(active.map((m) => m.content)).toEqual(['exploring Y']);
  });

  it('getRecentRawMessages returns the last n messages regardless of type, oldest first', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const s1 = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: s1.seq, authorId: 'codex', content: 'm1' });
    insertMessage(db, { roomId: room.id, sessionSeq: s1.seq, authorId: 'codex', content: 'm2', type: 'fact' });
    insertMessage(db, { roomId: room.id, sessionSeq: s1.seq, authorId: 'codex', content: 'm3' });
    expect(getRecentRawMessages(db, room.id, 2).map((m) => m.content)).toEqual(['m2', 'm3']);
  });

  it('getAnnotations returns reactions targeting a message', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex', 'claude'], 'sequential');
    const s1 = createSession(db, room.id, 'codex');
    const fact = insertMessage(db, { roomId: room.id, sessionSeq: s1.seq, authorId: 'codex', content: 'a fact', type: 'fact' });
    const s2 = createSession(db, room.id, 'claude');
    insertMessage(db, {
      roomId: room.id, sessionSeq: s2.seq, authorId: 'claude', content: 'confirmed',
      type: 'verify', targetMessageId: fact.message.id,
    });
    expect(getAnnotations(db, fact.message.id).map((m) => m.type)).toEqual(['verify']);
  });

  it('listMessages has null nextCursor at true end of history (boundary case)', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const s1 = createSession(db, room.id, 'codex');
    for (let i = 1; i <= 4; i++) {
      insertMessage(db, { roomId: room.id, sessionSeq: s1.seq, authorId: 'codex', content: `m${i}` });
    }
    const page1 = listMessages(db, room.id, undefined, 2);
    expect(page1.messages.map((m) => m.content)).toEqual(['m3', 'm4']);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = listMessages(db, room.id, page1.nextCursor!, 2);
    expect(page2.messages.map((m) => m.content)).toEqual(['m1', 'm2']);
    expect(page2.nextCursor).toBeNull();
  });

  it('listMessages does not throw for limit=0', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const s1 = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: s1.seq, authorId: 'codex', content: 'm1' });
    expect(() => listMessages(db, room.id, undefined, 0)).not.toThrow();
    const result = listMessages(db, room.id, undefined, 0);
    expect(result.messages).toEqual([]);
  });
});

describe('completeExploring', () => {
  it('marks the message completed with an optional note', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const s1 = createSession(db, room.id, 'codex');
    const { message } = insertMessage(db, {
      roomId: room.id, sessionSeq: s1.seq, authorId: 'codex',
      content: 'exploring X', type: 'exploring',
    });
    completeExploring(db, message.id, 'human forced termination');
    const updated = getMessageById(db, message.id)!;
    expect(updated.exploringStatus).toBe('completed');
    expect(updated.exploringNote).toBe('human forced termination');
    // append-only invariant: completeExploring must not touch anything else
    expect(updated.content).toBe(message.content);
    expect(updated.type).toBe(message.type);
    expect(updated.authorId).toBe(message.authorId);
    expect(updated.sessionSeq).toBe(message.sessionSeq);
    expect(updated.createdAt).toBe(message.createdAt);
  });

  it('does not affect a message that is not of type exploring', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const s1 = createSession(db, room.id, 'codex');
    const { message } = insertMessage(db, {
      roomId: room.id, sessionSeq: s1.seq, authorId: 'codex',
      content: 'a fact', type: 'fact',
    });
    completeExploring(db, message.id, 'should not apply');
    const updated = getMessageById(db, message.id)!;
    expect(updated.exploringStatus).toBeNull();
    expect(updated.exploringNote).toBeNull();
    expect(updated.type).toBe('fact');
    expect(updated.content).toBe(message.content);
  });

  it('preserves the existing note when called again without a note', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const s1 = createSession(db, room.id, 'codex');
    const { message } = insertMessage(db, {
      roomId: room.id, sessionSeq: s1.seq, authorId: 'codex',
      content: 'exploring X', type: 'exploring',
    });
    completeExploring(db, message.id, 'first note');
    completeExploring(db, message.id);
    const updated = getMessageById(db, message.id)!;
    expect(updated.exploringStatus).toBe('completed');
    expect(updated.exploringNote).toBe('first note');
  });
});
