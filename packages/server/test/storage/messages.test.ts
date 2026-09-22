import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../src/storage/db';
import { createRoom } from '../../src/storage/rooms';
import { createSession } from '../../src/storage/sessions';
import {
  insertMessage,
  getFirstMessage, getMessagesBySession, listMessages, getMessagesByType,
  getActiveExploring, getRecentRawMessages, getAnnotations, getMessageById, completeExploring,
  validateMessageRelations, getLatestMessageByTypes, getLatestDirectedMessage, getLatestDispatchTriggerAt,
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
    expect(getAnnotations(db, room.id, fact.message.id).map((m) => m.type)).toEqual(['verify']);
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

describe('validateMessageRelations', () => {
  it('rejects an unknown message type', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    expect(() => validateMessageRelations(db, room.id, { type: 'bogus' as never })).toThrow('unknown message type');
  });

  it('accepts a known message type', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    expect(() => validateMessageRelations(db, room.id, { type: 'fact' })).not.toThrow();
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
    completeExploring(db, room.id, message.id, 'human forced termination');
    const updated = getMessageById(db, room.id, message.id)!;
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
    expect(() => completeExploring(db, room.id, message.id, 'should not apply')).toThrow('not active');
    const updated = getMessageById(db, room.id, message.id)!;
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
    completeExploring(db, room.id, message.id, 'first note');
    expect(() => completeExploring(db, room.id, message.id)).toThrow('not active');
    const updated = getMessageById(db, room.id, message.id)!;
    expect(updated.exploringStatus).toBe('completed');
    expect(updated.exploringNote).toBe('first note');
  });
});

describe('room-scoped message id', () => {
  it('restarts at 1 in each room (ids are not globally unique)', () => {
    const db = createTestDb();
    const roomA = createRoom(db, 'a', ['codex'], 'sequential');
    const roomB = createRoom(db, 'b', ['codex'], 'sequential');
    const a1 = insertMessage(db, { roomId: roomA.id, sessionSeq: null, authorId: 'human', content: 'a1' });
    const b1 = insertMessage(db, { roomId: roomB.id, sessionSeq: null, authorId: 'human', content: 'b1' });
    const a2 = insertMessage(db, { roomId: roomA.id, sessionSeq: null, authorId: 'human', content: 'a2' });

    expect(a1.message.id).toBe(1);
    expect(b1.message.id).toBe(1);
    expect(a2.message.id).toBe(2);
    expect(getMessageById(db, roomB.id, 1)!.content).toBe('b1');
    expect(getMessageById(db, roomA.id, 1)!.content).toBe('a1');
  });

  it('allows the same numeric ids to be referenced independently in each room', () => {
    const db = createTestDb();
    const roomA = createRoom(db, 'a', ['codex'], 'sequential');
    const roomB = createRoom(db, 'b', ['codex'], 'sequential');
    const factA = insertMessage(db, { roomId: roomA.id, sessionSeq: null, authorId: 'human', content: 'fact A', type: 'fact' });
    const factB = insertMessage(db, { roomId: roomB.id, sessionSeq: null, authorId: 'human', content: 'fact B', type: 'fact' });
    expect(factA.message.id).toBe(1);
    expect(factB.message.id).toBe(1);

    const chainA = insertMessage(db, {
      roomId: roomA.id, sessionSeq: null, authorId: 'human', content: 'plan A',
      type: 'chain', referencedMessageIds: [factA.message.id],
    });
    const chainB = insertMessage(db, {
      roomId: roomB.id, sessionSeq: null, authorId: 'human', content: 'plan B',
      type: 'chain', referencedMessageIds: [factB.message.id],
    });
    expect(chainA.message.referencedMessageIds).toEqual([1]);
    expect(chainB.message.referencedMessageIds).toEqual([1]);
    expect(getMessagesByType(db, roomA.id, 'chain')[0].content).toBe('plan A');
    expect(getMessagesByType(db, roomB.id, 'chain')[0].content).toBe('plan B');
  });
});

