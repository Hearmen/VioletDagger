import { describe, it, expect, afterEach, vi } from 'vitest';
import { createTestDb } from '../../src/storage/db';
import { createRoom } from '../../src/storage/rooms';
import { createSession } from '../../src/storage/sessions';
import { insertMessage } from '../../src/storage/messages';
import { buildOverview } from '../../src/memory/overview';

describe('buildOverview', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('reads recentRawMessages count from VIOLETDAGGER_RECENT_RAW_MESSAGES', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const s1 = createSession(db, room.id, 'codex');
    for (let i = 1; i <= 5; i++) {
      insertMessage(db, { roomId: room.id, sessionSeq: s1.seq, authorId: 'codex', content: `m${i}` });
    }
    vi.stubEnv('VIOLETDAGGER_RECENT_RAW_MESSAGES', '2');
    expect(buildOverview(db, room.id).recentRawMessages).toHaveLength(2);
  });

  it('falls back to 4 for an invalid VIOLETDAGGER_RECENT_RAW_MESSAGES', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const s1 = createSession(db, room.id, 'codex');
    for (let i = 1; i <= 6; i++) {
      insertMessage(db, { roomId: room.id, sessionSeq: s1.seq, authorId: 'codex', content: `m${i}` });
    }
    vi.stubEnv('VIOLETDAGGER_RECENT_RAW_MESSAGES', 'not-a-number');
    expect(buildOverview(db, room.id).recentRawMessages).toHaveLength(4);
  });

  it('uses the room\'s first message as the goal', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const s1 = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: s1.seq, authorId: 'human', content: 'build the thing' });
    expect(buildOverview(db, room.id).goal).toBe('build the thing');
  });

  it('groups facts/boundaries/openQuestions/chains/hypotheses as id+summary pairs', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const s1 = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: s1.seq, authorId: 'codex', content: 'a fact', type: 'fact' });
    const overview = buildOverview(db, room.id);
    expect(overview.facts).toHaveLength(1);
    expect(overview.facts[0]).toHaveProperty('id');
    expect(overview.facts[0].summary).toBe('a fact');
    expect(overview.boundaries).toEqual([]);
  });

  it('reports only active exploring messages, keyed by agentId', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const s1 = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: s1.seq, authorId: 'codex', content: 'exploring X', type: 'exploring' });
    const overview = buildOverview(db, room.id);
    expect(overview.activeExploring).toEqual([expect.objectContaining({ agentId: 'codex', summary: 'exploring X' })]);
  });

  it('caps recentRawMessages at 4 and includes the fixed guidance text', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const s1 = createSession(db, room.id, 'codex');
    for (let i = 1; i <= 10; i++) {
      insertMessage(db, { roomId: room.id, sessionSeq: s1.seq, authorId: 'codex', content: `m${i}` });
    }
    const overview = buildOverview(db, room.id);
    expect(overview.recentRawMessages).toHaveLength(4);
    expect(overview.recentRawMessages[3].content).toBe('m10');
    expect(overview.guidance).toBe(
      '以上是当前任务的进展情况，仅供参考，请形成你自己的判断——可以采纳、组合、推翻，也可以提出全新方案。',
    );
  });
});
