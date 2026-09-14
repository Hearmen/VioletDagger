import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTestDb } from '../../src/storage/db';
import { createRoom, getRoomAgents, setAgentState } from '../../src/storage/rooms';
import { createSession, getSession } from '../../src/storage/sessions';
import { insertMessage, getMessagesBySession, getActiveExploring } from '../../src/storage/messages';
import { createStuckCounter } from '../../src/orchestrator-core/stuckCounter';
import { onSessionEnded, terminateAgentSession } from '../../src/orchestrator-core/sessionLifecycle';
import { roomEvents } from '../../src/events';

afterEach(() => {
  roomEvents.removeAllListeners('message');
  roomEvents.removeAllListeners('roomStatus');
  roomEvents.removeAllListeners('memoryUpdate');
});

describe('onSessionEnded', () => {
  it('marks the session completed when it exited zero and posted a typed message', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: session.seq, authorId: 'codex', content: 'a fact', type: 'fact' });

    onSessionEnded(
      db,
      { roomId: room.id, seq: session.seq, agentId: 'codex', result: 'exited-zero', rawLogPath: '/logs/1.jsonl' },
      vi.fn(),
      createStuckCounter(),
    );

    expect(getSession(db, room.id, session.seq)!.outcome).toBe('completed');
  });

  it('marks the session passed when it exited zero without any typed message', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: session.seq, authorId: 'codex', content: 'just chatting' });

    onSessionEnded(
      db,
      { roomId: room.id, seq: session.seq, agentId: 'codex', result: 'exited-zero', rawLogPath: '/logs/1.jsonl' },
      vi.fn(),
      createStuckCounter(),
    );

    expect(getSession(db, room.id, session.seq)!.outcome).toBe('passed');
  });

  it('marks the session error and inserts a system message on nonzero exit', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');

    const messageListener = vi.fn();
    const roomStatusListener = vi.fn();
    roomEvents.once('message', messageListener);
    roomEvents.once('roomStatus', roomStatusListener);

    onSessionEnded(
      db,
      { roomId: room.id, seq: session.seq, agentId: 'codex', result: 'exited-nonzero', rawLogPath: '/logs/1.jsonl' },
      vi.fn(),
      createStuckCounter(),
    );

    expect(getSession(db, room.id, session.seq)!.outcome).toBe('error');
    const messages = getMessagesBySession(db, room.id, session.seq);
    expect(messages.some((m) => m.authorId === 'system')).toBe(true);

    expect(messageListener).toHaveBeenCalledTimes(1);
    expect(messageListener.mock.calls[0][0]).toMatchObject({ roomId: room.id });
    expect(messageListener.mock.calls[0][0].message.authorId).toBe('system');
    expect(roomStatusListener).toHaveBeenCalledWith({ roomId: room.id });
  });

  it('is idempotent when the session has already finished', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    onSessionEnded(
      db,
      { roomId: room.id, seq: session.seq, agentId: 'codex', result: 'exited-zero', rawLogPath: '/logs/1.jsonl' },
      vi.fn(),
      createStuckCounter(),
    );
    const startSession = vi.fn();

    onSessionEnded(
      db,
      { roomId: room.id, seq: session.seq, agentId: 'codex', result: 'exited-nonzero', rawLogPath: '/logs/2.jsonl' },
      startSession,
      createStuckCounter(),
    );

    expect(getSession(db, room.id, session.seq)!.outcome).toBe('passed'); // unchanged from first call
  });

  it('triggers a dispatch check after the state transition', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex', 'claude'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    const startSession = vi.fn();

    onSessionEnded(
      db,
      { roomId: room.id, seq: session.seq, agentId: 'codex', result: 'exited-zero', rawLogPath: '/logs/1.jsonl' },
      startSession,
      createStuckCounter(),
    );

    expect(startSession).toHaveBeenCalled();
  });
});

describe('terminateAgentSession', () => {
  it('kills the process, marks the session terminated, completes active exploring, and frees the agent', async () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: session.seq, authorId: 'codex', content: 'exploring X', type: 'exploring' });
    const killSession = vi.fn().mockResolvedValue({ rawLogPath: '/logs/1.jsonl' });
    const startSession = vi.fn();

    const memoryUpdateListener = vi.fn();
    roomEvents.once('memoryUpdate', memoryUpdateListener);

    await terminateAgentSession(db, room.id, session.seq, killSession, startSession, createStuckCounter());

    expect(killSession).toHaveBeenCalledWith(room.id, session.seq);
    expect(getSession(db, room.id, session.seq)!.outcome).toBe('terminated');
    const active = getActiveExploring(db, room.id);
    expect(active).toEqual([]);
    expect(memoryUpdateListener).toHaveBeenCalledTimes(1);
    expect(memoryUpdateListener.mock.calls[0][0]).toMatchObject({ roomId: room.id });
  });

  it('still terminates cleanly and dispatches when killSession rejects', async () => {
    const db = createTestDb();
    // 'claude' has lower join order than 'codex', so once codex is freed and
    // re-dispatch runs, claude (already idle) is picked first, letting us
    // observe codex settle at 'idle' rather than immediately being re-dispatched.
    const room = createRoom(db, 'a', ['claude', 'codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    setAgentState(db, room.id, 'codex', 'running', session.seq);
    const killSession = vi.fn().mockRejectedValue(new Error('ESRCH'));
    const startSession = vi.fn();

    await terminateAgentSession(db, room.id, session.seq, killSession, startSession, createStuckCounter());

    expect(getSession(db, room.id, session.seq)!.outcome).toBe('terminated');
    expect(getRoomAgents(db, room.id).find((a) => a.agentId === 'codex')).toMatchObject({ state: 'idle' });
    expect(startSession).toHaveBeenCalled();
  });

  it('is idempotent when the session has already finished', async () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    const killSession = vi.fn().mockResolvedValue({ rawLogPath: null });
    await terminateAgentSession(db, room.id, session.seq, killSession, vi.fn(), createStuckCounter());

    killSession.mockClear();
    await terminateAgentSession(db, room.id, session.seq, killSession, vi.fn(), createStuckCounter());

    expect(killSession).not.toHaveBeenCalled();
  });

  it('triggers a dispatch check after cleanup', async () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex', 'claude'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    const startSession = vi.fn();

    await terminateAgentSession(
      db, room.id, session.seq,
      vi.fn().mockResolvedValue({ rawLogPath: null }),
      startSession,
      createStuckCounter(),
    );

    expect(startSession).toHaveBeenCalled();
  });
});
