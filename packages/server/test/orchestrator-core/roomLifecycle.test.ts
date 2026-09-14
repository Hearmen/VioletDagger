import { describe, it, expect, vi } from 'vitest';
import { createTestDb } from '../../src/storage/db';
import { createRoom, getRoom, setRoomStatus } from '../../src/storage/rooms';
import { createStuckCounter } from '../../src/orchestrator-core/stuckCounter';
import { pauseRoom, resumeRoom, confirmCompletion } from '../../src/orchestrator-core/roomLifecycle';

describe('room lifecycle', () => {
  it('pauseRoom sets status to paused_manual', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    pauseRoom(db, room.id);
    expect(getRoom(db, room.id)!.status).toBe('paused_manual');
  });

  it('resumeRoom from paused_manual reactivates and dispatches without requiring additionalSessions', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    pauseRoom(db, room.id);
    const startSession = vi.fn();

    resumeRoom(db, room.id, startSession, createStuckCounter());

    expect(getRoom(db, room.id)!.status).toBe('active');
    expect(startSession).toHaveBeenCalled();
  });

  it('resumeRoom from paused_limit requires additionalSessions and increases the cap', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    setRoomStatus(db, room.id, 'paused_limit');

    expect(() => resumeRoom(db, room.id, vi.fn(), createStuckCounter())).toThrow();

    resumeRoom(db, room.id, vi.fn(), createStuckCounter(), 5);
    expect(getRoom(db, room.id)!.status).toBe('active');
    expect(getRoom(db, room.id)!.maxSessions).toBe(25);
  });

  it('confirmCompletion sets status to completed', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    confirmCompletion(db, room.id);
    expect(getRoom(db, room.id)!.status).toBe('completed');
  });
});
