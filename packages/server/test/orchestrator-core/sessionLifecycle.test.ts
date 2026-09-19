import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTestDb } from '../../src/storage/db';
import { createRoom, getRoomAgents, setAgentState, setRoomStatus } from '../../src/storage/rooms';
import { createSession, getSession, listSessionEvents } from '../../src/storage/sessions';
import { insertMessage, getMessagesBySession, getActiveExploring } from '../../src/storage/messages';
import { createStuckCounter } from '../../src/orchestrator-core/stuckCounter';
import { createFailureCounter } from '../../src/orchestrator-core/failureCounter';
import { onSessionEnded, terminateAgentSession } from '../../src/orchestrator-core/sessionLifecycle';
import { setAgentEnabled } from '../../src/orchestrator-core/agentControl';
import type { SessionExitEvent } from '../../src/agent-invocation';
import { roomEvents } from '../../src/events';

afterEach(() => {
  roomEvents.removeAllListeners('message');
  roomEvents.removeAllListeners('roomStatus');
  roomEvents.removeAllListeners('memoryUpdate');
});

function exitEvent(roomId: number, seq: number, agentId: string, overrides: Partial<SessionExitEvent> = {}): SessionExitEvent {
  return {
    roomId, seq, agentId, exitCode: 0, signal: null,
    exitCause: 'natural', rawLogPath: `/logs/${roomId}/${seq}.jsonl`, ...overrides,
  };
}

