// 编排器对外接口（06-orchestrator-api.md）返回形状中本模块用到的部分；字段定义见 01-storage.md、02、10。

export type MessageType =
  | 'fact' | 'hypothesis' | 'boundary' | 'open_question' | 'chain'
  | 'exploring' | 'propose_completion' | 'challenge' | 'verify';

export const MESSAGE_TYPES: readonly MessageType[] = [
  'fact', 'hypothesis', 'boundary', 'open_question', 'chain',
  'exploring', 'propose_completion', 'challenge', 'verify',
];

export type CloseReason = 'RESOLVED' | 'UNRESOLVED';

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
  questionStatus: 'OPEN' | 'CLOSED' | null;
  questionCloseReason: CloseReason | null;
  chainStatus: 'CANDIDATE' | 'VERIFIED' | 'CHALLENGED' | 'REJECT' | null;
  closesQuestion: boolean;
  chainResolution: CloseReason | null;
  verifyVerdict: boolean | null;
  exploringStatus: 'active' | 'completed' | null;
  createdAt: string;
}

export type RoomStatus = 'active' | 'paused_limit' | 'paused_manual' | 'completed';
export type SessionOutcome = 'running' | 'stopping' | 'completed' | 'passed' | 'error' | 'terminated';

export interface RoomSummary {
  id: number;
  name: string;
  status: RoomStatus;
  createdAt: string;
}

export interface Room extends RoomSummary {
  schedulingMode: 'parallel' | 'sequential';
  maxSessions: number;
  workdir: string;
  completedAt: string | null;
}

export interface AgentInfo {
  agentId: string;
  available: boolean;
  unavailableReason?: string;
}

export interface AgentStatus {
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
}

export interface RoomStatusPayload {
  currentSessionCount: number;
  status: RoomStatus;
  dispatchIdle: boolean;
  disabledAgentCount: number;
  nextTurnAgentId: string | null;
  agents: AgentStatus[];
}

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
}

export interface EventTreePayload {
  sessions: { seq: number; agentId: string; outcome: SessionOutcome }[];
  messages: Message[];
}

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

export type Ratio = number | null;

export interface ReportRow {
  agentId: string | null;
  sessions: {
    total: number;
    byOutcome: { completed: number; passed: number; error: number; terminated: number };
    completionRate: Ratio;
    errorRate: Ratio;
  };
  time: { totalExecMs: number | null };
  tokens: { total: number | null; cacheHitRate: Ratio };
  model: { steps: number | null };
  tools: { total: number | null; successRate: Ratio };
}

export interface RoomReport {
  roomId: number;
  runningSessions: number;
  room: ReportRow & { maxSessions: number; sessionsCreated: number };
  agents: ReportRow[];
}

export interface NativeDeleteFailure {
  seq: number;
  agentId: string;
  target: string;
  error: string;
}

export interface PostHumanMessageParams {
  content: string;
  type?: MessageType;
  targetMessageId?: number;
  referencedMessageIds?: number[];
  verifyVerdict?: boolean;
  closesQuestion?: boolean;
  chainResolution?: CloseReason;
  summary?: string;
  targetAgentId?: string;
}

export interface CreateRoomBody {
  name: string;
  agentIds: string[];
  schedulingMode: string;
  maxSessions?: number;
  workdir?: string;
}
