import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTestDb } from '../../src/storage/db';
import { createRoom, setAgentState, setAgentEnabled, getRoomAgents } from '../../src/storage/rooms';
import { createSession, finishSession, getSession } from '../../src/storage/sessions';
import { insertMessage } from '../../src/storage/messages';
import { createStuckCounter, createFailureCounter } from '../../src/orchestrator-core';
import { createRpcHandlers } from '../../src/orchestrator-api/rpc';

function setup() {
  const db = createTestDb();
  const room = createRoom(db, 'a', ['codex', 'claude'], 'sequential');
  const roomEvents = new EventEmitter();
  const startSession = vi.fn();
  const stopSessionProcess = vi.fn().mockResolvedValue({
    confirmed: true,
    exit: { roomId: room.id, seq: 1, agentId: 'codex', exitCode: null, signal: 'SIGTERM', exitCause: 'managed-stop', rawLogPath: '' },
  });
  const stuckCounter = createStuckCounter();
  const failureCounter = createFailureCounter();
  const handlers = createRpcHandlers({ db, roomId: room.id, roomEvents, startSession, stopSessionProcess, stuckCounter, failureCounter });
  return { db, room, roomEvents, startSession, stopSessionProcess, stuckCounter, failureCounter, handlers };
}

describe('createRpcHandlers', () => {
  it('listMessages returns paginated messages for the bound room', () => {
    const { db, room, handlers } = setup();
    const s1 = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: s1.seq, authorId: 'codex', content: 'hi' });
    const result: any = handlers.listMessages({});
    expect(result.messages).toHaveLength(1);
  });

  it('postHumanMessage inserts with authorId "human" and no sessionSeq, emits message, and triggers dispatch', () => {
    const { room, roomEvents, startSession, handlers } = setup();
    const messageEvents: any[] = [];
    roomEvents.on('message', (e) => messageEvents.push(e));

    const result: any = handlers.postHumanMessage({ content: 'the goal' });

    expect(result.messageId).toBeGreaterThan(0);
    expect(messageEvents[0].message.authorId).toBe('human');
    expect(messageEvents[0].message.sessionSeq).toBeNull();
    expect(startSession).toHaveBeenCalledWith({ roomId: room.id, seq: 1, agentId: 'codex', registryKey: 'codex' });
  });

  it('postHumanMessage emits memoryUpdate with the superseded exploring message id', () => {
    const { room, roomEvents, handlers } = setup();
    const memoryUpdateEvents: any[] = [];
    roomEvents.on('memoryUpdate', (e) => memoryUpdateEvents.push(e));

    const first: any = handlers.postHumanMessage({ content: 'first exploring', type: 'exploring' });
    const second: any = handlers.postHumanMessage({ content: 'second exploring', type: 'exploring' });

    expect(memoryUpdateEvents).toHaveLength(1);
    expect(memoryUpdateEvents[0]).toEqual({ roomId: room.id, messageId: first.messageId });
    expect(second.messageId).toBeGreaterThan(first.messageId);
  });

  it('postHumanMessage rejects a targetMessageId that belongs to another room', () => {
    const { db, handlers } = setup();
    const other = createRoom(db, 'other', ['codex'], 'sequential');
    const otherMessage = insertMessage(db, { roomId: other.id, sessionSeq: null, authorId: 'human', content: 'x', type: 'fact' });

    expect(() =>
      handlers.postHumanMessage({ content: 'endorse', type: 'endorse', targetMessageId: otherMessage.message.id }),
    ).toThrow(/not found in room/);
  });

  // @ 定向消息（需求 3.3.2，人类专属）。用假时钟保证 createSession 与 postHumanMessage 的
  // 时间戳严格递增，避免同步执行落在同一毫秒里被判定为"已消费"（见 03 §1.2）。
  it('postHumanMessage persists a valid targetAgentId and only dispatches the targeted agent', () => {
    vi.useFakeTimers();
    try {
      const { db, room, startSession, handlers } = setup();
      // consume the initial dispatch opportunity so codex isn't picked by broadcast rules.
      createSession(db, room.id, 'codex');
      createSession(db, room.id, 'claude');
      startSession.mockClear();
      vi.advanceTimersByTime(5);

      const result: any = handlers.postHumanMessage({ content: 'just for you', targetAgentId: 'claude' });

      expect(db.prepare('SELECT target_agent_id FROM messages WHERE room_id = ? AND id = ?').get(room.id, result.messageId))
        .toEqual({ target_agent_id: 'claude' });
      // startSession（agent 视角）不携带 dispatchScope——定向和广播对 agent 来说完全一样；
      // 真正的"这次是定向派发"只落在 sessions.dispatch_scope，供调度层自己用（见需求 3.3.2）。
      expect(startSession).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'claude' }));
      const seq = startSession.mock.calls[0][0].seq;
      expect(getSession(db, room.id, seq)!.dispatchScope).toBe('directed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('postHumanMessage rejects a targetAgentId that is not an agent in this room', () => {
    const { handlers } = setup();

    expect(() => handlers.postHumanMessage({ content: 'hi', targetAgentId: 'nonexistent' })).toThrow(/not an agent in this room/);
  });

  it('getMemoryView returns full-text groups for the bound room', () => {
    const { db, room, handlers } = setup();
    const s1 = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: s1.seq, authorId: 'codex', content: 'a fact', type: 'fact' });
    const view: any = handlers.getMemoryView();
    expect(view.facts).toHaveLength(1);
  });

  it('getRoomStatus reports agent state, running session, and stuck flag', () => {
    const { db, room, stuckCounter, handlers } = setup();
    const s1 = createSession(db, room.id, 'codex');
    setAgentState(db, room.id, 'codex', 'running', s1.seq);
    insertMessage(db, { roomId: room.id, sessionSeq: s1.seq, authorId: 'codex', content: 'exploring X', type: 'exploring' });
    stuckCounter.increment(room.id, 'codex');
    stuckCounter.increment(room.id, 'codex');
    stuckCounter.increment(room.id, 'codex');

    const status: any = handlers.getRoomStatus();
    const codexStatus = status.agents.find((a: any) => a.agentId === 'codex');
    expect(status.currentSessionCount).toBe(1);
    expect(codexStatus.state).toBe('running');
    expect(codexStatus.sessionId).toBe(s1.seq);
    expect(codexStatus.activeExploringSummary).toBe('exploring X');
    expect(codexStatus.stuck).toBe(true);
    expect(codexStatus.enabled).toBe(true);
    expect(codexStatus.failureCount).toBe(0);
  });

  it('caughtUp is true for an idle agent with no pending trigger, false once a trigger is unconsumed', () => {
    const { db, room, handlers } = setup();
    let status: any = handlers.getRoomStatus();
    expect(status.agents.find((a: any) => a.agentId === 'codex').caughtUp).toBe(true);

    insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'claude', content: 'x', type: 'fact' });
    status = handlers.getRoomStatus();
    expect(status.agents.find((a: any) => a.agentId === 'codex').caughtUp).toBe(false);
  });

  it('caughtUp is false for a running or stopping agent regardless of triggers', () => {
    const { db, room, handlers } = setup();
    const s1 = createSession(db, room.id, 'codex');
    setAgentState(db, room.id, 'codex', 'running', s1.seq);
    const status: any = handlers.getRoomStatus();
    expect(status.agents.find((a: any) => a.agentId === 'codex').caughtUp).toBe(false);
  });

  it('allCaughtUp is false for a brand new room even though every agent is trivially caught up', () => {
    const { handlers } = setup();
    const status: any = handlers.getRoomStatus();
    expect(status.allCaughtUp).toBe(false);
  });

  it('allCaughtUp is true once every enabled agent is idle+caughtUp and at least one session has run', () => {
    const { db, room, handlers } = setup();
    const s1 = createSession(db, room.id, 'codex');
    finishSession(db, room.id, s1.seq, 'passed');
    const status: any = handlers.getRoomStatus();
    expect(status.allCaughtUp).toBe(true);
  });

  it('allCaughtUp ignores a disabled agent that is still running and not caught up', () => {
    const { db, room, handlers } = setup();
    const codexSession = createSession(db, room.id, 'codex');
    finishSession(db, room.id, codexSession.seq, 'passed');
    const claudeSession = createSession(db, room.id, 'claude');
    setAgentState(db, room.id, 'claude', 'running', claudeSession.seq);
    setAgentEnabled(db, room.id, 'claude', false);
    const status: any = handlers.getRoomStatus();
    expect(status.allCaughtUp).toBe(true);
  });

  it('allCaughtUp is false when there are no enabled agents at all', () => {
    const { db, room, handlers } = setup();
    const s1 = createSession(db, room.id, 'codex');
    finishSession(db, room.id, s1.seq, 'passed');
    setAgentEnabled(db, room.id, 'codex', false);
    setAgentEnabled(db, room.id, 'claude', false);
    const status: any = handlers.getRoomStatus();
    expect(status.allCaughtUp).toBe(false);
  });

  it('setAgentEnabled disables an agent and returns ok', () => {
    const { db, room, handlers } = setup();
    expect(handlers.setAgentEnabled({ agentId: 'codex', enabled: false })).toEqual({ ok: true });
    expect(getRoomAgents(db, room.id).find((a) => a.agentId === 'codex')!.dispatchEnabled).toBe(false);
  });

  it('setAgentEnabled rejects invalid params', () => {
    const { handlers } = setup();
    expect(() => (handlers.setAgentEnabled as any)({})).toThrow();
  });

  it('getEventTree returns a lean per-session outcome/time lookup, not a node tree', () => {
    const { db, room, handlers } = setup();
    const s1 = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: s1.seq, authorId: 'codex', content: 'hi', type: 'fact' });
    const tree: any = handlers.getEventTree();
    expect(tree.sessions).toHaveLength(1);
    expect(tree.sessions[0]).toEqual({
      seq: s1.seq,
      agentId: 'codex',
      outcome: 'running',
      startedAt: s1.startedAt,
      endedAt: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd: null,
    });
    expect(tree.sessions[0].messages).toBeUndefined();
    expect(tree.sessions[0].lifecycleEvents).toBeUndefined();
  });

  it('getUsageSummary delegates to storage.getUsageTotals for the bound room', () => {
    const { db, room, handlers } = setup();
    const s1 = createSession(db, room.id, 'codex');
    finishSession(db, room.id, s1.seq, 'completed', undefined, undefined, {
      inputTokens: 20, outputTokens: 10, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null,
    });

    const summary: any = handlers.getUsageSummary();
    expect(summary.byAgent.codex).toMatchObject({ inputTokens: 20, outputTokens: 10, sessionCount: 1, sessionsWithoutCost: 1 });
    expect(summary.room).toMatchObject({ inputTokens: 20, outputTokens: 10, sessionCount: 1 });
  });

  it('getSessionDetail reads the raw log file, returns the session messages, and reports wroteMessages', () => {
    const { db, room, handlers } = setup();
    const s1 = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: s1.seq, authorId: 'codex', content: 'a finding', type: 'fact' });
    const dir = mkdtempSync(path.join(tmpdir(), 'violetdagger-rawlog-'));
    const rawLogPath = path.join(dir, '1.log');
    writeFileSync(rawLogPath, 'raw output here');
    finishSession(db, room.id, s1.seq, 'passed', rawLogPath, undefined, {
      inputTokens: 20, outputTokens: 6997, cacheReadTokens: 401226, cacheWriteTokens: 32806, costUsd: 0.28,
    });

    const detail: any = handlers.getSessionDetail({ sessionId: s1.seq });
    expect(detail.rawLog).toBe('raw output here');
    expect(detail.messages).toHaveLength(1);
    expect(detail.messages[0].content).toBe('a finding');
    expect(detail.wroteMessages).toBe(true);
    expect(detail).toMatchObject({
      inputTokens: 20, outputTokens: 6997, cacheReadTokens: 401226, cacheWriteTokens: 32806, costUsd: 0.28,
    });

    rmSync(dir, { recursive: true, force: true });
  });

  it('terminateAgentSession delegates to orchestrator-core and returns ok', async () => {
    const { db, room, stopSessionProcess, handlers } = setup();
    const s1 = createSession(db, room.id, 'codex');
    const result = await (handlers.terminateAgentSession as any)({ sessionId: s1.seq });
    expect(stopSessionProcess).toHaveBeenCalledWith(room.id, s1.seq);
    expect(result).toEqual({ ok: true });
  });

  it('pauseRoom/resumeRoom/confirmCompletion delegate to orchestrator-core', () => {
    const { db, room, handlers } = setup();
    expect(handlers.pauseRoom({})).toEqual({ ok: true });
    expect(handlers.resumeRoom({})).toEqual({ ok: true });
    expect(handlers.confirmCompletion({})).toEqual({ ok: true });
  });

  it('getRoomStatus omits completionReason for an active room and reports it once completed', () => {
    const { handlers } = setup();
    const beforeStatus: any = handlers.getRoomStatus();
    expect(beforeStatus.completionReason).toBeUndefined();
    expect(beforeStatus.completionReferenceMessageId).toBeUndefined();

    handlers.confirmCompletion({});

    const afterStatus: any = handlers.getRoomStatus();
    expect(afterStatus.completionReason).toBe('manual');
    expect(afterStatus.completionReferenceMessageId).toBeUndefined();
  });
});
