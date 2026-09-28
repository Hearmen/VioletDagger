import { describe, it, expect, afterEach, vi } from 'vitest';
import { createTestDb } from '../../src/storage/db';
import { createRoom } from '../../src/storage/rooms';
import { insertMessage, setMessageType, setChainStatus, setQuestionStatus, completeExploring } from '../../src/storage/messages';
import type { InsertMessageParams } from '../../src/storage/types';
import { buildOverview } from '../../src/memory/overview';

function setup() {
  const db = createTestDb();
  const room = createRoom(db, 'a', ['codex'], 'sequential');
  const post = (params: Omit<InsertMessageParams, 'roomId' | 'sessionSeq' | 'authorId'> & { authorId?: string }) =>
    insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: params.authorId ?? 'codex', ...params });
  const goal = post({ authorId: 'human', content: 'build the thing', type: 'open_question' });
  return { db, room, post, goal };
}

describe('buildOverview', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('throws when the room has no goal yet', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    expect(() => buildOverview(db, room.id)).toThrow('room has no goal yet');
  });

  it('uses the first open_question as goal and keeps it out of questions', () => {
    const { db, room, post, goal } = setup();
    const q = post({ content: 'sub question', type: 'open_question' });
    const overview = buildOverview(db, room.id);
    expect(overview.goal.question).toMatchObject({ id: goal.id, source: 'human', summary: 'build the thing', type: 'open_question' });
    expect(overview.goal.status).toBe('OPEN');
    expect(overview.questions.map((item) => item.question.id)).toEqual([q.id]);
  });

  it('aggregates answers under their question by current type', () => {
    const { db, room, post, goal } = setup();
    const h = post({ content: 'h', type: 'hypothesis', targetMessageId: goal.id });
    const f = post({ content: 'f', type: 'hypothesis', targetMessageId: goal.id });
    const b = post({ content: 'b', type: 'boundary', targetMessageId: goal.id });
    const c = post({ content: 'c', type: 'chain', targetMessageId: goal.id, closesQuestion: true, chainResolution: 'RESOLVED', referencedMessageIds: [b.id] });
    const v = post({ authorId: 'human', content: 'verified', type: 'verify', targetMessageId: f.id, verifyVerdict: true });
    setMessageType(db, room.id, f.id, 'fact', v.id);

    const { goal: g } = buildOverview(db, room.id);
    expect(g.hypotheses.map((k) => k.current.id)).toEqual([h.id]);
    expect(g.facts.map((k) => k.current.id)).toEqual([f.id]);
    expect(g.facts[0].verifies.map((m) => m.id)).toEqual([v.id]);
    expect(g.facts[0].transitions).toEqual([expect.objectContaining({ fromType: 'hypothesis', toType: 'fact', triggerMessageId: v.id })]);
    expect(g.boundaries.map((k) => k.current.id)).toEqual([b.id]);
    expect(g.chains).toEqual([expect.objectContaining({
      status: 'CANDIDATE', closesQuestion: true, chainResolution: 'RESOLVED',
      evidence: [expect.objectContaining({ id: b.id })],
    })]);
  });

  it('reports question status and close reason straight from the columns', () => {
    const { db, room, post, goal } = setup();
    const c = post({ content: 'c', type: 'chain', targetMessageId: goal.id, closesQuestion: true, chainResolution: 'UNRESOLVED' });
    setChainStatus(db, room.id, c.id, 'VERIFIED', 99);
    setQuestionStatus(db, room.id, goal.id, { status: 'CLOSED', closeReason: 'UNRESOLVED', closedBy: c.id }, 99);
    const overview = buildOverview(db, room.id);
    expect(overview.goal).toMatchObject({ status: 'CLOSED', closeReason: 'UNRESOLVED' });
    expect(overview.goal.chains[0].status).toBe('VERIFIED');
  });

  it('lists knowledge that does not answer a question as unattached', () => {
    const { db, room, post } = setup();
    const f = post({ content: 'standalone fact', type: 'fact' });
    const ch = post({ authorId: 'human', content: 'doubt', type: 'challenge', targetMessageId: f.id });
    setMessageType(db, room.id, f.id, 'hypothesis', ch.id);
    const overview = buildOverview(db, room.id);
    expect(overview.unattachedKnowledge).toEqual([expect.objectContaining({
      current: expect.objectContaining({ id: f.id, type: 'hypothesis' }),
      challenges: [expect.objectContaining({ id: ch.id })],
    })]);
    expect(overview.goal.hypotheses).toEqual([]);
  });

  it('splits exploring into active and completed with target and results', () => {
    const { db, room, post, goal } = setup();
    const active = post({ content: 'exploring X', type: 'exploring', targetMessageId: goal.id });
    const done = post({ authorId: 'claude', content: 'exploring Y', type: 'exploring', targetMessageId: goal.id });
    const result = post({ authorId: 'claude', content: 'result', type: 'fact' });
    completeExploring(db, room.id, done.id, { reason: 'explicit', resultSummary: 'found it', resultMessageIds: [result.id] });
    const overview = buildOverview(db, room.id);
    expect(overview.activeExploring).toEqual([expect.objectContaining({
      agentId: 'codex', status: 'active', message: expect.objectContaining({ id: active.id }), target: expect.objectContaining({ id: goal.id }),
    })]);
    expect(overview.completedExploring).toEqual([expect.objectContaining({
      agentId: 'claude', status: 'completed', resultSummary: 'found it', resultMessages: [expect.objectContaining({ id: result.id })],
    })]);
  });

  it('summaries carry source but never the author', () => {
    const { db, room, post } = setup();
    post({ content: 'chat' });
    const overview = buildOverview(db, room.id);
    for (const m of overview.recentRawMessages) expect(m).not.toHaveProperty('authorId');
    expect(overview.recentRawMessages.map((m) => m.source)).toEqual(['human', 'agent']);
  });

  it('reads recentRawMessages count from VIOLETDAGGER_RECENT_RAW_MESSAGES and falls back to 4', () => {
    const { db, room, post } = setup();
    for (let i = 1; i <= 6; i++) post({ content: `m${i}` });
    vi.stubEnv('VIOLETDAGGER_RECENT_RAW_MESSAGES', '2');
    expect(buildOverview(db, room.id).recentRawMessages.map((m) => m.summary)).toEqual(['m5', 'm6']);
    vi.stubEnv('VIOLETDAGGER_RECENT_RAW_MESSAGES', 'not-a-number');
    expect(buildOverview(db, room.id).recentRawMessages).toHaveLength(4);
  });

  it('includes completion proposals and the fixed guidance text', () => {
    const { db, room, post } = setup();
    const proposal = post({ content: 'done', type: 'propose_completion' });
    const overview = buildOverview(db, room.id);
    expect(overview.completionProposals.map((m) => m.id)).toEqual([proposal.id]);
    expect(overview.guidance).toBe(
      '以上是当前任务的进展情况，仅供参考，请形成你自己的判断——可以采纳、组合、推翻，也可以提出全新方案。',
    );
  });
});
