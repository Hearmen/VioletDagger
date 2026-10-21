import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTestDb } from '../../src/storage/db';
import {
  createRoom, getRoom, getRoomAgents, setRoomStatus, setAgentEnabled, setDispatchPending,
} from '../../src/storage/rooms';
import { listSessions, getSession } from '../../src/storage/sessions';
import { insertMessage, setQuestionStatus } from '../../src/storage/messages';
import { createStuckCounter } from '../../src/orchestrator-core/stuckCounter';
import { createFailureCounter } from '../../src/orchestrator-core/failureCounter';
import { checkAndDispatch, isDispatchIdle, getNextTurnAgent } from '../../src/orchestrator-core/dispatch';
import { submitMessage } from '../../src/orchestrator-core/submitMessage';
import { onSessionEnded } from '../../src/orchestrator-core/sessionLifecycle';
import { roomEvents } from '../../src/events';

afterEach(() => {
  roomEvents.removeAllListeners('roomStatus');
  roomEvents.removeAllListeners('message');
  roomEvents.removeAllListeners('memoryUpdate');
});

// sequential 房间（需求 3.3.3，03-orchestrator-core.md §1.7）。
function setup(agents: string[], options: { maxSessions?: number } = {}) {
  const db = createTestDb();
  const room = createRoom(db, 'seq', agents, 'sequential', options);
  const startSession = vi.fn();
  const stuckCounter = createStuckCounter();
  const failureCounter = createFailureCounter();
  const check = () => checkAndDispatch(db, room.id, startSession, stuckCounter);
  const human = (content: string, extra: { type?: 'open_question' | 'hypothesis'; targetMessageId?: number; targetAgentId?: string } = {}) =>
    submitMessage(db, { roomId: room.id, author: { kind: 'human' }, content, type: 'open_question', ...extra }, startSession, stuckCounter).message;
  const running = () => getRoomAgents(db, room.id).filter((a) => a.state !== 'idle');
  const current = () => {
    const busy = running();
    expect(busy).toHaveLength(1);
    return { agentId: busy[0].agentId, seq: busy[0].currentSessionSeq! };
  };
  // 结束当前唯一运行中的 session：completed 写一条不触发派发的 fact；passed 什么都不写；error 异常退出。
  const end = (result: 'completed' | 'passed' | 'error') => {
    const { agentId, seq } = current();
    if (result === 'completed') {
      insertMessage(db, { roomId: room.id, sessionSeq: seq, authorId: agentId, content: 'a fact', type: 'fact' });
    }
    onSessionEnded(db, {
      roomId: room.id, seq, agentId, exitCode: result === 'error' ? 1 : 0, signal: null,
      exitCause: result === 'error' ? 'unexpected' : 'natural', rawLogPath: '',
    }, startSession, stuckCounter, failureCounter);
    return { agentId, seq };
  };
  const dispatchedAgents = () => startSession.mock.calls.map((call) => call[0].agentId);
  return { db, room, startSession, check, human, running, current, end, dispatchedAgents };
}

describe('sequential room — turns', () => {
  it('starts the first agent in join order on the goal, as a turn session, and clears the room flag', () => {
    const { db, room, human, current } = setup(['codex', 'claude']);
    human('goal');

    expect(current().agentId).toBe('codex');
    expect(getSession(db, room.id, 1)).toMatchObject({ dispatchScope: 'broadcast', dispatchTrigger: 'turn' });
    expect(getRoom(db, room.id)!.dispatchPending).toBe(false);
  });

  it('runs at most one session at a time: trigger messages while busy only set the flag', () => {
    const { db, room, human, running, startSession } = setup(['codex', 'claude', 'kimi']);
    const goal = human('goal');
    human('another question');
    human('a hypothesis', { type: 'hypothesis', targetMessageId: goal.id });

    expect(running()).toHaveLength(1);
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(getRoom(db, room.id)!.dispatchPending).toBe(true);
  });

  it('rotates in join order and wraps around, whatever the outcome of each turn', () => {
    const { human, end, dispatchedAgents } = setup(['codex', 'claude', 'kimi']);
    human('goal');
    end('completed');
    end('error');
    end('completed');
    end('completed');

    expect(dispatchedAgents()).toEqual(['codex', 'claude', 'kimi', 'codex', 'claude']);
  });

  it('skips agents whose dispatch is disabled', () => {
    const { db, room, human, end, dispatchedAgents } = setup(['codex', 'claude', 'kimi']);
    setAgentEnabled(db, room.id, 'claude', false);
    human('goal');
    end('completed');
    end('completed');

    expect(dispatchedAgents()).toEqual(['codex', 'kimi', 'codex']);
  });

  it('does not restore any flag when a turn errors, and moves on to the next agent', () => {
    const { db, room, human, end, current } = setup(['codex', 'claude']);
    human('goal');
    end('error');

    expect(getRoom(db, room.id)!.dispatchPending).toBe(false);
    expect(current().agentId).toBe('claude');
  });

  it('stops after a full round of passes (converged) and a human trigger message restarts from the next agent', () => {
    const { db, room, human, end, running, dispatchedAgents } = setup(['codex', 'claude']);
    human('goal');
    end('completed'); // codex
    end('passed');    // claude
    end('passed');    // codex → converged

    expect(running()).toHaveLength(0);
    expect(isDispatchIdle(db, room.id)).toBe(true);

    human('new question');
    expect(dispatchedAgents()).toEqual(['codex', 'claude', 'codex', 'claude']);
  });

  it('stops when no question is OPEN and the flag is false, but keeps going while the flag is set', () => {
    const { db, room, human, end, running, current } = setup(['codex', 'claude']);
    const goal = human('goal');
    const first = current();
    setQuestionStatus(db, room.id, goal.id, { status: 'CLOSED', closeReason: 'RESOLVED', closedBy: goal.id }, goal.id);
    // 运行中的 agent 写了一条触发型消息：轮次继续。
    submitMessage(db, {
      roomId: room.id, author: { kind: 'agent', agentId: first.agentId, sessionSeq: first.seq },
      content: 'q2', type: 'open_question',
    }, vi.fn(), createStuckCounter());
    end('completed');
    const second = current();
    expect(second.agentId).toBe('claude');

    // 所有问题都关闭、标记为 false：轮次停止。
    setQuestionStatus(db, room.id, goal.id + 1, { status: 'CLOSED', closeReason: 'RESOLVED', closedBy: goal.id + 1 }, goal.id + 1);
    end('completed');
    expect(running()).toHaveLength(0);
  });

  it('pauses at paused_limit instead of starting a turn, keeping the flag', () => {
    const { db, room, human, end, running } = setup(['codex', 'claude'], { maxSessions: 1 });
    human('goal');
    human('q2');
    end('completed');

    expect(running()).toHaveLength(0);
    expect(getRoom(db, room.id)).toMatchObject({ status: 'paused_limit', dispatchPending: true });
  });

  it('does not dispatch while the room is paused, and continues with the next agent on resume', () => {
    const { db, room, human, end, check, current, running } = setup(['codex', 'claude']);
    human('goal');
    setRoomStatus(db, room.id, 'paused_manual');
    end('completed');
    expect(running()).toHaveLength(0);

    setRoomStatus(db, room.id, 'active');
    check();
    expect(current().agentId).toBe('claude');
  });

  it('keeps rotating on repeated errors without restoring the room flag', () => {
    const { db, room, human, end } = setup(['codex', 'claude']);
    human('goal');
    end('error');
    end('error');
    end('error');
    expect(getRoom(db, room.id)!.dispatchPending).toBe(false);
    expect(listSessions(db, room.id).map((s) => s.dispatchTrigger)).toEqual(['turn', 'turn', 'turn', 'turn']);
  });
});

