import { describe, it, expect, vi } from 'vitest';
import { createTestDb } from '../../src/storage/db';
import { createRoom, setRoomStatus } from '../../src/storage/rooms';
import { createSession, finishSession } from '../../src/storage/sessions';
import { insertMessage } from '../../src/storage/messages';
import { createNullAdapter, type NativeSessionAdapter, type NativeSessionStats } from '../../src/agent-invocation/native-session';
import { aggregateRow, aggregateToolNames } from '../../src/room-report/aggregate';
import { durationStats, median, p90 } from '../../src/room-report/stats';
import { getRoomReport, RoomNotFoundError, type SessionRecord } from '../../src/room-report';

// 任务分析报告（10-room-report.md）。

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    seq: 1, agentId: 'codex', outcome: 'completed', trigger: 'room_flag', execMs: 10_000,
    input: 100, output: 50, cacheRead: 300, cacheWrite: 0,
    steps: 5, firstResponseMs: 2000, toolCalls: [],
    ...overrides,
  };
}

describe('stats', () => {
  it('median averages the middle pair; p90 uses nearest rank', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(9);
    expect(p90([5])).toBe(5);
  });

  it('max ties go to the smallest seq; empty samples are all null', () => {
    expect(durationStats([{ seq: 3, value: 9 }, { seq: 2, value: 9 }, { seq: 1, value: 4 }])).toMatchObject({ max: 9, maxSeq: 2 });
    expect(durationStats([])).toEqual({ mean: null, median: null, p90: null, max: null, maxSeq: null });
  });
});

describe('aggregateRow', () => {
  it('computes session outcomes, triggers and rates', () => {
    const row = aggregateRow([
      record({ seq: 1, outcome: 'completed', trigger: 'room_flag' }),
      record({ seq: 2, outcome: 'passed', trigger: 'continuation' }),
      record({ seq: 3, outcome: 'error', trigger: null }),
      record({ seq: 4, outcome: 'terminated', trigger: 'directed_flag' }),
    ], { agentId: 'codex', registryKey: 'codex' });
    expect(row.sessions).toEqual({
      total: 4,
      byOutcome: { completed: 1, passed: 1, error: 1, terminated: 1 },
      completionRate: 0.25, passRate: 0.25, errorRate: 0.25,
      byTrigger: { room_flag: 1, directed_flag: 1, continuation: 1, turn: 0, unknown: 1 },
    });
  });

  it('keeps "no data" distinct from zero for tokens', () => {
    const row = aggregateRow([
      record({ seq: 1, input: 100, output: 50, cacheRead: 300, cacheWrite: null, steps: 5, execMs: 10_000 }),
      record({ seq: 2, input: null, output: null, cacheRead: null, cacheWrite: null, steps: null, execMs: 5_000 }),
    ], { agentId: 'codex', registryKey: 'codex' });
    expect(row.tokens).toMatchObject({
      input: 100, output: 50, cacheRead: 300, cacheWrite: null, total: 450,
      cacheHitRate: 300 / 400,
      perSession: 450,           // 只除以有 token 数据的 session
      perCompletedSession: 225,  // 除以 completed 数（2）
      perStep: 90,
      outputPerSecond: 5,        // 只取 output 非 null 的 session 的执行时长
      missingSessions: 1,
    });
    expect(row.model).toMatchObject({ steps: 5, stepsPerSession: 5, missingSessions: 1 });
  });

  it('returns null aggregates for an agent without sessions', () => {
    const row = aggregateRow([], { agentId: 'kimi', registryKey: 'kimi' });
    expect(row.sessions.completionRate).toBeNull();
    expect(row.time.totalExecMs).toBeNull();
    expect(row.tokens.total).toBeNull();
    expect(row.tools).toMatchObject({ total: null, failed: null, successRate: null, missingSessions: 0 });
  });

  it('computes tool metrics only over sessions with tool data', () => {
    const row = aggregateRow([
      record({ seq: 1, steps: 4, toolCalls: [
        { name: 'post_message', isRoomMcp: true, failed: false },
        { name: 'Bash', isRoomMcp: false, failed: true },
        { name: 'Bash', isRoomMcp: false, failed: null },
        { name: 'Read', isRoomMcp: false, failed: false },
      ] }),
      record({ seq: 2, toolCalls: null }),
    ], { agentId: 'codex', registryKey: 'codex' });
    expect(row.tools).toEqual({
      total: 4, perSession: 4, perStep: 1, failed: 1,
      successRate: 2 / 3, unknownOutcomeCalls: 1, missingSessions: 1,
    });
  });

  it('reports failed = 0 for zero calls and null when every outcome is unknown', () => {
    expect(aggregateRow([record({ toolCalls: [] })], { agentId: 'a', registryKey: 'a' }).tools.failed).toBe(0);
    const unknown = aggregateRow([record({ toolCalls: [{ name: 'x', isRoomMcp: false, failed: null }] })], { agentId: 'a', registryKey: 'a' });
    expect(unknown.tools).toMatchObject({ failed: null, successRate: null, unknownOutcomeCalls: 1 });
  });

  it('first-response latency counts its own missing sessions', () => {
    const row = aggregateRow([
      record({ seq: 1, firstResponseMs: 1000 }),
      record({ seq: 2, firstResponseMs: 3000 }),
      record({ seq: 3, firstResponseMs: null }),
    ], { agentId: 'a', registryKey: 'a' });
    expect(row.model.firstResponse).toEqual({ mean: 2000, median: 2000, missingSessions: 1 });
  });
});

