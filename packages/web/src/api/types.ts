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
  referencedMessageIds: number[];
  exploringStatus: 'active' | 'completed' | null;
  exploringNote: string | null;
  createdAt: string;
}

export type RoomStatus = 'active' | 'paused_limit' | 'paused_manual' | 'completed';

export interface Room {
  id: number;
  name: string;
  schedulingMode: 'sequential';
  status: RoomStatus;
  maxSessions: number;
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
}

export interface RoomStatusPayload {
  currentSessionCount: number;
  status: RoomStatus;
  agents: {
    agentId: string;
    state: 'idle' | 'running';
    sessionId?: number;
    sessionStartedAt?: string;
    activeExploringSummary?: string;
    stuck?: boolean;
  }[];
}

export type SessionOutcome = 'running' | 'completed' | 'passed' | 'error' | 'terminated';

export interface EventTreePayload {
  sessions: {
    seq: number;
    agentId: string;
    outcome: SessionOutcome;
    startedAt: string;
    endedAt: string | null;
    messages: Message[];
  }[];
}

export interface SessionDetailPayload {
  agentId: string;
  startedAt: string;
  endedAt: string | null;
  outcome: SessionOutcome;
  rawLog: string;
  wroteMessages: boolean;
}
