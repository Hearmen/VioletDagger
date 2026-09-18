import { spawn as nodeSpawn } from 'node:child_process';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import type Database from 'better-sqlite3';
import { getRoom, setSessionPgid, setSessionRawLogPath } from '../storage';
import { buildOverview } from '../memory';
import { buildPromptText, writePromptFile } from './prompt';
import type {
  AgentRegistry, OnSessionEnded, OnSessionExitProgress, StartSession, SessionExitEvent, LogChunk,
  SessionLogHandle, StopResult, DeleteRoomArtifacts, AgentInvocation, SpawnedProcess, SpawnProcess,
} from './types';

const MAX_BUFFER_BYTES = 256 * 1024;
const DEFAULT_STOP_GRACE_MS = 2000;
const DEFAULT_STOP_CONFIRM_MS = 3000;

interface RunningSession {
  proc: SpawnedProcess | null;
  pgid: number;
  agentId: string;
  // preparing：prompt/mcp 文件异步准备阶段，进程尚未 spawn；此窗口内 terminate 会取消启动（exitCause=not-started）。
  preparing: boolean;
  stopRequested: boolean;
  resolved: boolean;
  exited: boolean;
  exitEvent: SessionExitEvent | null;
  rawLogPath: string;
  chunks: LogChunk[];
  bufferedBytes: number;
  truncated: boolean;
  nextOffset: number;
  dataListeners: Set<(chunk: LogChunk) => void>;
  exitListeners: Set<(event: SessionExitEvent) => void>;
  stopPromise: Promise<StopResult> | null;
  logStream: WriteStream | null;
  stopGraceMs: number;
  stopConfirmMs: number;
}

// 把 {{prompt}} / {{promptFile}} / {{mcpUrl}} / {{mcpFile}} 等占位符替换进 argv 元素或 env 值。
function substitutePlaceholders(input: string, values: Record<string, string>): string {
  let result = input;
  for (const [placeholder, value] of Object.entries(values)) {
    result = result.replaceAll(placeholder, value);
  }
  return result;
}

// `~` 展开：普通 `~/x` 用 home；`~/.kimi-code/...` 优先用 $KIMI_CODE_HOME（kimi 的 home 覆盖机制）。
function expandHomePrefix(input: string): string {
  if (input !== '~' && !input.startsWith('~/')) return input;
  const rest = input === '~' ? '' : input.slice(2);
  if (rest === '.kimi-code' || rest.startsWith('.kimi-code/')) {
    const home = process.env.KIMI_CODE_HOME ?? path.join(os.homedir(), '.kimi-code');
    const sub = rest === '.kimi-code' ? '' : rest.slice('.kimi-code/'.length);
    return sub ? path.join(home, sub) : home;
  }
  return rest ? path.join(os.homedir(), rest) : os.homedir();
}

// 解析 mcpFile.path：先做 `~` 展开，再绝对化（相对路径按 spawn 的 cwd）。
function resolveMcpFilePath(rawPath: string, cwd: string): string {
  const expanded = expandHomePrefix(rawPath);
  return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
}

// 深合并（用于 mcpFile.merge：保留目标文件里其它条目，只覆盖同名项）。数组/标量直接覆盖。
function deepMerge(base: unknown, patch: unknown): unknown {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const target: Record<string, unknown> =
    base && typeof base === 'object' && !Array.isArray(base) ? { ...(base as Record<string, unknown>) } : {};
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    target[key] = deepMerge(target[key], value);
  }
  return target;
}

