import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../src/storage/db';
import { createRoom } from '../../src/storage/rooms';
import {
  createSession, setSessionPgid, finishSession, getSession, listSessions, countSessions,
} from '../../src/storage/sessions';

describe('sessions', () => {
  it('createSession assigns room-scoped incrementing seq', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex', 'claude'], 'sequential');
    const s1 = createSession(db, room.id, 'codex');
    const s2 = createSession(db, room.id, 'claude');
    expect(s1.seq).toBe(1);
    expect(s2.seq).toBe(2);
    expect(s1.outcome).toBe('running');
    expect(s1.endedAt).toBeNull();
  });

  it('setSessionPgid and finishSession update the row', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const s = createSession(db, room.id, 'codex');
    setSessionPgid(db, room.id, s.seq, 4242);
    finishSession(db, room.id, s.seq, 'completed', '/logs/1.jsonl');
    const updated = getSession(db, room.id, s.seq)!;
    expect(updated.pgid).toBe(4242);
    expect(updated.outcome).toBe('completed');
    expect(updated.rawLogPath).toBe('/logs/1.jsonl');
    expect(updated.endedAt).not.toBeNull();
  });

  it('listSessions returns sessions ordered by seq, countSessions returns max seq', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex', 'claude'], 'sequential');
    createSession(db, room.id, 'codex');
    createSession(db, room.id, 'claude');
    expect(listSessions(db, room.id).map((s) => s.seq)).toEqual([1, 2]);
    expect(countSessions(db, room.id)).toBe(2);
  });

  it('countSessions returns 0 for a room with no sessions', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    expect(countSessions(db, room.id)).toBe(0);
  });
});
