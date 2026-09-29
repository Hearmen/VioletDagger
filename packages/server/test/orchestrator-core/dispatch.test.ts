import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTestDb } from '../../src/storage/db';
import {
  createRoom, getRoom, getRoomAgents, setRoomStatus, setAgentState, setAgentEnabled,
  setDispatchPending, setDirectedPending,
} from '../../src/storage/rooms';
import { createSession, getSession, finishSession, countSessions } from '../../src/storage/sessions';
import { insertMessage, setQuestionStatus } from '../../src/storage/messages';
import { createStuckCounter } from '../../src/orchestrator-core/stuckCounter';
import { checkAndDispatch, isDispatchIdle } from '../../src/orchestrator-core/dispatch';
import { roomEvents } from '../../src/events';

afterEach(() => {
  roomEvents.removeAllListeners('roomStatus');
});

function setup(agents: string[]) {
  const db = createTestDb();
  const room = createRoom(db, 'a', agents, 'sequential');
  const startSession = vi.fn();
  const stuckCounter = createStuckCounter();
  const check = () => checkAndDispatch(db, room.id, startSession, stuckCounter);
  const busy = (agentId: string) => {
    const session = createSession(db, room.id, agentId);
    setAgentState(db, room.id, agentId, 'running', session.seq);
    return session.seq;
  };
  const agent = (agentId: string) => getRoomAgents(db, room.id).find((a) => a.agentId === agentId)!;
  return { db, room, startSession, stuckCounter, check, busy, agent };
}

