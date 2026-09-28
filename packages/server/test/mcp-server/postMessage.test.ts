import { describe, it, expect, vi } from 'vitest';
import { createTestDb } from '../../src/storage/db';
import { createRoom, setAgentState } from '../../src/storage/rooms';
import { insertMessage, getMessageById } from '../../src/storage/messages';
import { createSession } from '../../src/storage/sessions';
import { createPostMessageHandler } from '../../src/mcp-server/postMessage';
import { McpToolError } from '../../src/mcp-server/validation';
import { submitMessage } from '../../src/orchestrator-core/submitMessage';
import { createStuckCounter } from '../../src/orchestrator-core/stuckCounter';

function setup() {
  const db = createTestDb();
  const room = createRoom(db, 'a', ['codex', 'claude'], 'sequential');
  const goal = insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'goal', type: 'open_question' });
  const session = createSession(db, room.id, 'codex');
  setAgentState(db, room.id, 'codex', 'running', session.seq);
  const startSession = vi.fn();
  const submit = vi.fn((input) => submitMessage(db, input, startSession, createStuckCounter()));
  const postMessage = createPostMessageHandler({ db, submitMessage: submit });
  return { db, room, goal, session, submit, startSession, postMessage };
}

describe('createPostMessageHandler', () => {
  it('delegates to submitMessage with the bound agent identity and session', () => {
    const { room, session, submit, postMessage } = setup();
    const result = postMessage({ roomId: room.id, authorId: 'codex', content: 'just chatting' });
    expect(result.messageId).toBeGreaterThan(0);
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      roomId: room.id, author: { kind: 'agent', agentId: 'codex', sessionSeq: session.seq }, content: 'just chatting',
    }));
  });

  it('passes verify/chain fields through and lets the core apply transitions', () => {
    const { db, room, goal, postMessage } = setup();
    const h = insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'h', type: 'hypothesis', targetMessageId: goal.id });
    postMessage({ roomId: room.id, authorId: 'codex', content: 'checked', type: 'verify', targetMessageId: h.id, verifyVerdict: false });
    expect(getMessageById(db, room.id, h.id)!.type).toBe('boundary');
    const { messageId } = postMessage({
      roomId: room.id, authorId: 'codex', content: 'plan', type: 'chain', targetMessageId: goal.id,
      closesQuestion: true, chainResolution: 'RESOLVED', referencedMessageIds: [h.id],
    });
    expect(getMessageById(db, room.id, messageId)).toMatchObject({ chainStatus: 'CANDIDATE', closesQuestion: true, chainResolution: 'RESOLVED', referencedMessageIds: [h.id] });
  });

  it('turns core validation failures into MCP tool errors', () => {
    const { room, goal, postMessage } = setup();
    const base = { roomId: room.id, authorId: 'codex', content: 'candidate', type: 'hypothesis' as const };
    expect(() => postMessage(base)).toThrow(McpToolError);
    expect(() => postMessage(base)).toThrow('targetMessageId');
    expect(postMessage({ ...base, targetMessageId: goal.id }).messageId).toBeGreaterThan(goal.id);
    expect(() => postMessage({ roomId: room.id, authorId: 'codex', content: 'x', type: 'challenge', targetMessageId: 999 })).toThrow(McpToolError);
  });

  it('rejects a reserved authorId', () => {
    const { room, postMessage } = setup();
    expect(() => postMessage({ roomId: room.id, authorId: 'human', content: 'x' })).toThrow(McpToolError);
  });

  it('rejects when the agent is not currently running', () => {
    const { room, submit, postMessage } = setup();
    expect(() => postMessage({ roomId: room.id, authorId: 'claude', content: 'x' })).toThrow(McpToolError);
    expect(submit).not.toHaveBeenCalled();
  });
});
