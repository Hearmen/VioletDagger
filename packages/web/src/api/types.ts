export type MessageType =
  | 'fact' | 'hypothesis' | 'boundary' | 'open_question' | 'chain'
  | 'exploring' | 'propose_completion' | 'challenge' | 'verify';

export type QuestionStatus = 'OPEN' | 'CLOSED';
export type CloseReason = 'RESOLVED' | 'UNRESOLVED';
export type ChainStatus = 'CANDIDATE' | 'VERIFIED' | 'CHALLENGED' | 'REJECT';

// Scheduler 对已有消息 type/状态的一次转换记录（见 01-storage.md state_transition_log）。
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
  id: number;
  roomId: number;
  sessionSeq: number | null;
  authorId: string;
  type: MessageType | null;
  content: string;
  summary: string;
  targetMessageId: number | null;
  targetAgentId: string | null;
  referencedMessageIds: number[];
  questionStatus: QuestionStatus | null;
  questionCloseReason: CloseReason | null;
  questionClosedBy: number | null;
  chainStatus: ChainStatus | null;
  closesQuestion: boolean;
  chainResolution: CloseReason | null;
  verifyVerdict: boolean | null;
  exploringStatus: 'active' | 'completed' | null;
  exploringNote: string | null;
  exploringEndReason: 'explicit' | 'human_terminated' | null;
  exploringResultSummary: string | null;
  exploringResultMessageIds: number[];
  createdAt: string;
}

export type SessionOutcome = 'running' | 'stopping' | 'completed' | 'passed' | 'error' | 'terminated';

export type SessionExitCause =
  | 'natural' | 'managed-stop' | 'unexpected' | 'spawn-failed' | 'not-started';

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

export type LogStream = 'stdout' | 'stderr';

export interface LogChunk {
  offset: number;
  stream: LogStream;
  text: string;
}

export type SessionLogFrame =
  | { type: 'ready'; source: 'live' | 'snapshot'; truncated: boolean }
  | { type: 'data'; offset: number; stream: LogStream; text: string }
  | { type: 'end'; reason: 'process-exited' | 'snapshot-complete'; exitCode: number | null }
  | { type: 'error'; message: string };

export type RoomStatus = 'active' | 'paused_limit' | 'paused_manual' | 'completed';

export interface AgentInfo {
  agentId: string;
  available: boolean;
  unavailableReason?: string;
}

export interface Room {
  id: number;
  name: string;
  schedulingMode: 'sequential';
  status: RoomStatus;
  maxSessions: number;
  workdir: string;
  createdAt: string;
}

export interface RoomSummary {
  id: number;
  name: string;
  status: RoomStatus;
  createdAt: string;
}

// 见 02-memory-management.md §5：按当前 type 分组的全文，每条只出现在一组。
export interface MemoryViewPayload {
  goalMessageId: number | null;
  openQuestions: Message[];
  hypotheses: Message[];
  facts: Message[];
  boundaries: Message[];
  chains: Message[];
  exploring: Message[];
  completionProposals: Message[];
  challenges: Message[];
  verifies: Message[];
  transitions: Record<number, StateTransition[]>;
}

export interface RoomStatusPayload {
  currentSessionCount: number;
  status: RoomStatus;
  dispatchIdle: boolean;        // 无任务派发提醒（06 §4、03 §1.6）
  disabledAgentCount: number;
  agents: {
    agentId: string;
    state: 'idle' | 'running' | 'stopping';
    sessionId?: number;
    sessionStartedAt?: string;
    stopIntent?: 'terminate';
    exitWarning?: string;
    enabled: boolean;
    failureCount: number;
    activeExploringSummary?: string;
    stuck?: boolean;
  }[];
}

// 不再是节点树，只是一张 session 结果/时间的查表——供 EventTreePanel 给每条消息的
// session 标签追加 outcome。消息本身来自已加载的 messages 状态，不在这里下发。
export interface EventTreePayload {
  sessions: {
    seq: number;
    agentId: string;
    outcome: SessionOutcome;
    startedAt: string;
    endedAt: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    costUsd: number | null;
  }[];
}

export interface SessionDetailPayload {
  sessionId: number;
  agentId: string;
  startedAt: string;
  endedAt: string | null;
  outcome: SessionOutcome;
  messages: Message[];
  lifecycleEvents: SessionEvent[];
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
  rawLog: string;
  wroteMessages: boolean;
}

// 见 01-storage.md 的 UsageTotals：sessionsWithoutTokens/sessionsWithoutCost 让前端能诚实标"不完整"，
// 而不是让 NULL 被当成 0 悄悄拉低总量。
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  sessionCount: number;
  sessionsWithoutTokens: number;
  sessionsWithoutCost: number;
}

export interface UsageSummaryPayload {
  byAgent: Record<string, UsageTotals>;
  room: UsageTotals;
}

// postHumanMessage 的请求体（见 06-orchestrator-api.md §4）；referencedMessageIds/summary 人类 UI 不产生。
export interface HumanMessageParams {
  content: string;
  type?: MessageType;
  targetMessageId?: number;
  verifyVerdict?: boolean;
  closesQuestion?: boolean;
  chainResolution?: CloseReason;
  targetAgentId?: string;
}
