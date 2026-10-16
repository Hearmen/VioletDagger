import { execFile } from 'node:child_process';
import { cp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { SessionUsage } from '../../storage';

// 原生会话分析适配器接口（04-agent-invocation.md §7.1）。

export interface LocatedNativeSession {
  sessionId: string;
  storage: 'file' | 'database';
  originalPath: string; // 文件型为会话文件或目录；数据库型为数据库文件
}

export type NativeSessionSource =
  | { storage: 'file'; copyPath: string }
  | { storage: 'database'; originalPath: string; sessionId: string };

export interface LocateContext {
  roomId: number;
  seq: number;
  agentId: string;
  cwd: string;
  startedAt: string;
  endedAt: string;
  preassignedId: string | null; // preassignSessionId 的返回值
  rawLogPath: string;           // 只用于读取会话标识，不用于统计
}

export interface NativeToolCall {
  name: string;            // isRoomMcp 为 true 时为去掉 server 前缀的工具名；否则为该 CLI 自己的工具名
  isRoomMcp: boolean;
  failed: boolean | null;  // null 表示成败未知
}

export interface NativeSessionStats {
  usage: SessionUsage;            // inputTokens 为非缓存输入；outputTokens 含推理/思考 token
  steps: number | null;           // 模型调用次数
  firstResponseAt: string | null; // 第一次模型调用完成时间（ISO）
  toolCalls: NativeToolCall[] | null;
}

export interface NativeSessionAdapter {
  readonly registryKey: string;
  preassignSessionId(): string | null;
  locate(ctx: LocateContext): Promise<LocatedNativeSession | null>;
  archive(ref: LocatedNativeSession, copyDir: string): Promise<NativeSessionSource | null>;
  analyze(source: NativeSessionSource, signal?: AbortSignal): Promise<NativeSessionStats>;
  deleteOriginal(ref: LocatedNativeSession): Promise<void>;
}

export interface NativeDeleteFailure {
  seq: number;
  agentId: string;
  target: string;
  error: string;
}

// 本系统 MCP server 名（04 §7.1 isRoomMcp）。
export const ROOM_MCP_SERVER = 'violetdagger';

export const EMPTY_USAGE: SessionUsage = {
  inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null,
};

export function emptyStats(): NativeSessionStats {
  return { usage: { ...EMPTY_USAGE }, steps: null, firstResponseAt: null, toolCalls: null };
}

// 未注册的 registryKey（04 §7.1 接口约定）：什么都定位不到，分析全为 null，删除什么都不做。
export function createNullAdapter(registryKey: string): NativeSessionAdapter {
  return {
    registryKey,
    preassignSessionId: () => null,
    locate: async () => null,
    archive: async () => null,
    analyze: async () => emptyStats(),
    deleteOriginal: async () => {},
  };
}

// ---- 各适配器共用的小工具 ----

export type JsonRecord = Record<string, unknown>;

export function asRecord(value: unknown): JsonRecord {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

export function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

// null 只在"一个都没有"时返回；否则是已知值之和——不把"没数据"和"是 0"混为一谈。
export function sumOrNull(values: (number | null)[]): number | null {
  const present = values.filter((v): v is number => v != null);
  return present.length ? present.reduce((a, b) => a + b, 0) : null;
}

// 毫秒时间戳或 ISO 字符串 → ISO；无法解析时为 null。
export function toIso(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }
  return null;
}

// JSONL 按行解析；单行损坏（截断、交错）只跳过这一行。
export function parseJsonl(text: string): JsonRecord[] {
  const out: JsonRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) out.push(parsed as JsonRecord);
    } catch {
      // 跳过
    }
  }
  return out;
}

export async function readJsonl(file: string, signal?: AbortSignal): Promise<JsonRecord[]> {
  signal?.throwIfAborted();
  const text = await readFile(file, { encoding: 'utf-8', signal });
  signal?.throwIfAborted();
  return parseJsonl(text);
}

// 原始日志（04 §3：每行 {offset, stream, text}）里的 stdout 事件，只用于读取会话标识。
// stdout 片段按顺序拼接后再按行切分：一次 'data' 事件可能拆散一行 JSON，也可能挤进好几行。
export async function readStdoutEvents(rawLogPath: string): Promise<JsonRecord[]> {
  const text = await readFile(rawLogPath, 'utf-8');
  const stdout: string[] = [];
  for (const envelope of parseJsonl(text)) {
    if (envelope.stream === 'stdout' && typeof envelope.text === 'string') stdout.push(envelope.text);
  }
  return parseJsonl(stdout.join(''));
}

export function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

export async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

// 文件型副本目录里第一个匹配的文件（副本目录由 archive 创建，只放本会话的文件）。
export async function findInCopy(copyDir: string, match: (name: string) => boolean): Promise<string | null> {
  const name = (await readdir(copyDir)).find(match);
  return name ? path.join(copyDir, name) : null;
}

// 复制若干原件到副本目录；任一失败就删除不完整的副本并返回 false（04 §7.1 archive）。
export async function copyInto(copyDir: string, items: { from: string; to: string; optional?: boolean }[]): Promise<boolean> {
  try {
    await rm(copyDir, { recursive: true, force: true });
    for (const item of items) {
      try {
        await cp(item.from, path.join(copyDir, item.to), { recursive: true, errorOnExist: false, force: true });
      } catch (err) {
        if (item.optional && isMissing(err)) continue;
        throw err;
      }
    }
    return true;
  } catch {
    await rm(copyDir, { recursive: true, force: true }).catch(() => {});
    return false;
  }
}

// 外部命令（如 `codex delete`），默认 10 秒超时（04 §7.2）。
export const EXTERNAL_COMMAND_TIMEOUT_MS = 10_000;

export function runCommand(file: string, args: string[], timeoutMs = EXTERNAL_COMMAND_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`${file} ${args.join(' ')} failed: ${String(stderr || err.message).trim()}`));
      else resolve();
    });
  });
}

// CLI 根目录：环境变量优先，否则 home 下的默认目录。
export function homeDir(envName: string, fallback: string): string {
  const fromEnv = process.env[envName];
  return fromEnv && fromEnv.trim() ? fromEnv : fallback;
}
