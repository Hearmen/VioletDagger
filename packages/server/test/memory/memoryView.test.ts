import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../src/storage/db';
import { createRoom } from '../../src/storage/rooms';
import { insertMessage, setMessageType, completeExploring } from '../../src/storage/messages';
import { buildMemoryView } from '../../src/memory/memoryView';

describe('buildMemoryView', () => {
  it('returns an empty view with a null goal for an empty room', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    expect(buildMemoryView(db, room.id)).toMatchObject({ goalMessageId: null, openQuestions: [], transitions: {} });
  });

  it('groups full messages by current type, keeps all exploring, and indexes transitions', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const goal = insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'goal', type: 'open_question' });
    const h = insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'codex', content: 'h', type: 'hypothesis', targetMessageId: goal.id });
    const v = insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'v', type: 'verify', targetMessageId: h.id, verifyVerdict: false });
    setMessageType(db, room.id, h.id, 'boundary', v.id);
    const a = insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'codex', content: 'exploring A', type: 'exploring', targetMessageId: goal.id });
    completeExploring(db, room.id, a.id, { reason: 'explicit', resultSummary: 'x' });
    insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'codex', content: 'exploring B', type: 'exploring', targetMessageId: goal.id });
    insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'codex', content: 'chat' });

    const view = buildMemoryView(db, room.id);
    expect(view.goalMessageId).toBe(goal.id);
    expect(view.openQuestions.map((m) => m.id)).toEqual([goal.id]);
    expect(view.hypotheses).toEqual([]);
    expect(view.boundaries.map((m) => m.id)).toEqual([h.id]);
    expect(view.verifies.map((m) => m.id)).toEqual([v.id]);
    expect(view.exploring).toHaveLength(2);
    expect(Object.keys(view.transitions)).toEqual([String(h.id)]);
    expect(view.transitions[h.id][0]).toMatchObject({ fromType: 'hypothesis', toType: 'boundary', triggerMessageId: v.id });
  });
});
