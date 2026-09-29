import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createTestDb } from '../../src/storage/db';
import { createRoom, getRoom, getRoomAgents, setAgentState } from '../../src/storage/rooms';
import { createSession, getSession } from '../../src/storage/sessions';
import { getMessageById, getStateTransitions, countMessages, completeExploring } from '../../src/storage/messages';
import { createStuckCounter } from '../../src/orchestrator-core/stuckCounter';
import {
  submitMessage, SubmitMessageError, type SubmitMessageInput,
} from '../../src/orchestrator-core/submitMessage';
import { roomEvents } from '../../src/events';

afterEach(() => {
  roomEvents.removeAllListeners();
});

function setup(agents: string[] = ['codex', 'claude']) {
  const db = createTestDb();
  const room = createRoom(db, 'r', agents, 'sequential');
  const startSession = vi.fn();
  const stuckCounter = createStuckCounter();
  const submit = (input: Omit<SubmitMessageInput, 'roomId'>) =>
    submitMessage(db, { roomId: room.id, ...input }, startSession, stuckCounter);
  const human = (input: Omit<SubmitMessageInput, 'roomId' | 'author'>) => submit({ author: { kind: 'human' }, ...input }).message;
  const agentSession = (agentId: string) => createSession(db, room.id, agentId).seq;
  const agent = (agentId: string, sessionSeq: number, input: Omit<SubmitMessageInput, 'roomId' | 'author'>) =>
    submit({ author: { kind: 'agent', agentId, sessionSeq }, ...input }).message;
  return { db, room, startSession, stuckCounter, submit, human, agent, agentSession };
}

function expectRejected(fn: () => unknown, pattern: RegExp | string) {
  expect(fn).toThrow(SubmitMessageError);
  expect(fn).toThrow(pattern);
}

describe('submitMessage — first message rule', () => {
  it('forces the first human message to open_question whatever type was passed', () => {
    const { human } = setup();
    expect(human({ content: 'the task' }).type).toBe('open_question');
  });

  it('rejects a targeted first message and writes nothing', () => {
    const { db, room, submit } = setup();
    expectRejected(() => submit({ author: { kind: 'human' }, content: 'task', targetAgentId: 'codex' }), 'first message');
    expect(countMessages(db, room.id)).toBe(0);
  });

  it('does not force the type on later human messages', () => {
    const { human } = setup();
    human({ content: 'task' });
    expect(human({ content: 'chat' }).type).toBeNull();
  });
});

