import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createTestDb } from '../../src/storage/db';
import { createRoom, setAgentState } from '../../src/storage/rooms';
import { createSession } from '../../src/storage/sessions';
import { insertMessage, getMessageById } from '../../src/storage/messages';
import { createCompleteExploringHandler } from '../../src/mcp-server/completeExploring';
import { McpToolError } from '../../src/mcp-server/validation';

function setup() {
  const db = createTestDb();
  const room = createRoom(db, 'a', ['codex', 'claude'], 'sequential');
  const session = createSession(db, room.id, 'codex');
  setAgentState(db, room.id, 'codex', 'running', session.seq);
  const roomEvents = new EventEmitter();
  const resetStuckCount = vi.fn();
  const completeExploring = createCompleteExploringHandler({ db, roomEvents, resetStuckCount });
  return { db, room, session, roomEvents, resetStuckCount, completeExploring };
}

describe('createCompleteExploringHandler', () => {
  it('rejects missing results and invalid result references without ending exploration', () => {
    const { db, room, session, completeExploring } = setup();
    const { message } = insertMessage(db, { roomId: room.id, sessionSeq: session.seq, authorId: 'codex', content: 'investigation', type: 'exploring' });
    const params = { roomId: room.id, authorId: 'codex', messageId: message.id };
    expect(() => completeExploring({ ...params, resultSummary: ' ' })).toThrow('resultSummary');
    expect(() => completeExploring({ ...params, resultSummary: 'done', resultMessageIds: [999] })).toThrow('not found');
    expect(getMessageById(db, room.id, message.id)?.exploringStatus).toBe('active');
    completeExploring({ ...params, resultSummary: 'no conclusion', resultMessageIds: [message.id, message.id] });
    expect(getMessageById(db, room.id, message.id)?.exploringResultMessageIds).toEqual([message.id]);
    expect(() => completeExploring({ ...params, resultSummary: 'overwrite' })).toThrow();
    expect(getMessageById(db, room.id, message.id)?.exploringResultSummary).toBe('no conclusion');
  });
  it('marks the active exploring message completed, emits memoryUpdate, and resets stuck count', () => {
    const { db, room, session, roomEvents, resetStuckCount, completeExploring } = setup();
    const { message } = insertMessage(db, {
      roomId: room.id, sessionSeq: session.seq, authorId: 'codex', content: 'exploring X', type: 'exploring',
    });
    const memoryEvents: any[] = [];
    roomEvents.on('memoryUpdate', (e) => memoryEvents.push(e));

    const result = completeExploring({ roomId: room.id, authorId: 'codex', messageId: message.id, resultSummary: '检查 X，证据不足' });

    expect(result).toEqual({ ok: true });
    expect(getMessageById(db, room.id, message.id)!.exploringStatus).toBe('completed');
    expect(getMessageById(db, room.id, message.id)!.exploringResultSummary).toBe('检查 X，证据不足');
    expect(memoryEvents).toEqual([{ roomId: room.id, messageId: message.id }]);
    expect(resetStuckCount).toHaveBeenCalledWith(room.id, 'codex');
  });

  it('rejects a reserved authorId', () => {
    const { room, completeExploring } = setup();
    expect(() => completeExploring({ roomId: room.id, authorId: 'system', messageId: 1 })).toThrow(McpToolError);
  });

  it('rejects when the agent is not currently running', () => {
    const { room, completeExploring } = setup();
    expect(() => completeExploring({ roomId: room.id, authorId: 'claude', messageId: 1 })).toThrow(McpToolError);
  });

  it('rejects a message that is not an active exploring record', () => {
    const { db, room, session, completeExploring } = setup();
    const { message } = insertMessage(db, {
      roomId: room.id, sessionSeq: session.seq, authorId: 'codex', content: 'a fact', type: 'fact',
    });
    expect(() => completeExploring({ roomId: room.id, authorId: 'codex', messageId: message.id })).toThrow(McpToolError);
  });

  it('rejects an exploring message owned by a different author', () => {
    const { db, room, completeExploring } = setup();
    const s2 = createSession(db, room.id, 'claude');
    setAgentState(db, room.id, 'claude', 'running', s2.seq);
    const { message } = insertMessage(db, {
      roomId: room.id, sessionSeq: s2.seq, authorId: 'claude', content: 'exploring Y', type: 'exploring',
    });
    expect(() => completeExploring({ roomId: room.id, authorId: 'codex', messageId: message.id })).toThrow(McpToolError);
  });
});