export function createAgentInvocation(deps: {
  db: Database.Database;
  registry: AgentRegistry;
  onSessionEnded: OnSessionEnded;
  onSessionExitProgress?: OnSessionExitProgress;
  logsDir: string;
  mcpUrl: string;
  promptDir?: string;
  spawnProcess?: SpawnProcess;
}): AgentInvocation {
  const { db, registry, onSessionEnded, logsDir, mcpUrl } = deps;
  const onSessionExitProgress = deps.onSessionExitProgress ?? (() => {});
  // prompt 文件与 session 原始日志都落在 <logsDir> 下；除非显式注入 promptDir，否则用 <logsDir>/prompts。
  const promptDir = deps.promptDir ?? path.join(logsDir, 'prompts');
  const spawnProcess: SpawnProcess = deps.spawnProcess ?? ((file, args, options) =>
    nodeSpawn(file, args, options) as unknown as SpawnedProcess);
  const sessions = new Map<string, RunningSession>();
  const sessionKey = (roomId: number, seq: number) => `${roomId}:${seq}`;

  function notifyData(entry: RunningSession, chunk: LogChunk): void {
    for (const cb of Array.from(entry.dataListeners)) {
      try {
        cb(chunk);
      } catch (err) {
        console.error('session log data listener threw:', err);
      }
    }
  }

  function notifyExit(entry: RunningSession, event: SessionExitEvent): void {
    const listeners = Array.from(entry.exitListeners);
    entry.exitListeners.clear();
    for (const cb of listeners) {
      try {
        cb(event);
      } catch (err) {
        console.error('session log exit listener threw:', err);
      }
    }
  }

  // 记录一条带 stream 标记的日志事件（04 §3.5）：落 JSONL 文件 + 有上限的内存窗口，按 offset 递增。
  function recordChunk(entry: RunningSession, stream: 'stdout' | 'stderr', text: string): void {
    if (text === '') return;
    const chunk: LogChunk = { offset: entry.nextOffset++, stream, text };
    entry.chunks.push(chunk);
    entry.bufferedBytes += Buffer.byteLength(text, 'utf-8');
    // 按完整事件从队首裁剪，保证内存里的 offset 序列连续。
    while (entry.bufferedBytes > MAX_BUFFER_BYTES && entry.chunks.length > 1) {
      const dropped = entry.chunks.shift()!;
      entry.bufferedBytes -= Buffer.byteLength(dropped.text, 'utf-8');
      entry.truncated = true;
    }
    if (entry.logStream) entry.logStream.write(`${JSON.stringify(chunk)}\n`);
    notifyData(entry, chunk);
  }

  function endLogStream(entry: RunningSession): void {
    if (entry.logStream && !entry.logStream.writableEnded) entry.logStream.end();
  }

  // 统一的退出结算入口：只上报一次，退出监听与清理 Promise 共用同一份退出事实（04 §6）。
  function finalize(entry: RunningSession, event: SessionExitEvent): void {
    if (entry.resolved) return;
    entry.resolved = true;
    entry.exited = true;
    entry.exitEvent = event;
    endLogStream(entry);
    try {
      onSessionEnded(event);
    } catch (err) {
      console.error(`onSessionEnded handler threw for room ${event.roomId}, session ${event.seq}:`, err);
    }
    notifyExit(entry, event);
    entry.dataListeners.clear();
  }

  function signalProcess(entry: RunningSession, signal: NodeJS.Signals): void {
    if (!entry.proc) return;
    let sent = false;
    // 按进程组终止，尽量覆盖 CLI 内部再拉起的子进程（04 §5）。
    if (process.platform !== 'win32' && entry.pgid > 0) {
      try {
        process.kill(-entry.pgid, signal);
        sent = true;
      } catch {
        sent = false;
      }
    }
    if (!sent) {
      try {
        entry.proc.kill(signal);
      } catch {
        // best-effort：进程可能已经不存在
      }
    }
  }

  function waitForExit(entry: RunningSession, timeoutMs: number): Promise<boolean> {
    if (entry.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        entry.exitListeners.delete(listener);
        resolve(value);
      };
      const listener = () => finish(true);
      const timer = setTimeout(() => finish(entry.exited), timeoutMs);
      entry.exitListeners.add(listener);
    });
  }

  const startSession: StartSession = ({ roomId, seq, agentId, registryKey }) => {
    const config = registry.agents[registryKey];
    const rawLogPath = path.join(logsDir, String(roomId), `${seq}.jsonl`);
    if (!config) {
      // 注册表没有这个 key：按"启动失败"上报（04 §3.6），不 spawn。
      try {
        onSessionEnded({ roomId, seq, agentId, exitCode: null, signal: null, exitCause: 'spawn-failed', rawLogPath });
      } catch (err) {
        console.error(`onSessionEnded handler threw for room ${roomId}, session ${seq}:`, err);
      }
      return;
    }

    // 该 room 的工作目录（见 01-storage.md §5.4）：优先 room.workdir；为空串（历史数据）回退
    // VIOLETDAGGER_WORKDIR，再回退 server 进程 cwd。
    const roomCwd = getRoom(db, roomId)?.workdir?.trim() || process.env.VIOLETDAGGER_WORKDIR || process.cwd();

    const overview = buildOverview(db, roomId);
    const promptText = buildPromptText({ roomId, agentId, overview });
    const promptFile = path.join(promptDir, `violetdagger-${roomId}-${seq}.prompt.txt`);
    // 默认每次 session 一份独立 MCP 配置（04 §2）；kimi 只支持 user 级 mcp.json，故允许 path 覆盖。
    const mcpFilePath = config.mcpFile?.path
      ? resolveMcpFilePath(config.mcpFile.path, roomCwd)
      : path.join(logsDir, 'mcp', String(roomId), `${seq}.json`);

    // 同步占位：调用方同步把会话标记为 running；准备阶段的 terminate 必须能找到条目并取消启动。
    const entry: RunningSession = {
      proc: null,
      pgid: 0,
      agentId,
      preparing: true,
      stopRequested: false,
      resolved: false,
      exited: false,
      exitEvent: null,
      rawLogPath,
      chunks: [],
      bufferedBytes: 0,
      truncated: false,
      nextOffset: 0,
      dataListeners: new Set(),
      exitListeners: new Set(),
      stopPromise: null,
      logStream: null,
      stopGraceMs: config.stopGraceMs ?? DEFAULT_STOP_GRACE_MS,
      stopConfirmMs: config.stopConfirmMs ?? DEFAULT_STOP_CONFIRM_MS,
    };
    sessions.set(sessionKey(roomId, seq), entry);
    // 立即落库 raw_log_path：运行中的只读日志回放（06 §2.1 mode=replay）在结束前就能读到当前日志。
    setSessionRawLogPath(db, roomId, seq, rawLogPath);

    mkdirSync(promptDir, { recursive: true });
    mkdirSync(path.dirname(rawLogPath), { recursive: true });
    mkdirSync(path.dirname(mcpFilePath), { recursive: true });

    void (async () => {
      // prompt 文件先落盘（占位符 {{promptFile}}/{{prompt}} 都指它）。
      await writePromptFile(promptText, promptFile);
      if (entry.stopRequested) return;

      if (config.mcpFile) {
        let content = config.mcpFile.template.replaceAll('{{mcpUrl}}', mcpUrl);
        if (config.mcpFile.merge) {
          // 共享文件（如 kimi 的 user 级 mcp.json）：读入已有内容深合并，保留其它 server，不整文件覆盖。
          const existing = await readFile(mcpFilePath, 'utf-8').catch(() => null);
          if (existing != null && existing.trim() !== '') {
            try {
              content = `${JSON.stringify(deepMerge(JSON.parse(existing), JSON.parse(content)), null, 2)}\n`;
            } catch {
              // 目标不是合法 JSON——拒绝覆盖，避免毁掉用户已有配置。
              throw new Error(`mcpFile at ${mcpFilePath} is not valid JSON; refusing to merge`);
            }
          }
        }
        // 独立配置仅当前用户可读写（04 §2）。
        await writeFile(mcpFilePath, content, { encoding: 'utf-8', mode: 0o600 });
      }
      if (entry.stopRequested) return;

      const placeholders: Record<string, string> = {
        '{{prompt}}': promptText,
        '{{promptFile}}': promptFile,
        '{{mcpUrl}}': mcpUrl,
        '{{mcpFile}}': mcpFilePath,
        '{{sessionToken}}': '',
      };
      const argv = config.command.map((part) => substitutePlaceholders(part, placeholders));
      const [bin, ...args] = argv;
      const spawnEnv: NodeJS.ProcessEnv = { ...process.env };
      for (const [key, value] of Object.entries(config.env ?? {})) {
        spawnEnv[key] = substitutePlaceholders(value, placeholders);
      }

      entry.logStream = createWriteStream(rawLogPath);
      entry.logStream.on('error', () => {});

      let proc: SpawnedProcess;
      try {
        proc = spawnProcess(bin!, args, {
          cwd: roomCwd,
          env: spawnEnv,
          stdio: [config.promptVia === 'stdin' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
        });
      } catch {
        finalize(entry, { roomId, seq, agentId, exitCode: null, signal: null, exitCause: 'spawn-failed', rawLogPath });
        return;
      }
      entry.proc = proc;
      entry.preparing = false;
      if (typeof proc.pid === 'number') {
        entry.pgid = proc.pid;
        setSessionPgid(db, roomId, seq, proc.pid);
      }

      // stdin 模式：只写入初始 prompt 后关闭 stdin，浏览器没有写 stdin 的入口。
      if (config.promptVia === 'stdin' && proc.stdin) {
        proc.stdin.on('error', () => {});
        proc.stdin.write(promptText);
        proc.stdin.end();
      }

      proc.stdout?.on('data', (data: Buffer | string) => recordChunk(entry, 'stdout', data.toString()));
      proc.stderr?.on('data', (data: Buffer | string) => recordChunk(entry, 'stderr', data.toString()));

      proc.on('error', () => {
        finalize(entry, { roomId, seq, agentId, exitCode: null, signal: null, exitCause: 'spawn-failed', rawLogPath });
      });
      proc.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        const exitCause = entry.stopRequested ? 'managed-stop' : code === 0 ? 'natural' : 'unexpected';
        finalize(entry, {
          roomId, seq, agentId, exitCode: code, signal: signal ?? null, exitCause, rawLogPath,
        });
      });
    })().catch((err) => {
      // prompt/mcp 文件写入失败等准备阶段异常：统一归为启动失败（幂等）。
      console.error(`startSession setup failed for room ${roomId}, session ${seq}:`, err);
      finalize(entry, { roomId, seq, agentId, exitCode: null, signal: null, exitCause: 'spawn-failed', rawLogPath });
    });
  };

  async function doStop(entry: RunningSession, roomId: number, seq: number, attemptId: string): Promise<StopResult> {
    if (entry.exited && entry.exitEvent) return { confirmed: true, exit: entry.exitEvent };

    // 准备阶段就被终止：取消启动，等价于"从未启动"。
    if (entry.preparing && !entry.proc) {
      entry.stopRequested = true;
      onSessionExitProgress(roomId, seq, 'cleanup_started', 'startup cancelled before spawn', attemptId);
      const event: SessionExitEvent = {
        roomId, seq, agentId: entry.agentId, exitCode: null, signal: null,
        exitCause: 'not-started', rawLogPath: entry.rawLogPath, cleanupAttemptId: attemptId,
      };
      entry.resolved = true;
      entry.exited = true;
      entry.exitEvent = event;
      endLogStream(entry);
      notifyExit(entry, event);
      return { confirmed: true, exit: event };
    }

    onSessionExitProgress(roomId, seq, 'cleanup_started', undefined, attemptId);
    signalProcess(entry, 'SIGTERM');
    onSessionExitProgress(roomId, seq, 'sigterm_sent', undefined, attemptId);

    if (!(await waitForExit(entry, entry.stopGraceMs))) {
      signalProcess(entry, 'SIGKILL');
      onSessionExitProgress(roomId, seq, 'sigkill_sent', undefined, attemptId);
      if (!(await waitForExit(entry, entry.stopConfirmMs))) {
        onSessionExitProgress(roomId, seq, 'cleanup_failed', 'process still running after SIGKILL', attemptId);
        return { confirmed: false, error: 'process still running after SIGKILL', rawLogPath: entry.rawLogPath };
      }
    }

    return entry.exitEvent
      ? { confirmed: true, exit: entry.exitEvent }
      : { confirmed: false, error: 'process exited without a recorded exit event', rawLogPath: entry.rawLogPath };
  }

  const stopSessionProcess = (roomId: number, seq: number): Promise<StopResult> => {
    const entry = sessions.get(sessionKey(roomId, seq));
    const attemptId = randomUUID();
    if (!entry) {
      // 缺失内存句柄不等于是从未启动（04 §5）：无法确认时返回失败，保留记录与占位供人工重试。
      return Promise.resolve({ confirmed: false, error: 'no running handle for session', rawLogPath: '' });
    }
    if (entry.stopPromise) return entry.stopPromise;
    entry.stopRequested = true;
    entry.stopPromise = doStop(entry, roomId, seq, attemptId);
    return entry.stopPromise;
  };

  const attachSessionLog = (roomId: number, seq: number): SessionLogHandle | null => {
    const entry = sessions.get(sessionKey(roomId, seq));
    // 只在内存句柄仍表示"运行中/stopping"时提供实时接入；已结束或服务重启后无句柄则由上层读文件快照。
    if (!entry || entry.resolved || entry.exited) return null;
    return {
      snapshot: () => ({ chunks: entry.chunks.slice(), truncated: entry.truncated }),
      onData: (cb) => {
        entry.dataListeners.add(cb);
        return () => entry.dataListeners.delete(cb);
      },
      onExit: (cb) => {
        if (entry.exitEvent) {
          try {
            cb(entry.exitEvent);
          } catch (err) {
            console.error('session log exit listener threw:', err);
          }
          return () => {};
        }
        entry.exitListeners.add(cb);
        return () => entry.exitListeners.delete(cb);
      },
    };
  };

  const deleteRoomArtifacts: DeleteRoomArtifacts = async (roomId) => {
    for (const key of Array.from(sessions.keys())) {
      if (key.startsWith(`${roomId}:`)) sessions.delete(key);
    }
    await rm(path.join(logsDir, String(roomId)), { recursive: true, force: true });
    await rm(path.join(logsDir, 'mcp', String(roomId)), { recursive: true, force: true });
    const files = await readdir(promptDir).catch(() => [] as string[]);
    const prefix = `violetdagger-${roomId}-`;
    await Promise.all(
      files
        .filter((file) => file.startsWith(prefix))
        .map((file) => unlink(path.join(promptDir, file)).catch(() => {})),
    );
  };

  return { startSession, stopSessionProcess, attachSessionLog, deleteRoomArtifacts };
}