describe('checkAndDispatch — room flag (03-orchestrator-core.md §1.2)', () => {
  it('does nothing and pushes nothing while every flag is false', () => {
    const { check, startSession } = setup(['codex', 'claude']);
    const listener = vi.fn();
    roomEvents.on('roomStatus', listener);

    check();

    expect(startSession).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it('dispatches the first idle agent in join order, as a broadcast session, and clears the flag', () => {
    const { db, room, check, startSession, agent } = setup(['codex', 'claude']);
    setDispatchPending(db, room.id, true, 'human');

    check();

    expect(startSession).toHaveBeenCalledTimes(1);
    expect(startSession).toHaveBeenCalledWith({ roomId: room.id, seq: 1, agentId: 'codex', registryKey: 'codex' });
    expect(agent('codex')).toMatchObject({ state: 'running', currentSessionSeq: 1 });
    expect(getSession(db, room.id, 1)!.dispatchScope).toBe('broadcast');
    expect(getRoom(db, room.id)).toMatchObject({ dispatchPending: false, pendingAuthorId: null });
  });

  it('dispatches at most one broadcast session per check', () => {
    const { db, room, check, startSession } = setup(['codex', 'claude', 'kimi']);
    setDispatchPending(db, room.id, true, 'human');

    check();
    check();

    expect(startSession).toHaveBeenCalledTimes(1);
  });

  it('skips the flag author and picks the next idle agent', () => {
    const { db, room, check, startSession } = setup(['codex', 'claude']);
    setDispatchPending(db, room.id, true, 'codex');

    check();

    expect(startSession).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'claude' }));
  });

  it('falls back to the flag author when no other agent is idle', () => {
    const { db, room, check, startSession, busy } = setup(['codex', 'claude']);
    busy('claude');
    setDispatchPending(db, room.id, true, 'codex');

    check();

    expect(startSession).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'codex' }));
    expect(getRoom(db, room.id)!.dispatchPending).toBe(false);
  });

  it('keeps the flag while every agent is busy and dispatches once one becomes idle', () => {
    const { db, room, check, startSession, busy } = setup(['codex', 'claude']);
    busy('codex');
    busy('claude');
    setDispatchPending(db, room.id, true, 'human');

    check();
    expect(startSession).not.toHaveBeenCalled();
    expect(getRoom(db, room.id)!.dispatchPending).toBe(true);

    setAgentState(db, room.id, 'claude', 'idle');
    check();
    expect(startSession).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'claude' }));
    expect(getRoom(db, room.id)!.dispatchPending).toBe(false);
  });

  it('skips agents whose dispatch is disabled, and keeps the flag when every agent is disabled', () => {
    const { db, room, check, startSession } = setup(['codex', 'claude']);
    setAgentEnabled(db, room.id, 'codex', false);
    setDispatchPending(db, room.id, true, 'human');
    check();
    expect(startSession).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'claude' }));

    const other = setup(['codex']);
    setAgentEnabled(other.db, other.room.id, 'codex', false);
    setDispatchPending(other.db, other.room.id, true, 'human');
    other.check();
    expect(other.startSession).not.toHaveBeenCalled();
    expect(getRoom(other.db, other.room.id)!.dispatchPending).toBe(true);
  });

  it('does nothing when the room is not active', () => {
    const { db, room, check, startSession } = setup(['codex']);
    setDispatchPending(db, room.id, true, 'human');
    setRoomStatus(db, room.id, 'paused_manual');

    check();

    expect(startSession).not.toHaveBeenCalled();
    expect(getRoom(db, room.id)!.dispatchPending).toBe(true);
  });

  it('pauses at paused_limit instead of dispatching, keeping the flag', () => {
    const { db, room, check, startSession } = setup(['codex']);
    for (let i = 0; i < room.maxSessions; i++) createSession(db, room.id, 'codex');
    setDispatchPending(db, room.id, true, 'human');
    const listener = vi.fn();
    roomEvents.on('roomStatus', listener);

    check();

    expect(startSession).not.toHaveBeenCalled();
    expect(getRoom(db, room.id)).toMatchObject({ status: 'paused_limit', dispatchPending: true });
    expect(listener).toHaveBeenCalledWith({ roomId: room.id });
  });

  it('does not pause at the session limit when there is nothing to dispatch', () => {
    const { db, room, check } = setup(['codex']);
    for (let i = 0; i < room.maxSessions; i++) createSession(db, room.id, 'codex');

    check();

    expect(getRoom(db, room.id)!.status).toBe('active');
  });

  it('counts stuck agents passed before the target, only when the room flag is set', () => {
    const { db, room, check, stuckCounter, busy } = setup(['codex', 'claude', 'kimi', 'opencode']);
    const s1 = busy('codex');
    insertMessage(db, { roomId: room.id, sessionSeq: s1, authorId: 'codex', content: 'exploring X', type: 'exploring' });
    busy('claude'); // running without active exploring -> not counted
    const s4 = busy('opencode');
    insertMessage(db, { roomId: room.id, sessionSeq: s4, authorId: 'opencode', content: 'exploring Y', type: 'exploring' });

    check(); // flag false -> no scan
    expect(stuckCounter.get(room.id, 'codex')).toBe(0);

    setDispatchPending(db, room.id, true, 'human');
    check(); // kimi is the target; scan stops before opencode
    expect(stuckCounter.get(room.id, 'codex')).toBe(1);
    expect(stuckCounter.get(room.id, 'claude')).toBe(0);
    expect(stuckCounter.get(room.id, 'opencode')).toBe(0);
  });

  it('does not propagate a synchronous throw from startSession (keeps the server alive)', () => {
    const { db, room, agent } = setup(['codex']);
    setDispatchPending(db, room.id, true, 'human');
    const startSession = vi.fn(() => {
      throw new Error('boom');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => checkAndDispatch(db, room.id, startSession, createStuckCounter())).not.toThrow();
    // 状态迁移发生在 startSession 之前，agent 仍被标记为 running
    expect(agent('codex')).toMatchObject({ state: 'running' });
    errorSpy.mockRestore();
  });
});