describe('onSessionEnded', () => {
  it('marks the session completed when it exited naturally and posted a typed message', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: session.seq, authorId: 'codex', content: 'a fact', type: 'fact' });

    onSessionEnded(db, exitEvent(room.id, session.seq, 'codex'), vi.fn(), createStuckCounter(), createFailureCounter());

    expect(getSession(db, room.id, session.seq)!.outcome).toBe('completed');
  });

  it('marks the session passed when it exited naturally without any typed message, and writes a placeholder message', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: session.seq, authorId: 'codex', content: 'just chatting' });

    const messageListener = vi.fn();
    roomEvents.once('message', messageListener);

    onSessionEnded(db, exitEvent(room.id, session.seq, 'codex'), vi.fn(), createStuckCounter(), createFailureCounter());

    expect(getSession(db, room.id, session.seq)!.outcome).toBe('passed');
    const messages = getMessagesBySession(db, room.id, session.seq);
    expect(messages).toHaveLength(2); // 原来的闲聊 + 补写的占位消息
    const placeholder = messages.find((m) => m.content.includes('未发出任何实质消息'))!;
    expect(placeholder.authorId).toBe('codex'); // 占位消息归属产生这次 session 的 agent，而非 'system'
    expect(placeholder.type).toBeNull();
    expect(messageListener).toHaveBeenCalledTimes(1);
  });

  it('marks the session error, records process_exited, and inserts a placeholder message attributed to the agent', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');

    const messageListener = vi.fn();
    const roomStatusListener = vi.fn();
    roomEvents.once('message', messageListener);
    roomEvents.once('roomStatus', roomStatusListener);

    onSessionEnded(
      db,
      exitEvent(room.id, session.seq, 'codex', { exitCode: 1, exitCause: 'unexpected' }),
      vi.fn(),
      createStuckCounter(), createFailureCounter(),
    );

    expect(getSession(db, room.id, session.seq)!.outcome).toBe('error');
    const messages = getMessagesBySession(db, room.id, session.seq);
    expect(messages.some((m) => m.authorId === 'codex' && m.content.includes('异常退出'))).toBe(true);
    expect(listSessionEvents(db, room.id, session.seq).some((e) => e.kind === 'process_exited')).toBe(true);

    expect(messageListener).toHaveBeenCalledTimes(1);
    expect(messageListener.mock.calls[0][0].message.authorId).toBe('codex');
    expect(roomStatusListener).toHaveBeenCalledWith({ roomId: room.id });
  });

  it('settles a stopping session with stopIntent=terminate as terminated', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    setAgentState(db, room.id, 'codex', 'stopping', session.seq);
    db.prepare(`UPDATE sessions SET outcome = 'stopping', stop_intent = 'terminate' WHERE room_id = ? AND seq = ?`)
      .run(room.id, session.seq);

    onSessionEnded(
      db,
      exitEvent(room.id, session.seq, 'codex', { exitCode: null, signal: 'SIGTERM', exitCause: 'managed-stop' }),
      vi.fn(),
      createStuckCounter(), createFailureCounter(),
    );

    expect(getSession(db, room.id, session.seq)!.outcome).toBe('terminated');
    const events = listSessionEvents(db, room.id, session.seq).map((e) => e.kind);
    expect(events).toContain('process_exited');
    expect(events).toContain('terminated');
    const placeholder = getMessagesBySession(db, room.id, session.seq).find((m) => m.content.includes('人工终止'));
    expect(placeholder?.authorId).toBe('codex');
  });

  it('auto-disables an agent after 3 consecutive errors', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    setRoomStatus(db, room.id, 'paused_manual'); // 避免结算后立刻再派发
    const failureCounter = createFailureCounter();

    for (let i = 0; i < 3; i += 1) {
      const session = createSession(db, room.id, 'codex');
      setAgentState(db, room.id, 'codex', 'running', session.seq);
      onSessionEnded(
        db, exitEvent(room.id, session.seq, 'codex', { exitCause: 'unexpected' }),
        vi.fn(), createStuckCounter(), failureCounter,
      );
    }

    expect(getRoomAgents(db, room.id).find((a) => a.agentId === 'codex')!.dispatchEnabled).toBe(false);
    expect(failureCounter.get(room.id, 'codex')).toBe(0);
  });

  it('resets the failure count on a non-error outcome', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    setRoomStatus(db, room.id, 'paused_manual');
    const failureCounter = createFailureCounter();

    const failed = createSession(db, room.id, 'codex');
    setAgentState(db, room.id, 'codex', 'running', failed.seq);
    onSessionEnded(
      db, exitEvent(room.id, failed.seq, 'codex', { exitCause: 'unexpected' }),
      vi.fn(), createStuckCounter(), failureCounter,
    );
    expect(failureCounter.get(room.id, 'codex')).toBe(1);

    const ok = createSession(db, room.id, 'codex');
    setAgentState(db, room.id, 'codex', 'running', ok.seq);
    onSessionEnded(db, exitEvent(room.id, ok.seq, 'codex'), vi.fn(), createStuckCounter(), failureCounter);

    expect(failureCounter.get(room.id, 'codex')).toBe(0);
    expect(getRoomAgents(db, room.id).find((a) => a.agentId === 'codex')!.dispatchEnabled).toBe(true);
  });

  it('is idempotent when the session has already finished', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    onSessionEnded(db, exitEvent(room.id, session.seq, 'codex'), vi.fn(), createStuckCounter(), createFailureCounter());

    onSessionEnded(db, exitEvent(room.id, session.seq, 'codex', { exitCause: 'unexpected' }), vi.fn(), createStuckCounter(), createFailureCounter());

    expect(getSession(db, room.id, session.seq)!.outcome).toBe('passed'); // unchanged from first call
  });

  it('triggers a dispatch check after the state transition', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex', 'claude'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'goal' });
    const startSession = vi.fn();

    onSessionEnded(db, exitEvent(room.id, session.seq, 'codex'), startSession, createStuckCounter(), createFailureCounter());

    expect(startSession).toHaveBeenCalled();
  });
});