describe('getLatestMessageByTypes', () => {
  it('returns the highest-id message among the given types, regardless of author', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'codex', content: 'a fact', type: 'fact' });
    const verify = insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'codex', content: 'looks fine', type: 'verify', targetMessageId: 1 });
    const proposal = insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'codex', content: 'done', type: 'propose_completion' });

    expect(getLatestMessageByTypes(db, room.id, ['fact', 'propose_completion'])!.id).toBe(proposal.message.id);
    expect(getLatestMessageByTypes(db, room.id, ['verify'])!.id).toBe(verify.message.id);
  });

  it('returns null when no message of the given types exists', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'codex', content: 'a fact', type: 'fact' });

    expect(getLatestMessageByTypes(db, room.id, ['propose_completion'])).toBeNull();
  });

  it('scopes to the given room', () => {
    const db = createTestDb();
    const roomA = createRoom(db, 'a', ['codex'], 'sequential');
    const roomB = createRoom(db, 'b', ['codex'], 'sequential');
    insertMessage(db, { roomId: roomA.id, sessionSeq: null, authorId: 'codex', content: 'done A', type: 'propose_completion' });

    expect(getLatestMessageByTypes(db, roomB.id, ['propose_completion'])).toBeNull();
  });

  // @ 定向消息（需求 3.3.2）：dispatch_scope='directed' 的 session 产出的消息不参与这个判定。
  it('excludes messages produced by a directed session', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['claude'], 'sequential');
    const directedSession = createSession(db, room.id, 'claude', 'directed');
    insertMessage(db, { roomId: room.id, sessionSeq: directedSession.seq, authorId: 'claude', content: 'done privately', type: 'propose_completion' });

    expect(getLatestMessageByTypes(db, room.id, ['propose_completion'])).toBeNull();
  });
});

describe('@ 定向消息 (targetAgentId)', () => {
  it('insertMessage persists targetAgentId and it round-trips through getMessageById', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex', 'claude'], 'sequential');
    const { message } = insertMessage(db, {
      roomId: room.id, sessionSeq: null, authorId: 'human', content: 'just for you', targetAgentId: 'claude',
    });

    expect(message.targetAgentId).toBe('claude');
    expect(getMessageById(db, room.id, message.id)!.targetAgentId).toBe('claude');
  });

  it('defaults targetAgentId to null when not provided', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const { message } = insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'hi' });

    expect(message.targetAgentId).toBeNull();
  });

  describe('getLatestDirectedMessage', () => {
    it('returns the latest message targeted at the given agent', () => {
      const db = createTestDb();
      const room = createRoom(db, 'a', ['codex', 'claude'], 'sequential');
      insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'first', targetAgentId: 'claude' });
      const second = insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'second', targetAgentId: 'claude' });

      expect(getLatestDirectedMessage(db, room.id, 'claude')!.id).toBe(second.message.id);
    });

    it('returns null when nothing is targeted at that agent', () => {
      const db = createTestDb();
      const room = createRoom(db, 'a', ['codex', 'claude'], 'sequential');
      insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'first', targetAgentId: 'claude' });

      expect(getLatestDirectedMessage(db, room.id, 'codex')).toBeNull();
    });
  });

  describe('getLatestDispatchTriggerAt', () => {
    it('excludes messages targeted at a different agent', () => {
      const db = createTestDb();
      const room = createRoom(db, 'a', ['codex', 'claude'], 'sequential');
      insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'just for claude', targetAgentId: 'claude' });

      expect(getLatestDispatchTriggerAt(db, room.id, 'codex', ['fact'])).toBeNull();
    });

    it('excludes messages produced by a directed session', () => {
      const db = createTestDb();
      const room = createRoom(db, 'a', ['codex', 'claude'], 'sequential');
      const directedSession = createSession(db, room.id, 'claude', 'directed');
      insertMessage(db, { roomId: room.id, sessionSeq: directedSession.seq, authorId: 'claude', content: 'a private fact', type: 'fact' });

      expect(getLatestDispatchTriggerAt(db, room.id, 'codex', ['fact'])).toBeNull();
    });

    it('still counts broadcast messages from an ordinary session', () => {
      const db = createTestDb();
      const room = createRoom(db, 'a', ['codex', 'claude'], 'sequential');
      const session = createSession(db, room.id, 'claude');
      const { message } = insertMessage(db, { roomId: room.id, sessionSeq: session.seq, authorId: 'claude', content: 'a fact', type: 'fact' });

      expect(getLatestDispatchTriggerAt(db, room.id, 'codex', ['fact'])).toBe(message.createdAt);
    });
  });
});