describe('checkAndDispatch — directed flag (需求 3.3.2)', () => {
  it('dispatches the targeted agent as a directed session with the same agent-facing params, and clears its flag', () => {
    const { db, room, check, startSession, agent } = setup(['codex', 'claude']);
    setDirectedPending(db, room.id, 'claude', true);

    check();

    expect(startSession).toHaveBeenCalledTimes(1);
    expect(startSession).toHaveBeenCalledWith({ roomId: room.id, seq: 1, agentId: 'claude', registryKey: 'claude' });
    expect(getSession(db, room.id, 1)!.dispatchScope).toBe('directed');
    expect(agent('claude').directedPending).toBe(false);
  });

  it('keeps the directed flag while the targeted agent is busy', () => {
    const { db, room, check, startSession, busy, agent } = setup(['claude']);
    busy('claude');
    setDirectedPending(db, room.id, 'claude', true);

    check();

    expect(startSession).not.toHaveBeenCalled();
    expect(agent('claude').directedPending).toBe(true);
  });

  it('keeps the directed flag of a disabled agent until it is re-enabled', () => {
    const { db, room, check, startSession, agent } = setup(['claude']);
    setAgentEnabled(db, room.id, 'claude', false);
    setDirectedPending(db, room.id, 'claude', true);

    check();
    expect(startSession).not.toHaveBeenCalled();
    expect(agent('claude').directedPending).toBe(true);

    setAgentEnabled(db, room.id, 'claude', true);
    check();
    expect(startSession).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'claude' }));
  });

  it('handles directed flags first, then gives the room flag to another idle agent', () => {
    const { db, room, check, startSession } = setup(['claude', 'codex']);
    setDirectedPending(db, room.id, 'claude', true);
    setDispatchPending(db, room.id, true, 'human');

    check();

    expect(startSession.mock.calls.map((call) => call[0].agentId)).toEqual(['claude', 'codex']);
    expect(getSession(db, room.id, 1)!.dispatchScope).toBe('directed');
    expect(getSession(db, room.id, 2)!.dispatchScope).toBe('broadcast');
    expect(getRoom(db, room.id)!.dispatchPending).toBe(false);
  });

  it('never gives the room flag to the agent that just took its directed flag', () => {
    const { db, room, check, startSession } = setup(['claude']);
    setDirectedPending(db, room.id, 'claude', true);
    setDispatchPending(db, room.id, true, 'human');

    check();

    expect(startSession).toHaveBeenCalledTimes(1);
    expect(getSession(db, room.id, 1)!.dispatchScope).toBe('directed');
    expect(getRoom(db, room.id)!.dispatchPending).toBe(true);
  });
});

describe('checkAndDispatch — continuation without flags (03-orchestrator-core.md §1.2)', () => {
  function withOpenGoal(agents: string[]) {
    const ctx = setup(agents);
    const goal = insertMessage(ctx.db, { roomId: ctx.room.id, sessionSeq: null, authorId: 'human', content: 'goal', type: 'open_question' });
    // 结束一个 session：agent 回到 idle，按给定 outcome 结算。
    const ended = (agentId: string, outcome: 'completed' | 'passed' | 'error' = 'completed') => {
      const seq = ctx.busy(agentId);
      finishSession(ctx.db, ctx.room.id, seq, outcome);
      setAgentState(ctx.db, ctx.room.id, agentId, 'idle');
      return seq;
    };
    return { ...ctx, goal, ended };
  }

  it('rotates to the agent after the last session in join order, without touching the room flag', () => {
    const { db, room, check, startSession, ended } = withOpenGoal(['claude', 'codex', 'kimi-1', 'kimi-2']);
    ended('claude');
    ended('kimi-1');
    const listener = vi.fn();
    roomEvents.on('roomStatus', listener);

    check();

    expect(startSession).toHaveBeenCalledTimes(1);
    expect(startSession).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'kimi-2', seq: 3 }));
    expect(getSession(db, room.id, 3)!.dispatchScope).toBe('broadcast');
    expect(getRoom(db, room.id)).toMatchObject({ dispatchPending: false, pendingAuthorId: null });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('wraps around join order and skips disabled agents', () => {
    const { db, room, check, startSession, ended } = withOpenGoal(['claude', 'codex', 'kimi']);
    setAgentEnabled(db, room.id, 'claude', false);
    ended('kimi');

    check();

    expect(startSession).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'codex' }));
  });

  it('starts from the first agent when the room has no session yet', () => {
    const { check, startSession } = withOpenGoal(['codex', 'claude']);
    check();
    expect(startSession).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'codex', seq: 1 }));
  });

  it('does not continue while any agent is running', () => {
    const { check, startSession, busy } = withOpenGoal(['codex', 'claude']);
    busy('codex');
    check();
    expect(startSession).not.toHaveBeenCalled();
  });

  it('does not continue when every open_question is closed', () => {
    const { db, room, check, startSession, goal, ended } = withOpenGoal(['codex', 'claude']);
    ended('codex');
    setQuestionStatus(db, room.id, goal.id, { status: 'CLOSED', closeReason: 'RESOLVED', closedBy: goal.id }, goal.id);
    const listener = vi.fn();
    roomEvents.on('roomStatus', listener);

    check();

    expect(startSession).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps continuing while trailing passed sessions are fewer than the enabled agents', () => {
    const { check, startSession, ended } = withOpenGoal(['codex', 'claude']);
    ended('codex', 'completed');
    ended('claude', 'passed');
    check();
    expect(startSession).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'codex' }));
  });

  it('stops once every enabled agent passed in a row, and resumes after new output', () => {
    const { check, startSession, ended } = withOpenGoal(['codex', 'claude']);
    ended('codex', 'passed');
    ended('claude', 'passed');
    check();
    expect(startSession).not.toHaveBeenCalled();

    ended('codex', 'completed');
    check();
    expect(startSession).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'claude' }));
  });

  it('pauses the room at the session limit instead of continuing', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex', 'claude'], 'sequential', { maxSessions: 1 });
    insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'goal', type: 'open_question' });
    const seq = createSession(db, room.id, 'codex').seq;
    finishSession(db, room.id, seq, 'completed');
    const startSession = vi.fn();

    checkAndDispatch(db, room.id, startSession, createStuckCounter());

    expect(startSession).not.toHaveBeenCalled();
    expect(getRoom(db, room.id)!.status).toBe('paused_limit');
    expect(countSessions(db, room.id)).toBe(1);
  });
});