describe('terminateAgentSession', () => {
  function stopConfirmed(roomId: number, seq: number, agentId: string) {
    return vi.fn().mockResolvedValue({
      confirmed: true,
      exit: exitEvent(roomId, seq, agentId, { exitCode: null, signal: 'SIGTERM', exitCause: 'managed-stop' }),
    });
  }

  it('marks the session terminated, completes active exploring, and frees the agent', async () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['claude', 'codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    setAgentState(db, room.id, 'codex', 'running', session.seq);
    insertMessage(db, { roomId: room.id, sessionSeq: session.seq, authorId: 'codex', content: 'exploring X', type: 'exploring' });
    const stopSessionProcess = stopConfirmed(room.id, session.seq, 'codex');
    const startSession = vi.fn();

    const memoryUpdateListener = vi.fn();
    roomEvents.once('memoryUpdate', memoryUpdateListener);

    await terminateAgentSession(db, room.id, session.seq, stopSessionProcess, startSession, createStuckCounter(), createFailureCounter());

    expect(stopSessionProcess).toHaveBeenCalledWith(room.id, session.seq);
    expect(getSession(db, room.id, session.seq)!.outcome).toBe('terminated');
    expect(getActiveExploring(db, room.id)).toEqual([]);
    expect(memoryUpdateListener).toHaveBeenCalledTimes(1);
    // codex settles idle; no triggering message exists, so nobody is dispatched.
    expect(getRoomAgents(db, room.id).find((a) => a.agentId === 'codex')).toMatchObject({ state: 'idle' });
    // outcome != completed 补写占位消息，即使这次 session 已经有过实质消息（见需求 3.5）。
    const placeholder = getMessagesBySession(db, room.id, session.seq).find((m) => m.content.includes('人工终止'));
    expect(placeholder?.authorId).toBe('codex');
  });

  it('keeps stopping and throws when cleanup cannot be confirmed', async () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    setAgentState(db, room.id, 'codex', 'running', session.seq);
    const stopSessionProcess = vi.fn().mockResolvedValue({ confirmed: false, error: 'still running', rawLogPath: '/logs/x' });

    await expect(
      terminateAgentSession(db, room.id, session.seq, stopSessionProcess, vi.fn(), createStuckCounter(), createFailureCounter()),
    ).rejects.toThrow(/still running/);

    expect(getSession(db, room.id, session.seq)!.outcome).toBe('stopping');
    expect(getRoomAgents(db, room.id).find((a) => a.agentId === 'codex')).toMatchObject({ state: 'stopping' });
  });

  it('is idempotent when the session has already finished', async () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    const stopSessionProcess = stopConfirmed(room.id, session.seq, 'codex');
    await terminateAgentSession(db, room.id, session.seq, stopSessionProcess, vi.fn(), createStuckCounter(), createFailureCounter());

    stopSessionProcess.mockClear();
    await terminateAgentSession(db, room.id, session.seq, stopSessionProcess, vi.fn(), createStuckCounter(), createFailureCounter());

    expect(stopSessionProcess).not.toHaveBeenCalled();
  });

  it('triggers a dispatch check after cleanup', async () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex', 'claude'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'goal' });
    const startSession = vi.fn();

    await terminateAgentSession(
      db, room.id, session.seq, stopConfirmed(room.id, session.seq, 'codex'), startSession, createStuckCounter(), createFailureCounter(),
    );

    expect(startSession).toHaveBeenCalled();
  });
});

describe('setAgentEnabled', () => {
  it('re-enables an agent, clears its failure count, and triggers dispatch', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'goal' });
    setAgentEnabled(db, room.id, 'codex', false, vi.fn(), createStuckCounter(), createFailureCounter());
    const failureCounter = createFailureCounter();
    failureCounter.increment(room.id, 'codex');
    const startSession = vi.fn();

    setAgentEnabled(db, room.id, 'codex', true, startSession, createStuckCounter(), failureCounter);

    expect(getRoomAgents(db, room.id).find((a) => a.agentId === 'codex')!.dispatchEnabled).toBe(true);
    expect(failureCounter.get(room.id, 'codex')).toBe(0);
    expect(startSession).toHaveBeenCalledWith({ roomId: room.id, seq: 1, agentId: 'codex', registryKey: 'codex' });
  });

  it('throws for an unknown agent', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    expect(() =>
      setAgentEnabled(db, room.id, 'ghost', true, vi.fn(), createStuckCounter(), createFailureCounter()),
    ).toThrow(/not found/);
  });
});
