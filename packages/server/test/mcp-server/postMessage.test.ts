import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createTestDb } from '../../src/storage/db';
import { createRoom, setAgentState } from '../../src/storage/rooms';
import { insertMessage } from '../../src/storage/messages';
import { createSession } from '../../src/storage/sessions';
import { createPostMessageHandler } from '../../src/mcp-server/postMessage';
import { McpToolError } from '../../src/mcp-server/validation';

function setup() {
  const db = createTestDb();
  const room = createRoom(db, 'a', ['codex', 'claude'], 'sequential');
  const session = createSession(db, room.id, 'codex');
  setAgentState(db, room.id, 'codex', 'running', session.seq);
  const roomEvents = new EventEmitter();
  const onSubstantiveMessagePosted = vi.fn();
  const resetStuckCount = vi.fn();
  const postMessage = createPostMessageHandler({ db, roomEvents, onSubstantiveMessagePosted, resetStuckCount });
  return { db, room, session, roomEvents, onSubstantiveMessagePosted, resetStuckCount, postMessage };
}

describe('createPostMessageHandler', () => {
  it('inserts a plain chat message and does not trigger dispatch', () => {
    const { room, onSubstantiveMessagePosted, postMessage } = setup();
    const result = postMessage({ roomId: room.id, authorId: 'codex', content: 'just chatting' });
    expect(result.messageId).toBeGreaterThan(0);
    expect(onSubstantiveMessagePosted).not.toHaveBeenCalled();
  });

  it('triggers onSubstantiveMessagePosted when type is provided', () => {
    const { room, onSubstantiveMessagePosted, postMessage } = setup();
    postMessage({ roomId: room.id, authorId: 'codex', content: 'a fact', type: 'fact' });
    expect(onSubstantiveMessagePosted).toHaveBeenCalledWith(room.id);
  });

  it('emits message and memoryUpdate and resets stuck count when a new exploring supersedes the old one', () => {
    const { db, room, session, roomEvents, resetStuckCount, postMessage } = setup();
    const first = insertMessage(db, {
      roomId: room.id, sessionSeq: session.seq, authorId: 'codex', content: 'exploring A', type: 'exploring',
    });
    const messageEvents: any[] = [];
    const memoryEvents: any[] = [];
    roomEvents.on('message', (e) => messageEvents.push(e));
    roomEvents.on('memoryUpdate', (e) => memoryEvents.push(e));

    postMessage({ roomId: room.id, authorId: 'codex', content: 'exploring B', type: 'exploring' });

    expect(messageEvents).toHaveLength(1);
    expect(memoryEvents).toEqual([{ roomId: room.id, messageId: first.message.id }]);
    expect(resetStuckCount).toHaveBeenCalledWith(room.id, 'codex');
  });

  it('rejects a reserved authorId', () => {
    const { room, postMessage } = setup();
    expect(() => postMessage({ roomId: room.id, authorId: 'human', content: 'x' })).toThrow(McpToolError);
  });

  it('rejects when the agent is not currently running', () => {
    const { room, postMessage } = setup();
    expect(() => postMessage({ roomId: room.id, authorId: 'claude', content: 'x' })).toThrow(McpToolError);
  });

  it('requires targetMessageId for reaction types', () => {
    const { room, postMessage } = setup();
    expect(() => postMessage({ roomId: room.id, authorId: 'codex', content: 'x', type: 'endorse' })).toThrow(McpToolError);
  });

  it('rejects referencedMessageIds unless type is chain', () => {
    const { db, room, session, postMessage } = setup();
    const fact = insertMessage(db, { roomId: room.id, sessionSeq: session.seq, authorId: 'codex', content: 'a fact', type: 'fact' });
    expect(() =>
      postMessage({
        roomId: room.id, authorId: 'codex', content: 'x', type: 'fact',
        referencedMessageIds: [fact.message.id],
      }),
    ).toThrow(McpToolError);
  });

  it('accepts a chain message with valid referencedMessageIds', () => {
    const { db, room, session, postMessage } = setup();
    const fact = insertMessage(db, { roomId: room.id, sessionSeq: session.seq, authorId: 'codex', content: 'a fact', type: 'fact' });
    const result = postMessage({
      roomId: room.id, authorId: 'codex', content: 'end to end plan', type: 'chain',
      referencedMessageIds: [fact.message.id],
    });
    expect(result.messageId).toBeGreaterThan(0);
  });

  it('rejects a targetMessageId that does not exist in the room', () => {
    const { room, postMessage } = setup();
    expect(() =>
      postMessage({ roomId: room.id, authorId: 'codex', content: 'x', type: 'endorse', targetMessageId: 999 }),
    ).toThrow(McpToolError);
  });
});
