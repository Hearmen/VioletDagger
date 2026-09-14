import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../src/storage/db';
import { createRoom } from '../../src/storage/rooms';
import { createSession } from '../../src/storage/sessions';
import { insertMessage } from '../../src/storage/messages';
import { buildMemoryView } from '../../src/memory/memoryView';

describe('buildMemoryView', () => {
  it('returns full message objects grouped by type, including all exploring records', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const s1 = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: s1.seq, authorId: 'codex', content: 'a fact', type: 'fact' });
    insertMessage(db, { roomId: room.id, sessionSeq: s1.seq, authorId: 'codex', content: 'exploring A', type: 'exploring' });
    const s2 = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: s2.seq, authorId: 'codex', content: 'exploring B', type: 'exploring' });

    const view = buildMemoryView(db, room.id);
    expect(view.facts).toHaveLength(1);
    expect(view.facts[0].content).toBe('a fact');
    expect(view.exploring).toHaveLength(2);
    expect(view.boundaries).toEqual([]);
  });
});
