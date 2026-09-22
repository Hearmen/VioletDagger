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
  targetAgentId: string | null;
  referencedMessageIds: number[];
  exploringStatus: 'active' | 'completed' | null;
  exploringNote: string | null;
  exploringEndReason: 'explicit' | 'superseded' | 'human_terminated' | null;
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
  completionReason: 'manual' | 'auto_silence' | null;
  completionReferenceMessageId: number | null;
  maxSessions: number;
  workdir: string;
  autoConfirmOnSilence: boolean;
  createdAt: string;
}

export interface RoomSummary {
  id: number;
  name: string;
  status: RoomStatus;
  createdAt: string;
}

export interface MemoryViewPayload {
  facts: Message[];
  boundaries: Message[];
  openQuestions: Message[];
  chains: Message[];
  hypotheses: Message[];
  exploring: Message[];
  completionProposals: Message[];
  reactions: Message[];
  contextMessages: Message[];
  relations: Record<number, { annotationIds: number[]; answerIds: number[]; referencedByIds: number[] }>;
}

export interface RoomStatusPayload {
  currentSessionCount: number;
  status: RoomStatus;
  completionReason?: 'manual' | 'auto_silence';
  completionReferenceMessageId?: number;
  allCaughtUp: boolean;
  agents: {
    agentId: string;
    state: 'idle' | 'running' | 'stopping';
    caughtUp: boolean;
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
