import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../src/storage/db';
import { createRoom } from '../../src/storage/rooms';
import { createSession } from '../../src/storage/sessions';
import {
  insertMessage, countMessages,
  getFirstMessage, getMessagesBySession, listMessages, getMessagesByType,
  getActiveExploring, getActiveExploringByAuthor, getRecentRawMessages, getMessageById, completeExploring,
  setMessageType, setQuestionStatus, setChainStatus, getStateTransitions, getRoomStateTransitions,
  runInTransaction,
} from '../../src/storage/messages';
import { deleteRoom } from '../../src/storage/rooms';

describe('insertMessage', () => {
  it('inserts a plain chat message with an auto-truncated summary', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    const message = insertMessage(db, {
      roomId: room.id,
      sessionSeq: session.seq,
      authorId: 'codex',
      content: 'hello room',
    });
    expect(message.type).toBeNull();
    expect(message.summary).toBe('hello room');
    expect(message.questionStatus).toBeNull();
    expect(message.chainStatus).toBeNull();
    expect(message.closesQuestion).toBe(false);
    expect(message.verifyVerdict).toBeNull();
  });

  it('writes the initial state for stateful types', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const q = insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'q', type: 'open_question' });
    const chain = insertMessage(db, {
      roomId: room.id, sessionSeq: null, authorId: 'human', content: 'c', type: 'chain',
      targetMessageId: q.id, closesQuestion: true, chainResolution: 'RESOLVED',
    });
    const exploring = insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'e', type: 'exploring', targetMessageId: q.id });
    const verify = insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'v', type: 'verify', targetMessageId: chain.id, verifyVerdict: false });
    expect(q.questionStatus).toBe('OPEN');
    expect(chain.chainStatus).toBe('CANDIDATE');
    expect(chain.closesQuestion).toBe(true);
    expect(chain.chainResolution).toBe('RESOLVED');
    expect(exploring.exploringStatus).toBe('active');
    expect(verify.verifyVerdict).toBe(false);
  });

  it('does not record chainResolution unless the chain closes its question', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const chain = insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'c', type: 'chain', chainResolution: 'RESOLVED' });
    expect(chain.closesQuestion).toBe(false);
    expect(chain.chainResolution).toBeNull();
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
      referencedMessageIds: [fact.id],
    });
    expect(chain.referencedMessageIds).toEqual([fact.id]);
  });

  it('respects an explicitly provided summary', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const s1 = createSession(db, room.id, 'codex');
    const message = insertMessage(db, {
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
    expect(getFirstMessage(db, room.id)!.id).toBe(first.id);
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
    const x = insertMessage(db, { roomId: room.id, sessionSeq: s1.seq, authorId: 'codex', content: 'exploring X', type: 'exploring' });
    completeExploring(db, room.id, x.id, { reason: 'explicit', resultSummary: 'done' });
    const s2 = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: s2.seq, authorId: 'codex', content: 'exploring Y', type: 'exploring' });
    const active = getActiveExploring(db, room.id);
    expect(active.map((m) => m.content)).toEqual(['exploring Y']);
    expect(getActiveExploringByAuthor(db, room.id, 'codex')!.content).toBe('exploring Y');
    expect(getActiveExploringByAuthor(db, room.id, 'claude')).toBeNull();
  });

  it('countMessages counts every message in the room', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    expect(countMessages(db, room.id)).toBe(0);
    insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'm1' });
    insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'm2' });
    expect(countMessages(db, room.id)).toBe(2);
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
  it('records an explicit completion with its result atomically', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const message = insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'codex', content: 'exploring X', type: 'exploring' });
    completeExploring(db, room.id, message.id, { reason: 'explicit', resultSummary: 'no conclusion', resultMessageIds: [1, 1] });
    const updated = getMessageById(db, room.id, message.id)!;
    expect(updated.exploringStatus).toBe('completed');
    expect(updated.exploringEndReason).toBe('explicit');
    expect(updated.exploringResultSummary).toBe('no conclusion');
    expect(updated.exploringResultMessageIds).toEqual([1]);
    expect(updated.exploringNote).toBeNull();
    expect(updated.content).toBe(message.content);
  });

  it('records a human-terminated completion with its note and no result', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const message = insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'codex', content: 'exploring X', type: 'exploring' });
    completeExploring(db, room.id, message.id, { reason: 'human_terminated', note: '人类强制终止' });
    const updated = getMessageById(db, room.id, message.id)!;
    expect(updated.exploringEndReason).toBe('human_terminated');
    expect(updated.exploringNote).toBe('人类强制终止');
    expect(updated.exploringResultSummary).toBeNull();
  });

  it('only allows active -> completed once and rejects non-exploring messages', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const fact = insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'codex', content: 'a fact', type: 'fact' });
    expect(() => completeExploring(db, room.id, fact.id, { reason: 'explicit', resultSummary: 'x' })).toThrow('not active');
    const exploring = insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'codex', content: 'e', type: 'exploring' });
    completeExploring(db, room.id, exploring.id, { reason: 'explicit', resultSummary: 'first' });
    expect(() => completeExploring(db, room.id, exploring.id, { reason: 'human_terminated', note: 'n' })).toThrow('not active');
    expect(getMessageById(db, room.id, exploring.id)!.exploringResultSummary).toBe('first');
  });
});

