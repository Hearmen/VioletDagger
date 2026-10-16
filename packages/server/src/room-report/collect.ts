import type { Session } from '../storage';
import { getNativeSessionAdapter, type NativeSessionAdapter, type NativeSessionSource, type NativeSessionStats } from '../agent-invocation';
import type { SessionRecord } from './types';

// 10-room-report.md §3 第 3–5 步：重建原生会话来源、并发调用 analyze、形成 session 记录。

export const ANALYZE_CONCURRENCY = 4;
export const ANALYZE_TIMEOUT_MS = 10_000;

type EndedSession = Session & { outcome: SessionRecord['outcome']; endedAt: string };

export function isEnded(session: Session): session is EndedSession {
  return session.outcome !== 'running' && session.outcome !== 'stopping' && session.endedAt != null;
}

export function sourceOf(session: Session): NativeSessionSource | null {
  if (session.nativeStorage === 'file' && session.nativeCopyPath) {
    return { storage: 'file', copyPath: session.nativeCopyPath };
  }
  if (session.nativeStorage === 'database' && session.nativeOriginalPath && session.nativeSessionId) {
    return { storage: 'database', originalPath: session.nativeOriginalPath, sessionId: session.nativeSessionId };
  }
  return null;
}

// 超时即 abort 传入的 signal；超时或抛错时该 session 的分析结果全为 null。
async function analyzeWithTimeout(
  adapter: NativeSessionAdapter,
  source: NativeSessionSource,
  timeoutMs: number,
): Promise<NativeSessionStats | null> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, timeoutMs);
  });
  try {
    return await Promise.race([adapter.analyze(source, controller.signal).catch(() => null), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function elapsedMs(from: string, to: string | null): number | null {
  if (!to) return null;
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

export async function collectSessionRecords(
  sessions: EndedSession[],
  registryKeys: Map<string, string>,
  options: { getAdapter?: (registryKey: string) => NativeSessionAdapter; timeoutMs?: number } = {},
): Promise<SessionRecord[]> {
  const getAdapter = options.getAdapter ?? getNativeSessionAdapter;
  const timeoutMs = options.timeoutMs ?? ANALYZE_TIMEOUT_MS;

  return mapWithConcurrency(sessions, ANALYZE_CONCURRENCY, async (session) => {
    const source = sourceOf(session);
    const stats = source
      ? await analyzeWithTimeout(getAdapter(registryKeys.get(session.agentId) ?? ''), source, timeoutMs)
      : null;
    return {
      seq: session.seq,
      agentId: session.agentId,
      outcome: session.outcome,
      trigger: session.dispatchTrigger,
      execMs: Math.max(0, Date.parse(session.endedAt) - Date.parse(session.startedAt)),
      // token 取已入库的值，与用量统计展示一致（§3 第 5 步）。
      input: session.inputTokens,
      output: session.outputTokens,
      cacheRead: session.cacheReadTokens,
      cacheWrite: session.cacheWriteTokens,
      steps: stats?.steps ?? null,
      firstResponseMs: stats ? elapsedMs(session.startedAt, stats.firstResponseAt) : null,
      toolCalls: stats?.toolCalls ?? null,
    };
  });
}
