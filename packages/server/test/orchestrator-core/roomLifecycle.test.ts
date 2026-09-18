import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTestDb } from '../../src/storage/db';
import { createRoom, getRoom, getRoomAgents, setRoomStatus, setAgentState } from '../../src/storage/rooms';
import { createSession, getSession, listSessions } from '../../src/storage/sessions';
import { insertMessage, getMessagesByType } from '../../src/storage/messages';
import { createStuckCounter } from '../../src/orchestrator-core/stuckCounter';
import { createFailureCounter } from '../../src/orchestrator-core/failureCounter';
import { pauseRoom, resumeRoom, confirmCompletion, deleteRoom } from '../../src/orchestrator-core/roomLifecycle';
import { roomEvents } from '../../src/events';

afterEach(() => {
  roomEvents.removeAllListeners('roomStatus');
  roomEvents.removeAllListeners('roomDeleted');
});

function stopConfirmed(roomId: number, seq: number, agentId: string) {
  return vi.fn().mockResolvedValue({
    confirmed: true,
    exit: {
      roomId, seq, agentId, exitCode: null, signal: 'SIGTERM',
      exitCause: 'managed-stop', rawLogPath: `/logs/${roomId}/${seq}.jsonl`,
    },
  });
}

function deleteDeps(overrides: Partial<Parameters<typeof deleteRoom>[2]> = {}) {
  return {
    stopSessionProcess: stopConfirmed(1, 1, 'codex'),
    startSession: vi.fn(),
    stuckCounter: createStuckCounter(),
    failureCounter: createFailureCounter(),
    deleteRoomArtifacts: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

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

describe('deleteRoom', () => {
  it('rejects a room that is not completed', async () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    await expect(deleteRoom(db, room.id, deleteDeps())).rejects.toThrow(/completed/);
    expect(getRoom(db, room.id)).not.toBeNull();
  });

  it('rejects a missing room', async () => {
    const db = createTestDb();
    await expect(deleteRoom(db, 999, deleteDeps())).rejects.toThrow(/not found/);
  });

  it('cascade-deletes sessions/messages, removes artifacts, and emits roomDeleted', async () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: session.seq, authorId: 'codex', content: 'x', type: 'fact' });
    confirmCompletion(db, room.id);

    const deps = deleteDeps();
    const deletedEvents: number[] = [];
    roomEvents.once('roomDeleted', (payload) => deletedEvents.push(payload.roomId));

    await deleteRoom(db, room.id, deps);

    expect(getRoom(db, room.id)).toBeNull();
    expect(listSessions(db, room.id)).toHaveLength(0);
    expect(getMessagesByType(db, room.id, 'fact')).toHaveLength(0);
    expect(getRoomAgents(db, room.id)).toHaveLength(0);
    expect(deps.deleteRoomArtifacts).toHaveBeenCalledWith(room.id);
    expect(deletedEvents).toEqual([room.id]);
  });

  it('terminates a lingering running session before deleting', async () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    setAgentState(db, room.id, 'codex', 'running', session.seq);
    confirmCompletion(db, room.id);

    const deps = deleteDeps({ stopSessionProcess: stopConfirmed(room.id, session.seq, 'codex') });
    await deleteRoom(db, room.id, deps);

    expect(deps.stopSessionProcess).toHaveBeenCalledWith(room.id, session.seq);
    expect(getRoom(db, room.id)).toBeNull();
    // 收尾走的是 terminateAgentSession，session 被标记为 terminated 后才级联删除
    expect(getSession(db, room.id, session.seq)).toBeNull();
  });

  it('aborts deletion and keeps the room when terminating a lingering session cannot be confirmed', async () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    setAgentState(db, room.id, 'codex', 'running', session.seq);
    confirmCompletion(db, room.id);

    const deps = deleteDeps({
      stopSessionProcess: vi.fn().mockResolvedValue({ confirmed: false, error: 'still running', rawLogPath: '/logs/x' }),
    });
    await expect(deleteRoom(db, room.id, deps)).rejects.toThrow(/still running/);

    expect(getRoom(db, room.id)).not.toBeNull();
    expect(getSession(db, room.id, session.seq)).not.toBeNull();
  });
});
