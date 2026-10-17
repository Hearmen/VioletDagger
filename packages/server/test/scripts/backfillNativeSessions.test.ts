import { describe, it, expect, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTestDb } from '../../src/storage/db';
import { createRoom, getRoomAgents } from '../../src/storage/rooms';
import { createSession, finishSession, getSession } from '../../src/storage/sessions';
import type { NativeSessionAdapter } from '../../src/agent-invocation/native-session';
import { backfillNativeSessions } from '../../scripts/backfill-native-sessions';

// 历史 session 补录（04-agent-invocation.md §7.7），用假适配器驱动。

const OLD_USAGE = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, costUsd: 0.5 };
const NEW_USAGE = { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 0, costUsd: null };

function fakeAdapter(overrides: Partial<NativeSessionAdapter> = {}): NativeSessionAdapter {
  return {
    registryKey: 'kimi',
    preassignSessionId: () => null,
    locate: vi.fn(async (ctx) =>
      ctx.seq === 99 ? null : { sessionId: `native-${ctx.seq}`, storage: 'file' as const, originalPath: `/orig/${ctx.seq}` }),
    archive: vi.fn(async (_ref, copyDir: string) => ({ storage: 'file' as const, copyPath: copyDir })),
    analyze: vi.fn(async () => ({ usage: { ...NEW_USAGE }, steps: 1, firstResponseAt: null, toolCalls: [] })),
    deleteOriginal: vi.fn(async () => {}),
    ...overrides,
  };
}

function setup() {
  const db = createTestDb();
  const room = createRoom(db, 'a', ['kimi'], 'sequential');
  const agentId = getRoomAgents(db, room.id)[0].agentId;
  const finished = (usage = OLD_USAGE) => {
    const s = createSession(db, room.id, agentId, 'broadcast', 'room_flag');
    finishSession(db, room.id, s.seq, 'completed', `/logs/${s.seq}.jsonl`, undefined, usage);
    return s.seq;
  };
  return { db, room, agentId, finished };
}

describe('backfillNativeSessions', () => {
  it('writes the native ref and overwrites old usage for located sessions', async () => {
    const { db, room, finished } = setup();
    const seq = finished();
    const adapter = fakeAdapter();
    const lines = await backfillNativeSessions(db, { logsDir: '/logs', getAdapter: () => adapter });

    expect(lines).toEqual([{ roomId: room.id, seq, agentId: expect.any(String), result: { kind: 'written', usage: NEW_USAGE } }]);
    expect(adapter.locate).toHaveBeenCalledWith(expect.objectContaining({ preassignedId: null, rawLogPath: `/logs/${seq}.jsonl` }));
    expect(getSession(db, room.id, seq)).toMatchObject({
      outcome: 'completed',
      nativeSessionId: `native-${seq}`, nativeStorage: 'file', nativeOriginalPath: `/orig/${seq}`,
      nativeCopyPath: `/logs/${room.id}/native/${seq}`,
      ...NEW_USAGE,
    });
  });

  it('skips running and already-backfilled sessions, so a second run changes nothing', async () => {
    const { db, room, agentId, finished } = setup();
    finished();
    createSession(db, room.id, agentId, 'broadcast', 'room_flag'); // 运行中
    const adapter = fakeAdapter();
    await backfillNativeSessions(db, { logsDir: '/logs', getAdapter: () => adapter });
    const second = await backfillNativeSessions(db, { logsDir: '/logs', getAdapter: () => adapter });
    expect(second).toEqual([]);
    expect(adapter.locate).toHaveBeenCalledTimes(1);
  });

  it('leaves the session untouched when it is not located or archiving fails', async () => {
    const { db, room, finished } = setup();
    const seq = finished();
    const adapter = fakeAdapter({ archive: vi.fn(async () => null) });
    const lines = await backfillNativeSessions(db, { logsDir: '/logs', getAdapter: () => adapter });
    expect(lines[0].result).toEqual({ kind: 'failed', step: 'archive', error: 'copy failed' });
    expect(getSession(db, room.id, seq)).toMatchObject({ nativeSessionId: null, ...OLD_USAGE });

    const notFound = fakeAdapter({ locate: vi.fn(async () => null) });
    const again = await backfillNativeSessions(db, { logsDir: '/logs', getAdapter: () => notFound });
    expect(again[0].result).toEqual({ kind: 'not-located' });
    expect(getSession(db, room.id, seq)).toMatchObject({ nativeSessionId: null, ...OLD_USAGE });
  });

  it('dry-run analyzes a throwaway temp copy and writes nothing', async () => {
    const { db, room, finished } = setup();
    const seq = finished();
    const adapter = fakeAdapter();
    const lines = await backfillNativeSessions(db, { logsDir: '/logs', dryRun: true, getAdapter: () => adapter });
    expect(lines[0].result).toEqual({ kind: 'dry-run', usage: NEW_USAGE });
    const copyDir = vi.mocked(adapter.archive).mock.calls[0][1];
    expect(copyDir.startsWith(tmpdir())).toBe(true);
    expect(adapter.analyze).toHaveBeenCalledWith({ storage: 'file', copyPath: copyDir });
    // 临时目录分析完即删除。
    expect(existsSync(path.dirname(copyDir))).toBe(false);
    expect(getSession(db, room.id, seq)).toMatchObject({ nativeSessionId: null, ...OLD_USAGE });
  });

  it('only touches the requested room with --room', async () => {
    const { db, finished } = setup();
    finished();
    const other = createRoom(db, 'b', ['kimi'], 'sequential');
    const adapter = fakeAdapter();
    const lines = await backfillNativeSessions(db, { logsDir: '/logs', roomId: other.id, getAdapter: () => adapter });
    expect(lines).toEqual([]);
  });
});
