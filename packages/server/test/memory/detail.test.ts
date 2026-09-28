import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../src/storage/db';
import { createRoom } from '../../src/storage/rooms';
import { insertMessage, setMessageType, completeExploring } from '../../src/storage/messages';
import { buildDetail } from '../../src/memory/detail';
import type { DetailPage, MessageWithAnnotations } from '../../src/memory';

describe('buildDetail', () => {
  it('returns a single message with its annotations, answers, reverse references and transitions', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex', 'claude'], 'sequential');
    const q = insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'q', type: 'open_question' });
    const h = insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'codex', content: 'h', type: 'hypothesis', targetMessageId: q.id });
    const v = insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'claude', content: 'ok', type: 'verify', targetMessageId: h.id, verifyVerdict: true });
    setMessageType(db, room.id, h.id, 'fact', v.id);
    const c = insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'codex', content: 'c', type: 'chain', targetMessageId: q.id, referencedMessageIds: [h.id] });

    const hd = buildDetail(db, room.id, { messageId: h.id }) as MessageWithAnnotations;
    expect(hd.type).toBe('fact');
    expect(hd.annotations.map((m) => m.id)).toEqual([v.id]);
    expect(hd.referencedByIds).toEqual([c.id]);
    expect(hd.transitions).toEqual([expect.objectContaining({ fromType: 'hypothesis', toType: 'fact' })]);
    expect(hd.answers).toEqual([]);

    const qd = buildDetail(db, room.id, { messageId: q.id }) as MessageWithAnnotations;
    expect(qd.answers.map((m) => m.id)).toEqual([h.id, c.id]);
  });

  it('throws when the messageId does not belong to the given room', () => {
    const db = createTestDb();
    const roomA = createRoom(db, 'a', ['codex'], 'sequential');
    const roomB = createRoom(db, 'b', ['codex'], 'sequential');
    const fact = insertMessage(db, { roomId: roomA.id, sessionSeq: null, authorId: 'codex', content: 'a fact', type: 'fact' });
    insertMessage(db, { roomId: roomA.id, sessionSeq: null, authorId: 'codex', content: 'another', type: 'fact' });
    expect(() => buildDetail(db, roomB.id, { messageId: fact.id + 1 })).toThrow();
  });

  it('returns all exploring records regardless of active/completed status when queried by type', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const a = insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'codex', content: 'exploring A', type: 'exploring' });
    completeExploring(db, room.id, a.id, { reason: 'explicit', resultSummary: 'done' });
    insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'codex', content: 'exploring B', type: 'exploring' });
    const details = buildDetail(db, room.id, { type: 'exploring' }) as MessageWithAnnotations[];
    expect(details.map((d) => [d.content, d.exploringStatus])).toEqual([['exploring A', 'completed'], ['exploring B', 'active']]);
  });

  it('pages through every raw message without duplication or cross-room leakage', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    for (let i = 0; i < 7; i++) insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'codex', content: `raw ${i}` });
    const other = createRoom(db, 'other', ['codex'], 'sequential');
    insertMessage(db, { roomId: other.id, authorId: 'human', sessionSeq: null, content: 'private other room' });
    let beforeId: number | undefined;
    const ids: number[] = [];
    do {
      const page = buildDetail(db, room.id, { list: true, beforeId, limit: 2 }) as DetailPage;
      expect(page.messages.every((m) => m.roomId === room.id)).toBe(true);
      ids.push(...page.messages.map((m) => m.id));
      beforeId = page.nextCursor ?? undefined;
    } while (beforeId);
    expect(ids.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(() => buildDetail(db, room.id, { messageId: 1, list: true })).toThrow();
    expect(() => buildDetail(db, room.id, { list: true, limit: 101 })).toThrow();
  });
});