describe('submitMessage — write validation', () => {
  let ctx: ReturnType<typeof setup>;
  let goalId: number;
  beforeEach(() => {
    ctx = setup();
    goalId = ctx.human({ content: 'goal' }).id;
  });

  it('rejects unknown types and relation fields on untyped messages', () => {
    expectRejected(() => ctx.human({ content: 'x', type: 'endorse' as never }), 'unknown message type');
    expectRejected(() => ctx.human({ content: 'x', targetMessageId: goalId }), 'not allowed');
    expectRejected(() => ctx.human({ content: 'x', referencedMessageIds: [goalId] }), 'typed');
  });

  it('enforces question targets for hypothesis, chain and answering fact/boundary', () => {
    const fact = ctx.human({ content: 'f', type: 'fact' });
    expectRejected(() => ctx.human({ content: 'h', type: 'hypothesis' }), 'required');
    expectRejected(() => ctx.human({ content: 'h', type: 'hypothesis', targetMessageId: fact.id }), 'open_question');
    expectRejected(() => ctx.human({ content: 'c', type: 'chain' }), 'required');
    expectRejected(() => ctx.human({ content: 'b', type: 'boundary', targetMessageId: fact.id }), 'open_question');
    expect(ctx.human({ content: 'f2', type: 'fact', targetMessageId: goalId }).targetMessageId).toBe(goalId);
    expectRejected(() => ctx.human({ content: 'q', type: 'open_question', targetMessageId: goalId }), 'not allowed');
    expectRejected(() => ctx.human({ content: 'p', type: 'propose_completion', targetMessageId: goalId }), 'not allowed');
  });

  it('validates chain close intent fields', () => {
    expectRejected(() => ctx.human({ content: 'c', type: 'chain', targetMessageId: goalId, closesQuestion: true }), 'chainResolution');
    expectRejected(() => ctx.human({ content: 'c', type: 'chain', targetMessageId: goalId, chainResolution: 'RESOLVED' }), 'closesQuestion is true');
    expectRejected(() => ctx.human({ content: 'f', type: 'fact', closesQuestion: true }), 'only allowed');
    const chain = ctx.human({ content: 'c', type: 'chain', targetMessageId: goalId, closesQuestion: true, chainResolution: 'UNRESOLVED' });
    expect(chain).toMatchObject({ chainStatus: 'CANDIDATE', closesQuestion: true, chainResolution: 'UNRESOLVED' });
  });

  it('checks challenge/verify targets against the current state', () => {
    const h = ctx.human({ content: 'h', type: 'hypothesis', targetMessageId: goalId });
    expectRejected(() => ctx.human({ content: 'x', type: 'challenge', targetMessageId: h.id }), 'challenge target');
    expectRejected(() => ctx.human({ content: 'x', type: 'verify', targetMessageId: h.id }), 'verifyVerdict');
    expectRejected(() => ctx.human({ content: 'x', type: 'verify', targetMessageId: goalId, verifyVerdict: true }), 'verify target');
    ctx.human({ content: 'yes', type: 'verify', targetMessageId: h.id, verifyVerdict: true });
    // h is now a fact: it can no longer be verified, only challenged.
    expectRejected(() => ctx.human({ content: 'again', type: 'verify', targetMessageId: h.id, verifyVerdict: true }), 'verify target');
    ctx.human({ content: 'doubt', type: 'challenge', targetMessageId: h.id });
  });

  it('rejects challenging a CHALLENGED chain and verifying a VERIFIED/REJECT chain', () => {
    const c = ctx.human({ content: 'c', type: 'chain', targetMessageId: goalId });
    ctx.human({ content: 'doubt', type: 'challenge', targetMessageId: c.id });
    expectRejected(() => ctx.human({ content: 'again', type: 'challenge', targetMessageId: c.id }), 'CHALLENGED');
    ctx.human({ content: 'no', type: 'verify', targetMessageId: c.id, verifyVerdict: false });
    expectRejected(() => ctx.human({ content: 'x', type: 'verify', targetMessageId: c.id, verifyVerdict: true }), 'chain REJECT');
  });

  it('forbids an agent from verifying its own output in the same session, but not in a later one', () => {
    const s1 = ctx.agentSession('codex');
    const h = ctx.agent('codex', s1, { content: 'h', type: 'hypothesis', targetMessageId: goalId });
    expectRejected(() => ctx.agent('codex', s1, { content: 'v', type: 'verify', targetMessageId: h.id, verifyVerdict: true }), 'same session');
    const s2 = ctx.agentSession('codex');
    expect(ctx.agent('codex', s2, { content: 'v', type: 'verify', targetMessageId: h.id, verifyVerdict: true }).type).toBe('verify');
  });

  it('requires exploring to target a question or hypothesis and refuses stacking', () => {
    const s1 = ctx.agentSession('codex');
    const fact = ctx.human({ content: 'f', type: 'fact' });
    expectRejected(() => ctx.agent('codex', s1, { content: 'e', type: 'exploring', targetMessageId: fact.id }), 'open_question or hypothesis');
    const e = ctx.agent('codex', s1, { content: 'e', type: 'exploring', targetMessageId: goalId });
    expectRejected(() => ctx.agent('codex', s1, { content: 'e2', type: 'exploring', targetMessageId: goalId }), 'active exploring');
    completeExploring(ctx.db, ctx.room.id, e.id, { reason: 'explicit', resultSummary: 'done' });
    expect(ctx.agent('codex', s1, { content: 'e2', type: 'exploring', targetMessageId: goalId }).exploringStatus).toBe('active');
  });

  describe('exploring on a closed question', () => {
    // 人类发一条收尾 chain 并 verify true，关闭问题 q；返回收尾 chain。
    const closeQuestion = (q: number, resolution: 'RESOLVED' | 'UNRESOLVED' = 'RESOLVED') => {
      const chain = ctx.human({ content: 'answer', type: 'chain', targetMessageId: q, closesQuestion: true, chainResolution: resolution });
      ctx.human({ content: 'ok', type: 'verify', targetMessageId: chain.id, verifyVerdict: true });
      return chain;
    };

    it('rejects exploring a closed question, naming the question and its closing chain', () => {
      const q = ctx.human({ content: 'sub', type: 'open_question' });
      const chain = closeQuestion(q.id, 'UNRESOLVED');
      const s1 = ctx.agentSession('codex');
      expectRejected(
        () => ctx.agent('codex', s1, { content: 'e', type: 'exploring', targetMessageId: q.id }),
        `目标问题 #${q.id} 已关闭（CLOSED/UNRESOLVED，收尾 chain #${chain.id}）`,
      );
      expectRejected(() => ctx.agent('codex', s1, { content: 'e', type: 'exploring', targetMessageId: q.id }), 'get_overview');
    });

    it('rejects exploring a hypothesis whose question is closed', () => {
      const q = ctx.human({ content: 'sub', type: 'open_question' });
      const h = ctx.human({ content: 'h', type: 'hypothesis', targetMessageId: q.id });
      closeQuestion(q.id);
      const s1 = ctx.agentSession('codex');
      expectRejected(() => ctx.agent('codex', s1, { content: 'e', type: 'exploring', targetMessageId: h.id }), `目标问题 #${q.id} 已关闭`);
    });

    it('rejects exploring a closed goal', () => {
      closeQuestion(goalId);
      const s1 = ctx.agentSession('codex');
      expectRejected(() => ctx.agent('codex', s1, { content: 'e', type: 'exploring', targetMessageId: goalId }), `目标问题 #${goalId} 已关闭`);
    });

    it('accepts exploring again once the question is reopened', () => {
      const q = ctx.human({ content: 'sub', type: 'open_question' });
      const chain = closeQuestion(q.id);
      ctx.human({ content: 'doubt', type: 'challenge', targetMessageId: chain.id });
      expect(getMessageById(ctx.db, ctx.room.id, q.id)!.questionStatus).toBe('OPEN');
      const s1 = ctx.agentSession('codex');
      expect(ctx.agent('codex', s1, { content: 'e', type: 'exploring', targetMessageId: q.id }).exploringStatus).toBe('active');
    });

    it('leaves an exploring that was active before the question closed untouched', () => {
      const q = ctx.human({ content: 'sub', type: 'open_question' });
      const s1 = ctx.agentSession('codex');
      const e = ctx.agent('codex', s1, { content: 'e', type: 'exploring', targetMessageId: q.id });
      closeQuestion(q.id);
      expect(getMessageById(ctx.db, ctx.room.id, e.id)!.exploringStatus).toBe('active');
    });
  });

  it('rejects exploring from a human but accepts every other type', () => {
    expectRejected(() => ctx.human({ content: 'e', type: 'exploring', targetMessageId: goalId }), 'humans cannot post exploring');
    expect(ctx.human({ content: 'done', type: 'propose_completion' }).type).toBe('propose_completion');
    expect(ctx.human({ content: 'q2', type: 'open_question' }).type).toBe('open_question');
  });

  it('only lets humans target agents, and only agents of this room', () => {
    const s1 = ctx.agentSession('codex');
    expectRejected(() => ctx.agent('codex', s1, { content: 'x', targetAgentId: 'claude' }), 'human');
    expectRejected(() => ctx.human({ content: 'x', targetAgentId: 'ghost' }), 'not an agent in this room');
    expect(ctx.human({ content: 'x', targetAgentId: 'claude' }).targetAgentId).toBe('claude');
  });

  it('rejects references outside the room and deduplicates the rest', () => {
    const fact = ctx.human({ content: 'f', type: 'fact' });
    expectRejected(() => ctx.human({ content: 'x', type: 'fact', referencedMessageIds: [999] }), 'not found');
    expect(ctx.human({ content: 'x', type: 'fact', referencedMessageIds: [fact.id, fact.id] }).referencedMessageIds).toEqual([fact.id]);
  });
});