describe('state transitions', () => {
  it('setMessageType changes the current type and appends a transition record', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const h = insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'codex', content: 'h', type: 'hypothesis' });
    const v = insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'v', type: 'verify', targetMessageId: h.id, verifyVerdict: true });
    setMessageType(db, room.id, h.id, 'fact', v.id, 'verified');
    expect(getMessageById(db, room.id, h.id)!.type).toBe('fact');
    expect(getMessageById(db, room.id, h.id)!.content).toBe('h');
    const [t] = getStateTransitions(db, room.id, h.id);
    expect(t).toMatchObject({ id: 1, messageId: h.id, fromType: 'hypothesis', toType: 'fact', fromStatus: null, toStatus: null, triggerMessageId: v.id, reason: 'verified' });
  });

  it('setMessageType refuses to convert types outside hypothesis/fact/boundary', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const q = insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'q', type: 'open_question' });
    expect(() => setMessageType(db, room.id, q.id, 'fact', q.id)).toThrow();
    expect(getStateTransitions(db, room.id, q.id)).toEqual([]);
  });

  it('setQuestionStatus closes and reopens a question, folding the close reason into the status string', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const q = insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'q', type: 'open_question' });
    const c = insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'codex', content: 'c', type: 'chain', targetMessageId: q.id });
    setQuestionStatus(db, room.id, q.id, { status: 'CLOSED', closeReason: 'UNRESOLVED', closedBy: c.id }, 99);
    let current = getMessageById(db, room.id, q.id)!;
    expect(current).toMatchObject({ questionStatus: 'CLOSED', questionCloseReason: 'UNRESOLVED', questionClosedBy: c.id });
    setQuestionStatus(db, room.id, q.id, { status: 'OPEN' }, 100);
    current = getMessageById(db, room.id, q.id)!;
    expect(current).toMatchObject({ questionStatus: 'OPEN', questionCloseReason: null, questionClosedBy: null });
    expect(getStateTransitions(db, room.id, q.id).map((t) => [t.fromStatus, t.toStatus])).toEqual([
      ['OPEN', 'CLOSED/UNRESOLVED'],
      ['CLOSED/UNRESOLVED', 'OPEN'],
    ]);
  });

  it('setChainStatus records status transitions; transition ids are room-scoped', () => {
    const db = createTestDb();
    const roomA = createRoom(db, 'a', ['codex'], 'sequential');
    const roomB = createRoom(db, 'b', ['codex'], 'sequential');
    const a = insertMessage(db, { roomId: roomA.id, sessionSeq: null, authorId: 'codex', content: 'c', type: 'chain' });
    const b = insertMessage(db, { roomId: roomB.id, sessionSeq: null, authorId: 'codex', content: 'c', type: 'chain' });
    setChainStatus(db, roomA.id, a.id, 'CHALLENGED', 5);
    setChainStatus(db, roomA.id, a.id, 'VERIFIED', 6);
    setChainStatus(db, roomB.id, b.id, 'REJECT', 7);
    expect(getMessageById(db, roomA.id, a.id)!.chainStatus).toBe('VERIFIED');
    expect(getRoomStateTransitions(db, roomA.id).map((t) => [t.id, t.fromStatus, t.toStatus])).toEqual([
      [1, 'CANDIDATE', 'CHALLENGED'],
      [2, 'CHALLENGED', 'VERIFIED'],
    ]);
    expect(getRoomStateTransitions(db, roomB.id).map((t) => t.id)).toEqual([1]);
  });

  it('runInTransaction rolls back inserts and transitions together', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const h = insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'codex', content: 'h', type: 'hypothesis' });
    expect(() => runInTransaction(db, () => {
      const v = insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'v', type: 'verify', targetMessageId: h.id, verifyVerdict: true });
      setMessageType(db, room.id, h.id, 'fact', v.id);
      throw new Error('boom');
    })).toThrow('boom');
    expect(countMessages(db, room.id)).toBe(1);
    expect(getMessageById(db, room.id, h.id)!.type).toBe('hypothesis');
    expect(getRoomStateTransitions(db, room.id)).toEqual([]);
  });

  it('deleteRoom removes the room transition log', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const c = insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'codex', content: 'c', type: 'chain' });
    setChainStatus(db, room.id, c.id, 'REJECT', 1);
    deleteRoom(db, room.id);
    expect(getRoomStateTransitions(db, room.id)).toEqual([]);
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

    expect(a1.id).toBe(1);
    expect(b1.id).toBe(1);
    expect(a2.id).toBe(2);
    expect(getMessageById(db, roomB.id, 1)!.content).toBe('b1');
    expect(getMessageById(db, roomA.id, 1)!.content).toBe('a1');
  });

  it('allows the same numeric ids to be referenced independently in each room', () => {
    const db = createTestDb();
    const roomA = createRoom(db, 'a', ['codex'], 'sequential');
    const roomB = createRoom(db, 'b', ['codex'], 'sequential');
    const factA = insertMessage(db, { roomId: roomA.id, sessionSeq: null, authorId: 'human', content: 'fact A', type: 'fact' });
    const factB = insertMessage(db, { roomId: roomB.id, sessionSeq: null, authorId: 'human', content: 'fact B', type: 'fact' });
    expect(factA.id).toBe(1);
    expect(factB.id).toBe(1);

    const chainA = insertMessage(db, {
      roomId: roomA.id, sessionSeq: null, authorId: 'human', content: 'plan A',
      type: 'chain', referencedMessageIds: [factA.id],
    });
    const chainB = insertMessage(db, {
      roomId: roomB.id, sessionSeq: null, authorId: 'human', content: 'plan B',
      type: 'chain', referencedMessageIds: [factB.id],
    });
    expect(chainA.referencedMessageIds).toEqual([1]);
    expect(chainB.referencedMessageIds).toEqual([1]);
    expect(getMessagesByType(db, roomA.id, 'chain')[0].content).toBe('plan A');
    expect(getMessagesByType(db, roomB.id, 'chain')[0].content).toBe('plan B');
  });
});

describe('@ 定向消息 (targetAgentId)', () => {
  it('insertMessage persists targetAgentId and it round-trips through getMessageById', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex', 'claude'], 'sequential');
    const message = insertMessage(db, {
      roomId: room.id, sessionSeq: null, authorId: 'human', content: 'just for you', targetAgentId: 'claude',
    });

    expect(message.targetAgentId).toBe('claude');
    expect(getMessageById(db, room.id, message.id)!.targetAgentId).toBe('claude');
  });

  it('defaults targetAgentId to null when not provided', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const message = insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'hi' });

    expect(message.targetAgentId).toBeNull();
  });
});