describe('aggregateToolNames', () => {
  it('merges by (name, isRoomMcp) and sorts by count desc then name', () => {
    const names = aggregateToolNames([
      record({ toolCalls: [
        { name: 'post_message', isRoomMcp: true, failed: false },
        { name: 'Bash', isRoomMcp: false, failed: true },
        { name: 'Bash', isRoomMcp: false, failed: false },
        { name: 'Agent', isRoomMcp: false, failed: null },
      ] }),
      record({ toolCalls: [{ name: 'post_message', isRoomMcp: true, failed: true }] }),
    ]);
    expect(names).toEqual([
      { name: 'Bash', isRoomMcp: false, count: 2, failed: 1 },
      { name: 'post_message', isRoomMcp: true, count: 2, failed: 1 },
      { name: 'Agent', isRoomMcp: false, count: 1, failed: null },
    ]);
  });
});

describe('getRoomReport', () => {
  const stats = (overrides: Partial<NativeSessionStats> = {}): NativeSessionStats => ({
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1, costUsd: null },
    steps: 2, firstResponseAt: null,
    toolCalls: [{ name: 'post_message', isRoomMcp: true, failed: false }],
    ...overrides,
  });

  function fixture() {
    const db = createTestDb();
    const room = createRoom(db, 'r', ['codex', 'claude', 'kimi'], 'parallel', { maxSessions: 10 });
    insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'goal', type: 'open_question' });
    const s1 = createSession(db, room.id, 'codex', 'broadcast', 'room_flag');
    finishSession(db, room.id, s1.seq, 'completed', undefined, undefined,
      { inputTokens: 100, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 0, costUsd: null },
      { sessionId: 't1', storage: 'file', originalPath: '/o/t1', copyPath: '/c/1' });
    const s2 = createSession(db, room.id, 'claude', 'directed', 'directed_flag');
    finishSession(db, room.id, s2.seq, 'passed', undefined, undefined,
      { inputTokens: 300, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 1 },
      { sessionId: 's2', storage: 'database', originalPath: '/o/db', copyPath: null });
    createSession(db, room.id, 'codex', 'broadcast', 'continuation'); // 运行中，不计入统计
    return { db, room, s1, s2 };
  }

  it('builds room and agent rows from stored tokens and analyze results', async () => {
    const { db, room, s1 } = fixture();
    const analyze = vi.fn(async () => stats({ usage: { inputTokens: 999, outputTokens: 999, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null } }));
    const getAdapter = (key: string): NativeSessionAdapter => ({ ...createNullAdapter(key), analyze });

    const report = await getRoomReport(db, room.id, { getAdapter });

    expect(analyze).toHaveBeenCalledWith({ storage: 'file', copyPath: '/c/1' }, expect.any(AbortSignal));
    expect(analyze).toHaveBeenCalledWith({ storage: 'database', originalPath: '/o/db', sessionId: 's2' }, expect.any(AbortSignal));
    expect(report.runningSessions).toBe(1);
    expect(report.room).toMatchObject({ maxSessions: 10, sessionsCreated: 3, sessionUsageRate: 0.3, agentId: null });
    // token 取入库值，不用 analyze 的值
    expect(report.room.tokens.total).toBe(800);
    expect(report.agents.map((a) => a.agentId)).toEqual(['codex', 'claude', 'kimi']);
    expect(report.agents[0].tokens.shareOfRoom).toBe(0.525);
    expect(report.agents[2].sessions.total).toBe(0);
    expect(report.room.model.steps).toBe(4);
    expect(report.toolNames.room).toEqual([{ name: 'post_message', isRoomMcp: true, count: 2, failed: 0 }]);
    expect(report.toolNames.byAgent.kimi).toEqual([]);
    expect(report.room.time.exec.maxSeq).not.toBeNull();
    expect(report.agents[0].sessions.byTrigger.room_flag).toBe(1);
    expect(s1.seq).toBe(1);
  });

  it('nulls only the affected session when analyze times out or throws', async () => {
    const { db, room } = fixture();
    const getAdapter = (key: string): NativeSessionAdapter => ({
      ...createNullAdapter(key),
      analyze: key === 'codex'
        ? (_source, signal) => new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted'))))
        : async () => { throw new Error('bad file'); },
    });
    const report = await getRoomReport(db, room.id, { getAdapter, timeoutMs: 20 });
    expect(report.room.model).toMatchObject({ steps: null, missingSessions: 2 });
    expect(report.room.tools.missingSessions).toBe(2);
    expect(report.room.tokens.total).toBe(800);
  });

  it('room duration runs from the first message to the later of completed_at and the last session end', async () => {
    const { db, room } = fixture();
    const report = await getRoomReport(db, room.id, { getAdapter: createNullAdapter });
    expect(report.room.roomDurationMs).not.toBeNull(); // 进行中：到 generatedAt

    setRoomStatus(db, room.id, 'completed');
    db.prepare(`UPDATE rooms SET completed_at = NULL WHERE id = ?`).run(room.id);
    expect((await getRoomReport(db, room.id, { getAdapter: createNullAdapter })).room.roomDurationMs).toBeNull();

    const first = '2026-10-11T10:00:00.000Z';
    db.prepare(`UPDATE messages SET created_at = ? WHERE room_id = ?`).run(first, room.id);
    db.prepare(`UPDATE rooms SET completed_at = ? WHERE id = ?`).run('2026-10-11T11:00:00.000Z', room.id);
    db.prepare(`UPDATE sessions SET ended_at = ? WHERE room_id = ? AND ended_at IS NOT NULL`).run('2026-10-11T10:30:00.000Z', room.id);
    db.prepare(`UPDATE sessions SET ended_at = ? WHERE room_id = ? AND seq = 1`).run('2026-10-11T12:00:00.000Z', room.id);
    expect((await getRoomReport(db, room.id, { getAdapter: createNullAdapter })).room.roomDurationMs).toBe(2 * 3600_000);
  });

  it('throws RoomNotFoundError for an unknown room', async () => {
    await expect(getRoomReport(createTestDb(), 999)).rejects.toBeInstanceOf(RoomNotFoundError);
  });
});
