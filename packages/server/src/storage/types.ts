export interface Room {
  id: number;
  name: string;
  schedulingMode: 'sequential';
  status: 'active' | 'paused_limit' | 'paused_manual' | 'completed';
  maxSessions: number;
  workdir: string;   // 绝对路径；空串表示按服务端默认目录解析（历史数据）
  dispatchPending: boolean;       // 房间标记（见 01-storage.md rooms.dispatch_pending）
  pendingAuthorId: string | null; // 标记作者（见 rooms.pending_author_id）
  createdAt: string;
  completedAt: string | null;     // 见 rooms.completed_at
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
  directedPending: boolean; // 定向标记（见 room_agents.directed_pending）
}

export type SessionExitCause =
  | 'natural' | 'managed-stop' | 'unexpected' | 'spawn-failed' | 'not-started';

export type DispatchScope = 'broadcast' | 'directed';
// 派发来源（见 01-storage.md sessions.dispatch_trigger），只用于分析报告，不参与调度。
export type DispatchTrigger = 'room_flag' | 'directed_flag' | 'continuation';

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
  dispatchTrigger: DispatchTrigger | null;
  nativeSessionId: string | null;
  nativeStorage: 'file' | 'database' | null;
  nativeOriginalPath: string | null;
  nativeCopyPath: string | null;
}

// 与 04-agent-invocation.md §6 SessionExitEvent.native 同形
export interface SessionNativeRef {
  sessionId: string | null;
  storage: 'file' | 'database' | null;
  originalPath: string | null;
  copyPath: string | null;
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
  sessionsWithoutTokens: number;   // 四个 token 字段全为 NULL 的 session 数（没有可读的原生会话）
  sessionsWithoutCost: number;     // cost_usd 为 NULL 的 session 数（原生会话没有费用，或没有可读的原生会话）
}

export type SessionEventKind =
  | 'cleanup_started' | 'sigterm_sent' | 'sigkill_sent' | 'cleanup_failed'
  | 'terminate_requested' | 'process_exited' | 'terminated' | 'native_session_failed';

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
  | 'exploring' | 'propose_completion' | 'challenge' | 'verify';

export const MESSAGE_TYPES: readonly MessageType[] = [
  'fact', 'hypothesis', 'boundary', 'open_question', 'chain',
  'exploring', 'propose_completion', 'challenge', 'verify',
];

export type QuestionStatus = 'OPEN' | 'CLOSED';
export type CloseReason = 'RESOLVED' | 'UNRESOLVED';
export type ChainStatus = 'CANDIDATE' | 'VERIFIED' | 'CHALLENGED' | 'REJECT';

export interface StateTransition {
  id: number;
  roomId: number;
  messageId: number;
  fromType: MessageType | null;
  toType: MessageType | null;
  fromStatus: string | null;
  toStatus: string | null;
  triggerMessageId: number;
  reason: string | null;
  createdAt: string;
}

export interface Message {
  id: number;                      // room 内自增，仅在本 room 内有意义
  roomId: number;
  sessionSeq: number | null;       // 人类消息为 null
  authorId: string;                // agent 实例标识，或 "human"/"system"
  type: MessageType | null;        // 当前 type
  content: string;
  summary: string;
  targetMessageId: number | null;
  targetAgentId: string | null;    // 非空表示这条消息通过 @ 定向发给该 agent，只有人类消息可能非空
  referencedMessageIds: number[];  // 从 message_references 联表得到
  questionStatus: QuestionStatus | null;       // 仅 open_question
  questionCloseReason: CloseReason | null;     // 仅 CLOSED 的 open_question
  questionClosedBy: number | null;             // 仅 CLOSED 的 open_question
  chainStatus: ChainStatus | null;             // 仅 chain
  closesQuestion: boolean;                     // 仅 chain 可能为 true
  chainResolution: CloseReason | null;         // 仅 closesQuestion 的 chain
  verifyVerdict: boolean | null;               // 仅 verify
  exploringStatus: 'active' | 'completed' | null;  // 仅 exploring
  exploringNote: string | null;
  exploringEndReason: 'explicit' | 'human_terminated' | null;
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
  verifyVerdict?: boolean;
  closesQuestion?: boolean;
  chainResolution?: CloseReason;
  summary?: string;
}
