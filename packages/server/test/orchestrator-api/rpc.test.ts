import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTestDb } from '../../src/storage/db';
import { createRoom, setAgentState } from '../../src/storage/rooms';
import { createSession, finishSession } from '../../src/storage/sessions';
import { insertMessage } from '../../src/storage/messages';
import { createStuckCounter } from '../../src/orchestrator-core';
import { createRpcHandlers } from '../../src/orchestrator-api/rpc';

function setup() {
  const db = createTestDb();
  const room = createRoom(db, 'a', ['codex', 'claude'], 'sequential');
  const roomEvents = new EventEmitter();
  const startSession = vi.fn();
  const killSession = vi.fn().mockResolvedValue({ rawLogPath: null });
  const stuckCounter = createStuckCounter();
  const handlers = createRpcHandlers({ db, roomId: room.id, roomEvents, startSession, killSession, stuckCounter });
  return { db, room, roomEvents, startSession, killSession, stuckCounter, handlers };
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
    expect(startSession).toHaveBeenCalledWith({ roomId: room.id, seq: 1, agentId: 'codex' });
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
  });

  it('getEventTree groups messages by session in seq order', () => {
    const { db, room, handlers } = setup();
    const s1 = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: s1.seq, authorId: 'codex', content: 'hi', type: 'fact' });
    const tree: any = handlers.getEventTree();
    expect(tree.sessions).toHaveLength(1);
    expect(tree.sessions[0].messages).toHaveLength(1);
  });

  it('getSessionDetail reads the raw log file and reports whether messages were written', () => {
    const { db, room, handlers } = setup();
    const s1 = createSession(db, room.id, 'codex');
    const dir = mkdtempSync(path.join(tmpdir(), 'violetdagger-rawlog-'));
    const rawLogPath = path.join(dir, '1.log');
    writeFileSync(rawLogPath, 'raw output here');
    finishSession(db, room.id, s1.seq, 'passed', rawLogPath);

    const detail: any = handlers.getSessionDetail({ sessionId: s1.seq });
    expect(detail.rawLog).toBe('raw output here');
    expect(detail.wroteMessages).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  });

  it('terminateAgentSession delegates to orchestrator-core and returns ok', async () => {
    const { db, room, killSession, handlers } = setup();
    const s1 = createSession(db, room.id, 'codex');
    const result = await (handlers.terminateAgentSession as any)({ sessionId: s1.seq });
    expect(killSession).toHaveBeenCalledWith(room.id, s1.seq);
    expect(result).toEqual({ ok: true });
  });

  it('pauseRoom/resumeRoom/confirmCompletion delegate to orchestrator-core', () => {
    const { db, room, handlers } = setup();
    expect(handlers.pauseRoom({})).toEqual({ ok: true });
    expect(handlers.resumeRoom({})).toEqual({ ok: true });
    expect(handlers.confirmCompletion({})).toEqual({ ok: true });
  });
});
