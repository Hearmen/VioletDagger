import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTestDb } from '../../src/storage/db';
import { createRoom, getRoom, getRoomAgents, setRoomStatus, setAgentState, setAgentEnabled } from '../../src/storage/rooms';
import { createSession } from '../../src/storage/sessions';
import { insertMessage } from '../../src/storage/messages';
import { createStuckCounter } from '../../src/orchestrator-core/stuckCounter';
import { checkAndDispatch, onSubstantiveMessagePosted } from '../../src/orchestrator-core/dispatch';
import { roomEvents } from '../../src/events';

afterEach(() => {
  roomEvents.removeAllListeners('roomStatus');
});

describe('checkAndDispatch', () => {
  it('dispatches to the first idle agent in join order', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex', 'claude'], 'sequential');
    const startSession = vi.fn();
    const stuckCounter = createStuckCounter();

    checkAndDispatch(db, room.id, startSession, stuckCounter);

    expect(startSession).toHaveBeenCalledWith({ roomId: room.id, seq: 1, agentId: 'codex', registryKey: 'codex' });
    const agents = getRoomAgents(db, room.id);
    expect(agents.find((a) => a.agentId === 'codex')).toMatchObject({ state: 'running', currentSessionSeq: 1 });
  });

  it('does nothing when no agent is idle', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    setAgentState(db, room.id, 'codex', 'running', 1);
    const startSession = vi.fn();

    checkAndDispatch(db, room.id, startSession, createStuckCounter());

    expect(startSession).not.toHaveBeenCalled();
  });

  it('skips agents whose dispatch is disabled and picks the next idle one', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex', 'claude'], 'sequential');
    setAgentEnabled(db, room.id, 'codex', false);
    const startSession = vi.fn();

    checkAndDispatch(db, room.id, startSession, createStuckCounter());

    expect(startSession).toHaveBeenCalledWith({ roomId: room.id, seq: 1, agentId: 'claude', registryKey: 'claude' });
  });

  it('does nothing when every agent is disabled', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex', 'claude'], 'sequential');
    setAgentEnabled(db, room.id, 'codex', false);
    setAgentEnabled(db, room.id, 'claude', false);
    const startSession = vi.fn();

    checkAndDispatch(db, room.id, startSession, createStuckCounter());

    expect(startSession).not.toHaveBeenCalled();
  });

  it('does nothing when the room is not active', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    setRoomStatus(db, room.id, 'paused_manual');
    const startSession = vi.fn();

    checkAndDispatch(db, room.id, startSession, createStuckCounter());

    expect(startSession).not.toHaveBeenCalled();
  });

  it('pauses the room at paused_limit once session count reaches maxSessions, without dispatching', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    for (let i = 0; i < room.maxSessions; i++) {
      createSession(db, room.id, 'codex');
    }
    const startSession = vi.fn();
    const roomStatusListener = vi.fn();
    roomEvents.once('roomStatus', roomStatusListener);

    checkAndDispatch(db, room.id, startSession, createStuckCounter());

    expect(startSession).not.toHaveBeenCalled();
    expect(getRoom(db, room.id)!.status).toBe('paused_limit');
    expect(roomStatusListener).toHaveBeenCalledWith({ roomId: room.id });
  });

  it('increments stuckCount for running agents with active exploring, scanned before the idle target', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex', 'claude', 'kimi'], 'sequential');
    const s1 = createSession(db, room.id, 'codex');
    setAgentState(db, room.id, 'codex', 'running', s1.seq);
    insertMessage(db, { roomId: room.id, sessionSeq: s1.seq, authorId: 'codex', content: 'exploring X', type: 'exploring' });
    // claude is running but has no active exploring -> not counted
    const s2 = createSession(db, room.id, 'claude');
    setAgentState(db, room.id, 'claude', 'running', s2.seq);
    // kimi is idle -> dispatch target, scan stops here

    const stuckCounter = createStuckCounter();
    checkAndDispatch(db, room.id, vi.fn(), stuckCounter);

    expect(stuckCounter.get(room.id, 'codex')).toBe(1);
    expect(stuckCounter.get(room.id, 'claude')).toBe(0);
  });

  it('does not propagate a synchronous throw from startSession (keeps the server alive)', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const startSession = vi.fn(() => {
      throw new Error('boom');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => checkAndDispatch(db, room.id, startSession, createStuckCounter())).not.toThrow();
    // 状态迁移发生在 startSession 之前，agent 仍被标记为 running
    expect(getRoomAgents(db, room.id).find((a) => a.agentId === 'codex')).toMatchObject({ state: 'running' });
    errorSpy.mockRestore();
  });

  it('does not scan agents after the chosen idle target', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex', 'claude', 'kimi'], 'sequential');
    // codex is idle -> dispatch target, scan stops before claude/kimi
    const s2 = createSession(db, room.id, 'claude');
    setAgentState(db, room.id, 'claude', 'running', s2.seq);
    insertMessage(db, { roomId: room.id, sessionSeq: s2.seq, authorId: 'claude', content: 'exploring Y', type: 'exploring' });

    const stuckCounter = createStuckCounter();
    checkAndDispatch(db, room.id, vi.fn(), stuckCounter);

    expect(stuckCounter.get(room.id, 'claude')).toBe(0);
  });
});

describe('onSubstantiveMessagePosted', () => {
  it('triggers a dispatch check', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const startSession = vi.fn();

    onSubstantiveMessagePosted(db, room.id, startSession, createStuckCounter());

    expect(startSession).toHaveBeenCalledWith({ roomId: room.id, seq: 1, agentId: 'codex', registryKey: 'codex' });
  });
});
