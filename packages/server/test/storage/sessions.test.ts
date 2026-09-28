import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../src/storage/db';
import { createRoom } from '../../src/storage/rooms';
import {
  createSession, setSessionPgid, finishSession, getSession, listSessions, countSessions, getUsageTotals,
} from '../../src/storage/sessions';

describe('sessions', () => {
  it('createSession assigns room-scoped incrementing seq', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex', 'claude'], 'sequential');
    const s1 = createSession(db, room.id, 'codex');
    const s2 = createSession(db, room.id, 'claude');
    expect(s1.seq).toBe(1);
    expect(s2.seq).toBe(2);
    expect(s1.outcome).toBe('running');
    expect(s1.endedAt).toBeNull();
  });

  // @ 定向消息（需求 3.3.2）：dispatchScope 默认 'broadcast'，调用方可显式传 'directed'。
  it('createSession defaults dispatchScope to "broadcast" and persists an explicit "directed"', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex', 'claude'], 'sequential');
    const broadcast = createSession(db, room.id, 'codex');
    const directed = createSession(db, room.id, 'claude', 'directed');
    expect(broadcast.dispatchScope).toBe('broadcast');
    expect(directed.dispatchScope).toBe('directed');
    expect(getSession(db, room.id, directed.seq)!.dispatchScope).toBe('directed');
  });

  it('setSessionPgid and finishSession update the row', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const s = createSession(db, room.id, 'codex');
    setSessionPgid(db, room.id, s.seq, 4242);
    finishSession(db, room.id, s.seq, 'completed', '/logs/1.jsonl');
    const updated = getSession(db, room.id, s.seq)!;
    expect(updated.pgid).toBe(4242);
    expect(updated.outcome).toBe('completed');
    expect(updated.rawLogPath).toBe('/logs/1.jsonl');
    expect(updated.endedAt).not.toBeNull();
  });

  it('countSessions counts every session, error included (all consume maxSessions)', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const s1 = createSession(db, room.id, 'codex');
    const s2 = createSession(db, room.id, 'codex');
    const s3 = createSession(db, room.id, 'codex');
    finishSession(db, room.id, s1.seq, 'completed');
    finishSession(db, room.id, s2.seq, 'error');
    finishSession(db, room.id, s3.seq, 'passed');
    // 3 个 session，error 同样计入配额（需求 3.3）。
    expect(countSessions(db, room.id)).toBe(3);
  });

  it('listSessions returns sessions ordered by seq, countSessions counts all sessions', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex', 'claude'], 'sequential');
    createSession(db, room.id, 'codex');
    createSession(db, room.id, 'claude');
    expect(listSessions(db, room.id).map((s) => s.seq)).toEqual([1, 2]);
    expect(countSessions(db, room.id)).toBe(2);
  });

  it('countSessions returns 0 for a room with no sessions', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    expect(countSessions(db, room.id)).toBe(0);
  });

  it('finishSession persists usage fields, leaving them null when not provided', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex', 'claude'], 'sequential');
    const withUsage = createSession(db, room.id, 'codex');
    finishSession(db, room.id, withUsage.seq, 'completed', undefined, undefined, {
      inputTokens: 20, outputTokens: 6997, cacheReadTokens: 401226, cacheWriteTokens: 32806, costUsd: 0.28,
    });
    expect(getSession(db, room.id, withUsage.seq)).toMatchObject({
      inputTokens: 20, outputTokens: 6997, cacheReadTokens: 401226, cacheWriteTokens: 32806, costUsd: 0.28,
    });

    const withoutUsage = createSession(db, room.id, 'claude');
    finishSession(db, room.id, withoutUsage.seq, 'passed');
    expect(getSession(db, room.id, withoutUsage.seq)).toMatchObject({
      inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null,
    });
  });
});

describe('getUsageTotals', () => {
  it('aggregates per agent and for the whole room, summing only what is present', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex', 'kimi'], 'sequential');
    const codex1 = createSession(db, room.id, 'codex');
    const codex2 = createSession(db, room.id, 'codex');
    const kimi1 = createSession(db, room.id, 'kimi');
    // codex 只有 token，没有费用（见 04-agent-invocation.md §7）。
    finishSession(db, room.id, codex1.seq, 'completed', undefined, undefined, {
      inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 0, costUsd: null,
    });
    finishSession(db, room.id, codex2.seq, 'completed', undefined, undefined, {
      inputTokens: 200, outputTokens: 80, cacheReadTokens: 20, cacheWriteTokens: 5, costUsd: null,
    });
    // kimi 什么用量遥测都没有。
    finishSession(db, room.id, kimi1.seq, 'passed');

    const { byAgent, room: roomTotals } = getUsageTotals(db, room.id);

    expect(byAgent.codex).toEqual({
      inputTokens: 300, outputTokens: 130, cacheReadTokens: 30, cacheWriteTokens: 5,
      costUsd: null, sessionCount: 2, sessionsWithoutTokens: 0, sessionsWithoutCost: 2,
    });
    expect(byAgent.kimi).toEqual({
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      costUsd: null, sessionCount: 1, sessionsWithoutTokens: 1, sessionsWithoutCost: 1,
    });
    expect(roomTotals).toEqual({
      inputTokens: 300, outputTokens: 130, cacheReadTokens: 30, cacheWriteTokens: 5,
      costUsd: null, sessionCount: 3, sessionsWithoutTokens: 1, sessionsWithoutCost: 3,
    });
  });

  it('reports a non-null costUsd once at least one aggregated session has one, and flags the rest as missing', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['claude', 'codex'], 'sequential');
    const claudeSession = createSession(db, room.id, 'claude');
    const codexSession = createSession(db, room.id, 'codex');
    finishSession(db, room.id, claudeSession.seq, 'completed', undefined, undefined, {
      inputTokens: 20, outputTokens: 10, cacheReadTokens: null, cacheWriteTokens: null, costUsd: 0.28,
    });
    finishSession(db, room.id, codexSession.seq, 'completed', undefined, undefined, {
      inputTokens: 5, outputTokens: 5, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null,
    });

    const { room: roomTotals } = getUsageTotals(db, room.id);
    expect(roomTotals.costUsd).toBe(0.28);
    expect(roomTotals.sessionsWithoutCost).toBe(1);
  });

  it('excludes sessions that are still running or stopping', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    createSession(db, room.id, 'codex'); // still running, outcome not finished
    const { room: roomTotals } = getUsageTotals(db, room.id);
    expect(roomTotals).toEqual({
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      costUsd: null, sessionCount: 0, sessionsWithoutTokens: 0, sessionsWithoutCost: 0,
    });
  });

  it('returns empty totals for a room with no sessions', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const { byAgent, room: roomTotals } = getUsageTotals(db, room.id);
    expect(byAgent).toEqual({});
    expect(roomTotals.sessionCount).toBe(0);
    expect(roomTotals.costUsd).toBeNull();
  });
});
