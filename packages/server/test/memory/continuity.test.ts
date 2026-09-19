import { describe, it, expect, vi } from 'vitest';
import { createTestDb } from '../../src/storage/db';
import { createRoom, setAgentState } from '../../src/storage/rooms';
import { insertMessage, completeExploring, validateMessageRelations, getMessageById } from '../../src/storage/messages';
import { buildOverview, buildDetail, buildMemoryView } from '../../src/memory';
import type { DetailPage, MessageWithAnnotations } from '../../src/memory';
import { buildPromptText } from '../../src/agent-invocation/prompt';
import { checkAndDispatch } from '../../src/orchestrator-core/dispatch';
import { createStuckCounter } from '../../src/orchestrator-core/stuckCounter';

function setup() {
  const db = createTestDb();
  const room = createRoom(db, 'test', ['codex'], 'sequential');
  const post = (content: string, type?: Parameters<typeof insertMessage>[1]['type'], targetMessageId?: number, referencedMessageIds?: number[]) =>
    insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'historical-author', content, type, targetMessageId, referencedMessageIds }).message;
  return { db, room, post };
}

describe('memory continuity', () => {
  it('retains answers, nested reactions, completed exploration and proposals outside the raw window', () => {
    const { db, room, post } = setup();
    const goal = post('goal');
    const q = post('question', 'open_question');
    const answer = post('answer', 'hypothesis', q.id);
    const verified = post('short outage checked', 'verify', answer.id, [goal.id]);
    const challenge = post('long outage remains unknown', 'challenge', verified.id);
    post('agreement', 'endorse', answer.id);
    const followup = post('follow-up question', 'open_question', answer.id);
    const followupAnswer = post('follow-up answer', 'hypothesis', followup.id);
    const exploration = post('investigating', 'exploring');
    completeExploring(db, room.id, exploration.id, undefined, { resultSummary: 'no environment; no conclusion', resultMessageIds: [challenge.id] });
    const proposal = post('suggest stopping', 'propose_completion', undefined, [answer.id]);
    for (let i = 0; i < 6; i++) post(`later ${i}`);
    const overview = buildOverview(db, room.id);
    expect(overview.recentRawMessages.every(m => m.id > proposal.id)).toBe(true);
    expect(overview.relations[q.id].answerIds).toEqual([answer.id]);
    expect(overview.contextMessages.map(m => m.id)).toContain(goal.id);
    expect(overview.completedExploring[0].exploringResultMessageIds).toEqual([challenge.id]);
    expect(overview.completionProposals.map(m => m.id)).toEqual([proposal.id]);
    for (const m of [...overview.hypotheses, ...overview.reactions, ...overview.completedExploring]) expect(m).not.toHaveProperty('authorId');
    const prompt = buildPromptText({ roomId: room.id, agentId: 'codex', overview });
    for (const text of ['short outage checked', 'long outage remains unknown', 'no environment; no conclusion', 'suggest stopping', 'follow-up answer']) expect(prompt).toContain(text);
    expect(prompt).toContain(`已有回答：#${followupAnswer.id}`);
    const detail = buildDetail(db, room.id, { messageId: q.id }) as MessageWithAnnotations;
    expect(detail.answers.map(m => m.id)).toEqual([answer.id]);
    expect(buildMemoryView(db, room.id).relations).toEqual(overview.relations);
    expect(overview.openQuestions[0]).not.toHaveProperty('resolved');
    db.close();
  });

  it('pages through every raw message without duplication or cross-room leakage', () => {
    const { db, room, post } = setup();
    for (let i = 0; i < 7; i++) post(`raw ${i}`);
    const other = createRoom(db, 'other', ['codex'], 'sequential');
    insertMessage(db, { roomId: other.id, authorId: 'human', sessionSeq: null, content: 'private other room' });
    let beforeId: number | undefined;
    const ids: number[] = [];
    do {
      const page = buildDetail(db, room.id, { list: true, beforeId, limit: 2 }) as DetailPage;
      expect(page.messages.every(m => m.roomId === room.id)).toBe(true);
      ids.push(...page.messages.map(m => m.id));
      beforeId = page.nextCursor ?? undefined;
    } while (beforeId);
    expect(ids.sort((a,b) => a-b)).toEqual([1,2,3,4,5,6,7]);
    expect(() => buildDetail(db, room.id, { messageId: 1, list: true })).toThrow();
    expect(() => buildDetail(db, room.id, { list: true, limit: 101 })).toThrow();
    db.close();
  });

  it('validates new answer links but preserves unlinked legacy hypotheses and deduplicates only reference IDs', () => {
    const { db, room, post } = setup();
    const q = post('question', 'open_question');
    const fact = post('fact', 'fact');
    expect(() => validateMessageRelations(db, room.id, { type: 'hypothesis' })).toThrow('required');
    expect(() => validateMessageRelations(db, room.id, { type: 'hypothesis', targetMessageId: fact.id })).toThrow('open_question');
    expect(() => validateMessageRelations(db, room.id, { type: 'hypothesis', targetMessageId: q.id })).not.toThrow();
    const legacy = post('old answer', 'hypothesis');
    expect(buildOverview(db, room.id).hypotheses.find(m => m.id === legacy.id)?.targetMessageId).toBeNull();
    const message = post('references', 'fact', undefined, [fact.id, fact.id]);
    expect(message.referencedMessageIds).toEqual([fact.id]);
    expect(() => validateMessageRelations(db, room.id, { referencedMessageIds: [fact.id] })).toThrow('typed');
    db.close();
  });

  it('distinguishes superseded, explicit and human-ended exploration without overwriting results', () => {
    const { db, room, post } = setup();
    const first = post('first', 'exploring');
    const second = post('second', 'exploring');
    completeExploring(db, room.id, second.id, 'human stopped');
    expect(getMessageById(db, room.id, first.id)?.exploringEndReason).toBe('superseded');
    expect(getMessageById(db, room.id, second.id)?.exploringEndReason).toBe('human_terminated');
    expect(getMessageById(db, room.id, second.id)?.exploringResultSummary).toBeNull();
    expect(() => completeExploring(db, room.id, second.id, undefined, { resultSummary: 'overwrite' })).toThrow();
    db.close();
  });

  it('drops busy dispatch attempts and uses current memory on the next actual dispatch', () => {
    const { db, room, post } = setup();
    setAgentState(db, room.id, 'codex', 'running', 1);
    const start = vi.fn(() => buildOverview(db, room.id));
    const counter = createStuckCounter();
    for (let i = 0; i < 6; i++) { post(`fact ${i}`, 'fact'); checkAndDispatch(db, room.id, start, counter); }
    expect(start).not.toHaveBeenCalled();
    setAgentState(db, room.id, 'codex', 'idle');
    expect(start).not.toHaveBeenCalled();
    checkAndDispatch(db, room.id, start, counter);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.results[0].value.facts).toHaveLength(6);
    db.close();
  });
});
