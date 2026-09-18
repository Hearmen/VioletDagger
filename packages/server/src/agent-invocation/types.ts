import type { SessionExitCause } from '../storage';

export interface AgentMcpFileConfig {
  template: string;   // 文件内容模板（JSON），含 {{mcpUrl}}
  // 缺省 <logsDir>/mcp/<roomId>/<seq>.json（每次 session 独立）。kimi 只认 user 级 mcp.json，
  // 没有 per-invocation 的 MCP 配置 flag，因此允许指到 `~/.kimi-code/mcp.json` 并 merge 写入。
  path?: string;      // 支持 `~`（`~/.kimi-code/` 优先用 $KIMI_CODE_HOME）；相对路径按 spawn 的 cwd 解析
  merge?: boolean;    // true：读入已存在的 JSON 并深合并 template（保留其它条目），而不是整文件覆盖
}

export interface AgentConfig {
  command: string[];              // 一次性非交互调用的 argv：首元素是可执行文件，其余是参数；支持 {{prompt}} / {{promptFile}} / {{mcpUrl}} / {{mcpFile}}
  promptVia?: 'arg' | 'stdin';    // prompt 注入方式：'arg'（默认，占位符替换进 argv）或 'stdin'（写入进程 stdin 后关闭）
  env?: Record<string, string>;   // 追加到 spawn 的环境变量（覆盖 process.env 同名项），值支持同样的占位符
  mcpFile?: AgentMcpFileConfig;   // 每次 session 一份独立配置文件（见 04 §2）
  stopGraceMs?: number;           // 人工终止 SIGTERM 宽限期，默认 2000
  stopConfirmMs?: number;         // SIGKILL 后退出确认期限，默认 3000
}

export interface AgentRegistry {
  agents: Record<string, AgentConfig>;
}

export type LogStream = 'stdout' | 'stderr';

export interface LogChunk {
  offset: number;
  stream: LogStream;
  text: string;
}

// 日志 WS 的带类型 JSON 帧（见 06-orchestrator-api.md §2.1），避免日志正文与控制信息混淆。
export type SessionLogFrame =
  | { type: 'ready'; source: 'live' | 'snapshot'; truncated: boolean }
  | { type: 'data'; offset: number; stream: LogStream; text: string }
  | { type: 'end'; reason: 'process-exited' | 'snapshot-complete'; exitCode: number | null }
  | { type: 'error'; message: string };

export type SessionExitEvent = {
  roomId: number;
  seq: number;
  agentId: string;
  exitCode: number | null;
  signal: string | null;
  exitCause: SessionExitCause;
  rawLogPath: string;
  cleanupAttemptId?: string;
};

// 只读日志接入句柄（见 04-agent-invocation.md 第 4 节）：没有 write/resize/interactive 能力。
export interface SessionLogHandle {
  snapshot(): { chunks: LogChunk[]; truncated: boolean };
  onData(cb: (chunk: LogChunk) => void): () => void;
  onExit(cb: (event: SessionExitEvent) => void): () => void;
}

export type StopResult =
  | { confirmed: true; exit: SessionExitEvent }
  | { confirmed: false; error: string; rawLogPath: string };

export type StartSession = (params: {
  roomId: number;
  seq: number;
  agentId: string;
  registryKey: string;
}) => void;

export type OnSessionEnded = (event: SessionExitEvent) => void;

export type OnSessionExitProgress = (
  roomId: number,
  seq: number,
  kind: 'cleanup_started' | 'sigterm_sent' | 'sigkill_sent' | 'cleanup_failed',
  detail?: string,
  cleanupAttemptId?: string,
) => void;

export type DeleteRoomArtifacts = (roomId: number) => Promise<void>;

export interface AgentInvocation {
  startSession: StartSession;
  stopSessionProcess: (roomId: number, seq: number) => Promise<StopResult>;
  attachSessionLog: (roomId: number, seq: number) => SessionLogHandle | null;
  deleteRoomArtifacts: DeleteRoomArtifacts;
}

// 供测试注入的普通子进程抽象（对应 node:child_process 的 ChildProcess 子集）。
export interface SpawnedProcess {
  pid?: number;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  stdin: NodeJS.WritableStream | null;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'close', cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnProcess = (
  file: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdio: ['ignore' | 'pipe', 'pipe', 'pipe'];
    detached?: boolean;
  },
) => SpawnedProcess;