describe('isDispatchIdle (03-orchestrator-core.md §1.6)', () => {
  it('is false for an empty room and while the room flag can still be taken', () => {
    const { db, room } = setup(['codex', 'claude']);
    expect(isDispatchIdle(db, room.id)).toBe(false);
    insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'chat' });
    setDispatchPending(db, room.id, true, 'human');
    expect(isDispatchIdle(db, room.id)).toBe(false);
    setDispatchPending(db, room.id, false);
    expect(isDispatchIdle(db, room.id)).toBe(true);
  });

  it('is false while continuation would still dispatch, true once the questions close or the room converges', () => {
    const { db, room } = setup(['codex', 'claude']);
    const goal = insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'goal', type: 'open_question' });
    expect(isDispatchIdle(db, room.id)).toBe(false);

    for (const agentId of ['codex', 'claude']) {
      const session = createSession(db, room.id, agentId);
      finishSession(db, room.id, session.seq, 'passed');
    }
    expect(isDispatchIdle(db, room.id)).toBe(true);

    const session = createSession(db, room.id, 'codex');
    finishSession(db, room.id, session.seq, 'completed');
    expect(isDispatchIdle(db, room.id)).toBe(false);
    setQuestionStatus(db, room.id, goal.id, { status: 'CLOSED', closeReason: 'RESOLVED', closedBy: goal.id }, goal.id);
    expect(isDispatchIdle(db, room.id)).toBe(true);
  });

  it('is false while an agent is running or an enabled agent has a directed flag', () => {
    const { db, room } = setup(['codex', 'claude']);
    insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'chat' });
    setAgentState(db, room.id, 'codex', 'running', 1);
    expect(isDispatchIdle(db, room.id)).toBe(false);
    setAgentState(db, room.id, 'codex', 'idle');
    setDirectedPending(db, room.id, 'claude', true);
    expect(isDispatchIdle(db, room.id)).toBe(false);
    setAgentEnabled(db, room.id, 'claude', false);
    expect(isDispatchIdle(db, room.id)).toBe(true);
  });

  it('is true when the room flag is set but every agent is disabled', () => {
    const { db, room } = setup(['codex', 'claude']);
    insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'chat' });
    setDispatchPending(db, room.id, true, 'human');
    setAgentEnabled(db, room.id, 'codex', false);
    setAgentEnabled(db, room.id, 'claude', false);
    expect(isDispatchIdle(db, room.id)).toBe(true);
  });

  it('is false when the room is not active', () => {
    const { db, room } = setup(['codex']);
    insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'chat' });
    expect(isDispatchIdle(db, room.id)).toBe(true);
    setRoomStatus(db, room.id, 'paused_manual');
    expect(isDispatchIdle(db, room.id)).toBe(false);
  });
});
