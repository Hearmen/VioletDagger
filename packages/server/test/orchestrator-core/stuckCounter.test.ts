import { describe, it, expect, afterEach } from 'vitest';
import { createTestDb } from '../../src/storage/db';
import { createRoom } from '../../src/storage/rooms';
import { createSession } from '../../src/storage/sessions';
import { insertMessage, completeExploring, getActiveExploring } from '../../src/storage/messages';
import { createStuckCounter, getStuckAgents, resetStuckCount } from '../../src/orchestrator-core/stuckCounter';
import { roomEvents } from '../../src/events';

afterEach(() => {
  roomEvents.removeAllListeners('roomStatus');
});

describe('getStuckAgents', () => {
  it('excludes an agent below the stuck threshold', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: session.seq, authorId: 'codex', content: 'exploring X', type: 'exploring' });

    const stuckCounter = createStuckCounter();
    stuckCounter.increment(room.id, 'codex');
    stuckCounter.increment(room.id, 'codex');

    expect(getStuckAgents(db, room.id, stuckCounter)).toEqual([]);
  });

  it('includes an agent at/above the threshold with an active exploring message', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: session.seq, authorId: 'codex', content: 'exploring X', type: 'exploring' });

    const stuckCounter = createStuckCounter();
    stuckCounter.increment(room.id, 'codex');
    stuckCounter.increment(room.id, 'codex');
    stuckCounter.increment(room.id, 'codex');

    expect(getStuckAgents(db, room.id, stuckCounter)).toEqual([{ agentId: 'codex', stuckCount: 3 }]);
  });

  it('excludes an agent with a high stuck count but no active exploring message', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    const { message } = insertMessage(db, { roomId: room.id, sessionSeq: session.seq, authorId: 'codex', content: 'exploring X', type: 'exploring' });
    completeExploring(db, room.id, message.id);

    const stuckCounter = createStuckCounter();
    stuckCounter.increment(room.id, 'codex');
    stuckCounter.increment(room.id, 'codex');
    stuckCounter.increment(room.id, 'codex');

    expect(getActiveExploring(db, room.id)).toEqual([]);
    expect(getStuckAgents(db, room.id, stuckCounter)).toEqual([]);
  });
});

describe('resetStuckCount', () => {
  it('zeroes the count and emits roomStatus', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const stuckCounter = createStuckCounter();
    stuckCounter.increment(room.id, 'codex');
    stuckCounter.increment(room.id, 'codex');
    stuckCounter.increment(room.id, 'codex');

    let called: { roomId: number } | null = null;
    roomEvents.once('roomStatus', (payload) => {
      called = payload;
    });

    resetStuckCount(stuckCounter, room.id, 'codex');

    expect(stuckCounter.get(room.id, 'codex')).toBe(0);
    expect(called).toEqual({ roomId: room.id });
  });
});