describe('submitMessage — knowledge state transitions (03 §1.3)', () => {
  it('verify(true/false) turns a hypothesis into a fact/boundary and logs the transition', () => {
    const { db, room, human } = setup();
    const goal = human({ content: 'goal' });
    const h1 = human({ content: 'h1', type: 'hypothesis', targetMessageId: goal.id });
    const h2 = human({ content: 'h2', type: 'hypothesis', targetMessageId: goal.id });
    const v1 = human({ content: 'yes', type: 'verify', targetMessageId: h1.id, verifyVerdict: true });
    human({ content: 'no', type: 'verify', targetMessageId: h2.id, verifyVerdict: false });
    expect(getMessageById(db, room.id, h1.id)!.type).toBe('fact');
    expect(getMessageById(db, room.id, h2.id)!.type).toBe('boundary');
    expect(getStateTransitions(db, room.id, h1.id)).toEqual([
      expect.objectContaining({ fromType: 'hypothesis', toType: 'fact', triggerMessageId: v1.id }),
    ]);
  });

  it('a verified closing chain closes its question; another closing chain does not overwrite the reason', () => {
    const { db, room, human } = setup();
    const goal = human({ content: 'goal' });
    const c1 = human({ content: 'c1', type: 'chain', targetMessageId: goal.id, closesQuestion: true, chainResolution: 'UNRESOLVED' });
    const c2 = human({ content: 'c2', type: 'chain', targetMessageId: goal.id, closesQuestion: true, chainResolution: 'RESOLVED' });
    human({ content: 'ok', type: 'verify', targetMessageId: c1.id, verifyVerdict: true });
    expect(getMessageById(db, room.id, goal.id)).toMatchObject({ questionStatus: 'CLOSED', questionCloseReason: 'UNRESOLVED', questionClosedBy: c1.id });
    human({ content: 'ok', type: 'verify', targetMessageId: c2.id, verifyVerdict: true });
    expect(getMessageById(db, room.id, goal.id)).toMatchObject({ questionCloseReason: 'UNRESOLVED', questionClosedBy: c1.id });
    expect(getStateTransitions(db, room.id, goal.id)).toHaveLength(1);
  });

  it('a rejected or non-closing chain leaves the question open', () => {
    const { db, room, human } = setup();
    const goal = human({ content: 'goal' });
    const c1 = human({ content: 'c1', type: 'chain', targetMessageId: goal.id, closesQuestion: true, chainResolution: 'RESOLVED' });
    const c2 = human({ content: 'c2', type: 'chain', targetMessageId: goal.id });
    human({ content: 'no', type: 'verify', targetMessageId: c1.id, verifyVerdict: false });
    human({ content: 'ok', type: 'verify', targetMessageId: c2.id, verifyVerdict: true });
    expect(getMessageById(db, room.id, c1.id)!.chainStatus).toBe('REJECT');
    expect(getMessageById(db, room.id, c2.id)!.chainStatus).toBe('VERIFIED');
    expect(getMessageById(db, room.id, goal.id)!.questionStatus).toBe('OPEN');
  });

  it('challenging the chain that closed a question reopens it; the chain can be re-verified to close it again', () => {
    const { db, room, human } = setup();
    const goal = human({ content: 'goal' });
    const c = human({ content: 'c', type: 'chain', targetMessageId: goal.id, closesQuestion: true, chainResolution: 'RESOLVED' });
    human({ content: 'ok', type: 'verify', targetMessageId: c.id, verifyVerdict: true });
    const ch = human({ content: 'doubt', type: 'challenge', targetMessageId: c.id });
    expect(getMessageById(db, room.id, c.id)!.chainStatus).toBe('CHALLENGED');
    expect(getMessageById(db, room.id, goal.id)).toMatchObject({ questionStatus: 'OPEN', questionCloseReason: null, questionClosedBy: null });
    expect(getStateTransitions(db, room.id, goal.id).at(-1)).toMatchObject({ fromStatus: 'CLOSED/RESOLVED', toStatus: 'OPEN', triggerMessageId: ch.id });
    human({ content: 'ok again', type: 'verify', targetMessageId: c.id, verifyVerdict: true });
    expect(getMessageById(db, room.id, goal.id)!.questionStatus).toBe('CLOSED');
  });

  it('challenging a chain that did not close the question leaves the question closed', () => {
    const { db, room, human } = setup();
    const goal = human({ content: 'goal' });
    const closer = human({ content: 'closer', type: 'chain', targetMessageId: goal.id, closesQuestion: true, chainResolution: 'RESOLVED' });
    const other = human({ content: 'other', type: 'chain', targetMessageId: goal.id });
    human({ content: 'ok', type: 'verify', targetMessageId: closer.id, verifyVerdict: true });
    human({ content: 'doubt', type: 'challenge', targetMessageId: other.id });
    expect(getMessageById(db, room.id, goal.id)!.questionStatus).toBe('CLOSED');
  });

  it('challenging a fact that answers a closed question turns it back into a hypothesis and reopens the question', () => {
    const { db, room, human } = setup();
    const goal = human({ content: 'goal' });
    const f = human({ content: 'f', type: 'fact', targetMessageId: goal.id });
    const c = human({ content: 'c', type: 'chain', targetMessageId: goal.id, closesQuestion: true, chainResolution: 'RESOLVED' });
    human({ content: 'ok', type: 'verify', targetMessageId: c.id, verifyVerdict: true });
    const { changedMessageIds } = submitMessage(db, {
      roomId: room.id, author: { kind: 'human' }, content: 'doubt', type: 'challenge', targetMessageId: f.id,
    }, vi.fn(), createStuckCounter());
    expect(getMessageById(db, room.id, f.id)!.type).toBe('hypothesis');
    expect(getMessageById(db, room.id, goal.id)!.questionStatus).toBe('OPEN');
    expect(changedMessageIds).toEqual([f.id, goal.id]);
  });
});