describe('sequential room — directed messages', () => {
  it('runs the targeted agent next, then resumes the rotation where it left off', () => {
    const { db, room, human, end, dispatchedAgents } = setup(['codex', 'claude', 'kimi']);
    human('goal');
    human('please look', { targetAgentId: 'kimi' }); // codex 正在运行
    end('completed'); // codex 结束 → kimi 定向
    expect(getSession(db, room.id, 2)).toMatchObject({ agentId: 'kimi', dispatchScope: 'directed', dispatchTrigger: 'directed_flag' });
    end('completed'); // kimi 结束 → 轮到 claude（codex 之后）

    expect(dispatchedAgents()).toEqual(['codex', 'kimi', 'claude']);
  });

  it('dispatches a directed message immediately when nothing is running', () => {
    const { human, end, running, dispatchedAgents } = setup(['codex', 'claude']);
    human('goal');
    end('completed');
    end('passed');
    end('passed'); // 收敛，停止
    expect(running()).toHaveLength(0);

    human('only you', { targetAgentId: 'claude' });
    expect(dispatchedAgents()[dispatchedAgents().length - 1]).toBe('claude');
  });

  it('does not count directed sessions toward convergence', () => {
    const { human, end, running } = setup(['codex', 'claude']);
    human('goal');
    end('completed');                          // codex（turn）
    human('check', { targetAgentId: 'codex' }); // claude 运行中
    end('passed');                             // claude（turn）
    end('passed');                             // codex（directed）—— 不计入
    // 只有一个连续 passed 的轮次 session，未收敛：继续轮到 codex。
    expect(running()).toHaveLength(1);
    end('passed');                             // codex（turn）→ 两个连续 passed，收敛
    expect(running()).toHaveLength(0);
  });

  it('does not restore the directed flag when a directed session errors', () => {
    const { db, room, human, end } = setup(['codex', 'claude']);
    human('goal');
    human('check', { targetAgentId: 'claude' });
    end('completed'); // codex → claude directed
    end('error');     // claude directed errors
    expect(getRoomAgents(db, room.id).find((a) => a.agentId === 'claude')!.directedPending).toBe(false);
  });

  it('pushes roomStatus when a directed flag is set while another agent runs', () => {
    const { human } = setup(['codex', 'claude']);
    human('goal');
    const listener = vi.fn();
    roomEvents.on('roomStatus', listener);
    human('check', { targetAgentId: 'claude' });
    expect(listener).toHaveBeenCalled();
  });
});

describe('getNextTurnAgent', () => {
  it('is null for parallel rooms', () => {
    const db = createTestDb();
    const room = createRoom(db, 'p', ['codex', 'claude'], 'parallel');
    expect(getNextTurnAgent(db, room.id)).toBeNull();
  });

  it('returns the next agent in rotation, or a pending directed agent first', () => {
    const { db, room, human } = setup(['codex', 'claude', 'kimi']);
    expect(getNextTurnAgent(db, room.id)).toBe('codex');
    human('goal'); // codex 运行中
    expect(getNextTurnAgent(db, room.id)).toBe('claude');
    human('check', { targetAgentId: 'kimi' });
    expect(getNextTurnAgent(db, room.id)).toBe('kimi');
  });

  it('is idle-aware through isDispatchIdle: a stopped room with the flag set is not idle', () => {
    const { db, room, human, end } = setup(['codex']);
    human('goal');
    end('passed'); // 单 agent，一次 passed 即收敛
    expect(isDispatchIdle(db, room.id)).toBe(true);
    setDispatchPending(db, room.id, true, 'human');
    expect(isDispatchIdle(db, room.id)).toBe(false);
  });
});
