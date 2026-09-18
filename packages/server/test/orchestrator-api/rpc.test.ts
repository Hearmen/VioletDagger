import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTestDb } from '../../src/storage/db';
import { createRoom, setAgentState, getRoomAgents } from '../../src/storage/rooms';
import { createSession, finishSession } from '../../src/storage/sessions';
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

  it('setAgentEnabled disables an agent and returns ok', () => {
    const { db, room, handlers } = setup();
    expect(handlers.setAgentEnabled({ agentId: 'codex', enabled: false })).toEqual({ ok: true });
    expect(getRoomAgents(db, room.id).find((a) => a.agentId === 'codex')!.dispatchEnabled).toBe(false);
  });

  it('setAgentEnabled rejects invalid params', () => {
    const { handlers } = setup();
    expect(() => (handlers.setAgentEnabled as any)({})).toThrow();
  });

  it('getEventTree groups messages by session in seq order', () => {
    const { db, room, handlers } = setup();
    const s1 = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: s1.seq, authorId: 'codex', content: 'hi', type: 'fact' });
    const tree: any = handlers.getEventTree();
    expect(tree.sessions).toHaveLength(1);
    expect(tree.sessions[0].messages).toHaveLength(1);
  });

  it('getSessionDetail reads the raw log file, returns the session messages, and reports wroteMessages', () => {
    const { db, room, handlers } = setup();
    const s1 = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: s1.seq, authorId: 'codex', content: 'a finding', type: 'fact' });
    const dir = mkdtempSync(path.join(tmpdir(), 'violetdagger-rawlog-'));
    const rawLogPath = path.join(dir, '1.log');
    writeFileSync(rawLogPath, 'raw output here');
    finishSession(db, room.id, s1.seq, 'passed', rawLogPath);

    const detail: any = handlers.getSessionDetail({ sessionId: s1.seq });
    expect(detail.rawLog).toBe('raw output here');
    expect(detail.messages).toHaveLength(1);
    expect(detail.messages[0].content).toBe('a finding');
    expect(detail.wroteMessages).toBe(true);

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
});