describe('submitMessage — events and dispatch', () => {
  it('emits message and one memoryUpdate per transitioned message', () => {
    const { human } = setup();
    const goal = human({ content: 'goal' });
    const h = human({ content: 'h', type: 'hypothesis', targetMessageId: goal.id });
    const onMessage = vi.fn();
    const onUpdate = vi.fn();
    roomEvents.on('message', onMessage);
    roomEvents.on('memoryUpdate', onUpdate);
    const v = human({ content: 'ok', type: 'verify', targetMessageId: h.id, verifyVerdict: true });
    expect(onMessage).toHaveBeenCalledWith({ roomId: v.roomId, message: v });
    expect(onUpdate.mock.calls.map((call) => call[0].messageId)).toEqual([h.id]);
  });

  it('runs a dispatch check only for messages that are triggering at write time', () => {
    const { human, startSession, db, room } = setup(['codex']);
    human({ content: 'goal' });
    expect(startSession).toHaveBeenCalledTimes(1);
    // free the agent so a new dispatch would be possible
    const seq = getRoomAgents(db, room.id)[0].currentSessionSeq!;
    db.prepare(`UPDATE room_agents SET state = 'idle', current_session_seq = NULL`).run();
    db.prepare(`UPDATE sessions SET outcome = 'completed' WHERE seq = ?`).run(seq);
    startSession.mockClear();
    human({ content: 'chat' });
    human({ content: 'known', type: 'fact' });
    expect(startSession).not.toHaveBeenCalled();
  });

  it('does not dispatch for output of a directed session', () => {
    const { db, room, agent, human, startSession } = setup();
    const goal = human({ content: 'goal' });
    db.prepare(`UPDATE room_agents SET state = 'idle', current_session_seq = NULL`).run();
    startSession.mockClear();
    const directed = createSession(db, room.id, 'claude', 'directed').seq;
    expect(getSession(db, room.id, directed)!.dispatchScope).toBe('directed');
    agent('claude', directed, { content: 'h', type: 'hypothesis', targetMessageId: goal.id });
    expect(startSession).not.toHaveBeenCalled();
  });

  it('sets the room flag with the author for a triggering message and keeps it while every agent is busy', () => {
    const { db, room, human, agent, startSession } = setup(['codex', 'claude']);
    const goal = human({ content: 'goal' });
    expect(startSession).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'codex' }));
    expect(getRoom(db, room.id)!.dispatchPending).toBe(false);
    setAgentState(db, room.id, 'claude', 'running', 99);
    startSession.mockClear();

    agent('codex', 1, { content: 'c', type: 'chain', targetMessageId: goal.id });

    expect(startSession).not.toHaveBeenCalled();
    expect(getRoom(db, room.id)).toMatchObject({ dispatchPending: true, pendingAuthorId: 'codex' });
  });

  it('does not set any flag for a non-triggering message', () => {
    const { db, room, human, startSession } = setup(['codex']);
    human({ content: 'goal' });
    setAgentState(db, room.id, 'codex', 'idle');
    startSession.mockClear();
    human({ content: 'known', type: 'fact' });
    expect(getRoom(db, room.id)!.dispatchPending).toBe(false);
    expect(startSession).not.toHaveBeenCalled();
  });

  it('a directed triggering human message sets only the target\'s directed flag', () => {
    const { db, room, human, startSession } = setup(['codex', 'claude']);
    human({ content: 'goal' });
    setAgentState(db, room.id, 'codex', 'running', 1);
    setAgentState(db, room.id, 'claude', 'running', 2);
    human({ content: 'for you', type: 'open_question', targetAgentId: 'claude' });
    expect(getRoom(db, room.id)!.dispatchPending).toBe(false);
    expect(getRoomAgents(db, room.id).map((a) => a.directedPending)).toEqual([false, true]);
    expect(startSession).toHaveBeenCalledTimes(1);
  });

  it('resets the stuck counter when the author starts a new exploring', () => {
    const { human, agent, agentSession, stuckCounter, room } = setup();
    const goal = human({ content: 'goal' });
    const seq = agentSession('codex');
    stuckCounter.increment(room.id, 'codex');
    agent('codex', seq, { content: 'e', type: 'exploring', targetMessageId: goal.id });
    expect(stuckCounter.get(room.id, 'codex')).toBe(0);
  });
});
