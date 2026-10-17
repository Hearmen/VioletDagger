import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import {
  createDb, getRoom, getRoomAgents, listRooms, listSessions, setSessionNative,
  type Session, type SessionNativeRef, type SessionUsage,
} from '../src/storage';
import { getNativeSessionAdapter, type NativeSessionAdapter } from '../src/agent-invocation/native-session';

// 历史 session 补录（04-agent-invocation.md §7.7）：为原生会话分析上线前结束的 session
// 补做 locate → archive → analyze。用法（在 packages/server 下）：
//   npx tsx scripts/backfill-native-sessions.ts [--room <roomId>] [--dry-run]

export type BackfillResult =
  | { kind: 'written' | 'dry-run'; usage: SessionUsage }
  | { kind: 'not-located' }
  | { kind: 'failed'; step: 'locate' | 'archive' | 'analyze'; error: string };

export interface BackfillLine {
  roomId: number;
  seq: number;
  agentId: string;
  result: BackfillResult;
}

export interface BackfillOptions {
  logsDir: string;
  roomId?: number;
  dryRun?: boolean;
  getAdapter?: (registryKey: string) => NativeSessionAdapter;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function backfillOne(
  db: Database.Database,
  session: Session,
  cwd: string,
  adapter: NativeSessionAdapter,
  opts: BackfillOptions,
): Promise<BackfillResult> {
  const { roomId, seq } = session;
  let located;
  try {
    located = await adapter.locate({
      roomId, seq, agentId: session.agentId, cwd,
      startedAt: session.startedAt,
      endedAt: session.endedAt ?? new Date().toISOString(),
      preassignedId: null,
      rawLogPath: session.rawLogPath ?? '',
    });
  } catch (err) {
    return { kind: 'failed', step: 'locate', error: message(err) };
  }
  if (!located) return { kind: 'not-located' };

  // --dry-run：analyze 都按副本目录读取，文件型先复制到一次性临时目录、分析完删除；数据库型 archive 不复制。
  if (opts.dryRun) {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'violet-backfill-'));
    try {
      let source;
      try {
        source = await adapter.archive(located, path.join(tmp, 'copy'));
      } catch (err) {
        return { kind: 'failed', step: 'archive', error: message(err) };
      }
      if (!source) return { kind: 'failed', step: 'archive', error: 'copy failed' };
      try {
        return { kind: 'dry-run', usage: (await adapter.analyze(source)).usage };
      } catch (err) {
        return { kind: 'failed', step: 'analyze', error: message(err) };
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  let source;
  try {
    source = await adapter.archive(located, path.join(opts.logsDir, String(roomId), 'native', String(seq)));
  } catch (err) {
    return { kind: 'failed', step: 'archive', error: message(err) };
  }
  if (!source) return { kind: 'failed', step: 'archive', error: 'copy failed' };

  let usage: SessionUsage;
  try {
    usage = (await adapter.analyze(source)).usage;
  } catch (err) {
    return { kind: 'failed', step: 'analyze', error: message(err) };
  }
  const native: SessionNativeRef = {
    sessionId: located.sessionId,
    storage: located.storage,
    originalPath: located.originalPath,
    copyPath: source.storage === 'file' ? source.copyPath : null,
  };
  setSessionNative(db, roomId, seq, native, usage);
  return { kind: 'written', usage };
}

export async function backfillNativeSessions(db: Database.Database, opts: BackfillOptions): Promise<BackfillLine[]> {
  const getAdapter = opts.getAdapter ?? getNativeSessionAdapter;
  const roomIds = opts.roomId != null ? [opts.roomId] : listRooms(db).map((room) => room.id);
  const lines: BackfillLine[] = [];
  for (const roomId of roomIds) {
    const room = getRoom(db, roomId);
    if (!room) continue;
    // 与 startSession 相同的工作目录解析（agentInvocation.ts）：空串（历史数据）回退到服务端默认目录。
    const cwd = room.workdir.trim() || process.env.VIOLETDAGGER_WORKDIR || process.cwd();
    const registryKeys = new Map(getRoomAgents(db, roomId).map((agent) => [agent.agentId, agent.registryKey]));
    for (const session of listSessions(db, roomId)) {
      if (session.outcome === 'running' || session.outcome === 'stopping' || session.nativeSessionId != null) continue;
      const registryKey = registryKeys.get(session.agentId);
      if (!registryKey) continue;
      const result = await backfillOne(db, session, cwd, getAdapter(registryKey), opts);
      lines.push({ roomId, seq: session.seq, agentId: session.agentId, result });
    }
  }
  return lines;
}

function formatLine(line: BackfillLine): string {
  const head = `room ${line.roomId} #${line.seq} ${line.agentId}`;
  const { result } = line;
  if (result.kind === 'not-located') return `${head}\t未定位`;
  if (result.kind === 'failed') return `${head}\t失败（${result.step}）：${result.error}`;
  const u = result.usage;
  const label = result.kind === 'written' ? '已写入' : '将写入';
  return `${head}\t${label} input=${u.inputTokens} output=${u.outputTokens} cacheRead=${u.cacheReadTokens} cacheWrite=${u.cacheWriteTokens} cost=${u.costUsd}`;
}

function parseArgs(argv: string[]): { roomId?: number; dryRun: boolean } {
  let roomId: number | undefined;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run') dryRun = true;
    else if (argv[i] === '--room') {
      roomId = Number(argv[i + 1]);
      i += 1;
      if (!Number.isInteger(roomId)) throw new Error(`--room needs an integer room id, got: ${argv[i]}`);
    } else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return { roomId, dryRun };
}

async function main(): Promise<void> {
  const { roomId, dryRun } = parseArgs(process.argv.slice(2));
  // 与 src/main.ts 相同的默认路径。
  const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const db = createDb(process.env.VIOLETDAGGER_DB_PATH ?? path.join(process.cwd(), 'violetdagger.db'));
  const logsDir = process.env.VIOLETDAGGER_LOGS_DIR ?? path.join(serverRoot, 'logs');
  try {
    const lines = await backfillNativeSessions(db, { logsDir, roomId, dryRun });
    for (const line of lines) console.log(formatLine(line));
    const count = (kind: BackfillResult['kind']) => lines.filter((line) => line.result.kind === kind).length;
    console.log(
      `\n共 ${lines.length} 个 session：${dryRun ? `将写入 ${count('dry-run')}` : `已写入 ${count('written')}`}，` +
        `未定位 ${count('not-located')}，失败 ${count('failed')}`,
    );
  } finally {
    db.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
