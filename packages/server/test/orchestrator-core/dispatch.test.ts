import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createTestDb } from '../../src/storage/db';
import { createRoom, getRoom, getRoomAgents, setRoomStatus, setAgentState, setAgentEnabled } from '../../src/storage/rooms';
import { createSession, getSession } from '../../src/storage/sessions';
import { insertMessage } from '../../src/storage/messages';
import { createStuckCounter } from '../../src/orchestrator-core/stuckCounter';
import { checkAndDispatch, onSubstantiveMessagePosted, isDispatchOwed } from '../../src/orchestrator-core/dispatch';
import { roomEvents } from '../../src/events';

afterEach(() => {
  roomEvents.removeAllListeners('roomStatus');
});

describe('checkAndDispatch', () => {
  it('dispatches to the first idle agent in join order when a triggering message exists', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex', 'claude'], 'sequential');
    insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'goal' });
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
    insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'goal' });
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
    insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'goal' });
    const startSession = vi.fn(() => {
      throw new Error('boom');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => checkAndDispatch(db, room.id, startSession, createStuckCounter())).not.toThrow();
    // 状态迁移发生在 startSession 之前，agent 仍被标记为 running
    expect(getRoomAgents(db, room.id).find((a) => a.agentId === 'codex')).toMatchObject({ state: 'running' });
    errorSpy.mockRestore();
  });

  it('stops scanning at the first dispatchable idle agent', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex', 'claude', 'kimi'], 'sequential');
    insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'goal' });
    // codex is idle and owed -> dispatch target, scan stops before claude/kimi
    const s2 = createSession(db, room.id, 'claude');
    setAgentState(db, room.id, 'claude', 'running', s2.seq);
    insertMessage(db, { roomId: room.id, sessionSeq: s2.seq, authorId: 'claude', content: 'exploring Y', type: 'exploring' });

    const stuckCounter = createStuckCounter();
    checkAndDispatch(db, room.id, vi.fn(), stuckCounter);

    expect(stuckCounter.get(room.id, 'claude')).toBe(0);
  });

  it('does nothing when no dispatch-triggering message exists', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const startSession = vi.fn();

    checkAndDispatch(db, room.id, startSession, createStuckCounter());

    expect(startSession).not.toHaveBeenCalled();
  });

  it('does not re-dispatch an agent that has already run since the latest trigger', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'goal' });
    createSession(db, room.id, 'codex'); // started after the trigger -> already consumed it
    const startSession = vi.fn();

    checkAndDispatch(db, room.id, startSession, createStuckCounter());

    expect(startSession).not.toHaveBeenCalled();
  });

  it('does not let non-triggering typed messages wake an idle agent', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    insertMessage(db, { roomId: room.id, sessionSeq: 1, authorId: 'codex', content: 'exploring X', type: 'exploring' });
    insertMessage(db, { roomId: room.id, sessionSeq: 1, authorId: 'codex', content: 'done?', type: 'propose_completion' });
    const startSession = vi.fn();

    checkAndDispatch(db, room.id, startSession, createStuckCounter());

    expect(startSession).not.toHaveBeenCalled();
  });

  it('does not re-dispatch an agent because of its own triggering message', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'codex', content: 'a fact', type: 'fact' });
    const startSession = vi.fn();

    checkAndDispatch(db, room.id, startSession, createStuckCounter());

    expect(startSession).not.toHaveBeenCalled();
  });

  it('dispatches a different agent woken by a challenge', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex', 'claude'], 'sequential');
    const fact = insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'a fact', type: 'fact' }).message;
    createSession(db, room.id, 'codex'); // codex already ran after the fact
    insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'codex', content: 'disagree', type: 'challenge', targetMessageId: fact.id });
    const startSession = vi.fn();

    checkAndDispatch(db, room.id, startSession, createStuckCounter());

    expect(startSession).toHaveBeenCalledWith({ roomId: room.id, seq: 2, agentId: 'claude', registryKey: 'claude' });
  });
});

describe('checkAndDispatch — auto-confirm on silence (03-orchestrator-core.md §1.4)', () => {
  it('auto-confirms when the room is quiet and the latest signal message is propose_completion', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential', { autoConfirmOnSilence: true });
    insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'codex', content: 'a fact', type: 'fact' });
    const proposal = insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'codex', content: 'done', type: 'propose_completion' }).message;

    checkAndDispatch(db, room.id, vi.fn(), createStuckCounter());

    expect(getRoom(db, room.id)).toMatchObject({
      status: 'completed', completionReason: 'auto_silence', completionReferenceMessageId: proposal.id,
    });
  });

  it('does not auto-confirm when autoConfirmOnSilence was not enabled at room creation', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'codex', content: 'done', type: 'propose_completion' });

    checkAndDispatch(db, room.id, vi.fn(), createStuckCounter());

    expect(getRoom(db, room.id)!.status).toBe('active');
  });

  it('does not auto-confirm once a newer trigger message supersedes the proposal', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential', { autoConfirmOnSilence: true });
    insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'codex', content: 'done', type: 'propose_completion' });
    insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'codex', content: 'new fact', type: 'fact' });

    checkAndDispatch(db, room.id, vi.fn(), createStuckCounter());

    expect(getRoom(db, room.id)!.status).toBe('active');
  });

  it('does not auto-confirm while another agent is still running or stopping', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex', 'claude'], 'sequential', { autoConfirmOnSilence: true });
    insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'codex', content: 'done', type: 'propose_completion' });
    const session = createSession(db, room.id, 'claude');
    setAgentState(db, room.id, 'claude', 'running', session.seq);

    checkAndDispatch(db, room.id, vi.fn(), createStuckCounter());

    expect(getRoom(db, room.id)!.status).toBe('active');
  });

  it('does not auto-confirm when nobody has proposed completion yet', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential', { autoConfirmOnSilence: true });
    insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'codex', content: 'a fact', type: 'fact' });

    checkAndDispatch(db, room.id, vi.fn(), createStuckCounter());

    expect(getRoom(db, room.id)!.status).toBe('active');
  });
});

