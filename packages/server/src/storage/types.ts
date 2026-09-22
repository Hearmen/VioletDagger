export interface Room {
  id: number;
  name: string;
  schedulingMode: 'sequential';
  status: 'active' | 'paused_limit' | 'paused_manual' | 'completed';
  completionReason: 'manual' | 'auto_silence' | null;         // 仅 status === 'completed' 有值
  completionReferenceMessageId: number | null;                // 仅 completionReason === 'auto_silence' 有值
  maxSessions: number;
  workdir: string;   // 绝对路径；空串表示按服务端默认目录解析（历史数据）
  autoConfirmOnSilence: boolean;   // 创建时一次性写入，房间生命周期内不可修改
  createdAt: string;
}

export interface RoomSummary {
  id: number;
  name: string;
  status: Room['status'];
  createdAt: string;
}

export interface RoomAgentState {
  roomId: number;
  agentId: string;          // agent 实例标识
  registryKey: string;      // 对应 agents.config.json 的 key
  joinOrder: number;
  state: 'idle' | 'running' | 'stopping';
  currentSessionSeq: number | null;
  dispatchEnabled: boolean;
}

export type SessionExitCause =
  | 'natural' | 'managed-stop' | 'unexpected' | 'spawn-failed' | 'not-started';

export type DispatchScope = 'broadcast' | 'directed';

export interface Session {
  roomId: number;
  seq: number;
  agentId: string;
  outcome: 'running' | 'stopping' | 'completed' | 'passed' | 'error' | 'terminated';
  startedAt: string;
  endedAt: string | null;
  pgid: number | null;
  rawLogPath: string | null;
  exitCode: number | null;
  exitSignal: string | null;
  stopIntent: 'terminate' | null;
  cleanupStartedAt: string | null;
  exitCause: SessionExitCause | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
  // 'broadcast'（因广播触发型消息派发）/ 'directed'（因定向给它的 @ 消息派发，见需求 3.3.2）。
  dispatchScope: DispatchScope;
}

// 见 04-agent-invocation.md §7：不是每个 agent 都提供每个字段，拿不到就是 null，不用 0 占位。
export interface SessionUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;          // 参与聚合的 session 里一个费用数据都没有时为 null；否则是已知费用之和（不含缺失的部分）
  sessionCount: number;            // 参与聚合的已结束 session 数
  sessionsWithoutTokens: number;   // 四个 token 字段全为 NULL 的 session 数（如 kimi）
  sessionsWithoutCost: number;     // cost_usd 为 NULL 的 session 数（如 codex、kimi）
}

export type SessionEventKind =
  | 'cleanup_started' | 'sigterm_sent' | 'sigkill_sent' | 'cleanup_failed'
  | 'terminate_requested' | 'process_exited' | 'terminated';

export interface SessionEvent {
  id: number;
  roomId: number;
  sessionSeq: number;
  kind: SessionEventKind;
  attemptId: string;
  detail: string | null;
  createdAt: string;
}

export type RoomStatus = Room['status'];
export type SessionOutcome = Session['outcome'];

export type MessageType =
  | 'fact' | 'hypothesis' | 'boundary' | 'open_question' | 'chain'
  | 'exploring' | 'propose_completion' | 'endorse' | 'challenge' | 'verify';

export interface Message {
  id: number;
  roomId: number;
  sessionSeq: number | null;
  authorId: string;
  type: MessageType | null;
  content: string;
  summary: string;
  targetMessageId: number | null;
  // 非空表示这条消息通过 @ 定向发给该 agent 实例（需求 3.3.2）；只有人类消息可能非空。
  targetAgentId: string | null;
  referencedMessageIds: number[];
  exploringStatus: 'active' | 'completed' | null;
  exploringNote: string | null;
  exploringEndReason: 'explicit' | 'superseded' | 'human_terminated' | null;
  exploringResultSummary: string | null;
  exploringResultMessageIds: number[];
  createdAt: string;
}

export interface InsertMessageParams {
  roomId: number;
  sessionSeq: number | null;
  authorId: string;
  content: string;
  type?: MessageType;
  targetMessageId?: number;
  targetAgentId?: string;
  referencedMessageIds?: number[];
  summary?: string;
}
