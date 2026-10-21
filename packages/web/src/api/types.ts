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
  | 'cleanup_started' | 'sigterm_sent' | 'sigkill_sent' | 'cleanup_failed' | 'native_session_failed'
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

// 调度模式（需求 3.3、3.3.3）。
export type SchedulingMode = 'parallel' | 'sequential';

export interface Room {
  id: number;
  name: string;
  schedulingMode: SchedulingMode;
  status: RoomStatus;
  maxSessions: number;
  workdir: string;
  createdAt: string;
  completedAt: string | null;
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
  nextTurnAgentId: string | null; // sequential 房间的下一位（06 §4、03 §1.7）；parallel 房间恒为 null
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

// 事件树数据源（07-frontend.md §9）：session 结果/时间查表 + 房间全部消息（按 id 升序，不分页）。
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
  messages: Message[];
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

// DELETE /api/rooms/:id 的原件未删除列表（06-orchestrator-api.md §1、04-agent-invocation.md §7.1）。
export interface NativeDeleteFailure {
  seq: number;
  agentId: string;
  target: string;
  error: string;
}

// getRoomReport 的返回（10-room-report.md §2）：比率为 0~1，缺数据为 null。
export type Ratio = number | null;

export interface DurationStats {
  mean: number | null;
  median: number | null;
  p90: number | null;
  max: number | null;
  maxSeq: number | null;
}

export interface ReportRow {
  agentId: string | null;
  registryKey: string | null;
  sessions: {
    total: number;
    byOutcome: { completed: number; passed: number; error: number; terminated: number };
    completionRate: Ratio;
    passRate: Ratio;
    errorRate: Ratio;
    byTrigger: { room_flag: number; directed_flag: number; continuation: number; turn: number; unknown: number };
  };
  time: { totalExecMs: number | null; exec: DurationStats };
  tokens: {
    input: number | null;
    output: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
    total: number | null;
    shareOfRoom: Ratio;
    cacheHitRate: Ratio;
    perSession: number | null;
    perCompletedSession: number | null;
    perStep: number | null;
    outputPerSecond: number | null;
    missingSessions: number;
  };
  model: {
    steps: number | null;
    stepsPerSession: number | null;
    firstResponse: { mean: number | null; median: number | null; missingSessions: number };
    missingSessions: number;
  };
  tools: {
    total: number | null;
    perSession: number | null;
    perStep: number | null;
    failed: number | null;
    successRate: Ratio;
    unknownOutcomeCalls: number;
    missingSessions: number;
  };
}

export interface ToolNameCount {
  name: string;
  isRoomMcp: boolean;
  count: number;
  failed: number | null;
}

export interface RoomReport {
  roomId: number;
  generatedAt: string;
  runningSessions: number;
  room: ReportRow & {
    maxSessions: number;
    sessionsCreated: number;
    sessionUsageRate: Ratio;
    roomDurationMs: number | null;
  };
  agents: ReportRow[];
  toolNames: { room: ToolNameCount[]; byAgent: Record<string, ToolNameCount[]> };
}