describe('onSubstantiveMessagePosted', () => {
  it('triggers a dispatch check', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'goal' });
    const startSession = vi.fn();

    onSubstantiveMessagePosted(db, room.id, startSession, createStuckCounter());

    expect(startSession).toHaveBeenCalledWith({ roomId: room.id, seq: 1, agentId: 'codex', registryKey: 'codex' });
  });
});

// @ 定向消息（需求 3.3.2）：人类专属，只对被 @ 的那个 agent 是待派发触发源，不唤醒其他 agent；
// 被派发的这次 session 标为 dispatchScope='directed'，其产出的消息也不参与其他 agent 的派发判定。
//
// createdAt/startedAt 都只有毫秒精度，同步的 better-sqlite3 调用可能落在同一毫秒里（"同一毫秒视为已消费"，
// 见 03 §1.2）；这里用假时钟保证跨步骤的时间戳严格递增，避免测试因执行速度偶然打平时间戳而抖动。
describe('@ 定向消息 (targetAgentId)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('isDispatchOwed: a directed message only owes the targeted agent, not others', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex', 'claude'], 'sequential');
    insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'goal' });
    vi.advanceTimersByTime(5);
    // consume the broadcast goal message for both agents first.
    createSession(db, room.id, 'codex');
    createSession(db, room.id, 'claude');
    vi.advanceTimersByTime(5);

    insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'just for you', targetAgentId: 'claude' });

    expect(isDispatchOwed(db, room.id, 'claude')).toBe(true);
    expect(isDispatchOwed(db, room.id, 'codex')).toBe(false);
  });

  it('checkAndDispatch: dispatches the targeted agent normally (agent sees no difference) while the session is stamped dispatchScope="directed"', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex', 'claude'], 'sequential');
    insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'goal' });
    vi.advanceTimersByTime(5);
    createSession(db, room.id, 'codex');
    createSession(db, room.id, 'claude');
    vi.advanceTimersByTime(5);
    insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'just for you', targetAgentId: 'claude' });
    const startSession = vi.fn();

    checkAndDispatch(db, room.id, startSession, createStuckCounter());

    // agent-facing 参数跟广播派发完全一样，不带任何 dispatchScope/definedMessage 信息（见需求 3.3.2）。
    expect(startSession).toHaveBeenCalledWith({ roomId: room.id, seq: 3, agentId: 'claude', registryKey: 'claude' });
    const agent = getRoomAgents(db, room.id).find((a) => a.agentId === 'claude');
    expect(agent?.currentSessionSeq).toBe(3);
    // 定向归属只落在 session 记录里，供调度层自己判断这次产出要不要参与其他 agent 的派发。
    expect(getSession(db, room.id, 3)!.dispatchScope).toBe('directed');
  });

  it('a busy targeted agent leaves the directed message queued rather than dispatching immediately', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['claude'], 'sequential');
    const session = createSession(db, room.id, 'claude');
    setAgentState(db, room.id, 'claude', 'running', session.seq);
    vi.advanceTimersByTime(5);
    insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'just for you', targetAgentId: 'claude' });
    const startSession = vi.fn();

    checkAndDispatch(db, room.id, startSession, createStuckCounter());

    expect(startSession).not.toHaveBeenCalled();
    expect(isDispatchOwed(db, room.id, 'claude')).toBe(true);
  });

  it('prioritizes the directed scope even when a broadcast trigger is also pending for the same agent', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex', 'claude'], 'sequential');
    insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'goal' });
    vi.advanceTimersByTime(5);
    createSession(db, room.id, 'codex');
    createSession(db, room.id, 'claude');
    vi.advanceTimersByTime(5);
    insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'codex', content: 'a fact', type: 'fact' });
    insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'just for you', targetAgentId: 'claude' });
    const startSession = vi.fn();

    checkAndDispatch(db, room.id, startSession, createStuckCounter());

    expect(startSession).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'claude' }));
    const seq = startSession.mock.calls[0][0].seq;
    expect(getSession(db, room.id, seq)!.dispatchScope).toBe('directed');
  });

  it("a directed session's own output does not wake other agents (private handling, publicly visible)", () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex', 'claude'], 'sequential');
    insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'goal' });
    createSession(db, room.id, 'codex');
    const directedSession = createSession(db, room.id, 'claude', 'directed');
    // claude posts a normally-triggering fact while running its directed session.
    insertMessage(db, { roomId: room.id, sessionSeq: directedSession.seq, authorId: 'claude', content: 'a private finding', type: 'fact' });

    expect(isDispatchOwed(db, room.id, 'codex')).toBe(false);

    const startSession = vi.fn();
    checkAndDispatch(db, room.id, startSession, createStuckCounter());
    expect(startSession).not.toHaveBeenCalled();
  });
});
