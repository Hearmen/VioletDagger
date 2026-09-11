export interface Room {
  id: number;
  name: string;
  schedulingMode: 'sequential';
  status: 'active' | 'paused_limit' | 'paused_manual' | 'completed';
  maxSessions: number;
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
  agentId: string;
  joinOrder: number;
  state: 'idle' | 'running';
  currentSessionSeq: number | null;
}

export interface Session {
  roomId: number;
  seq: number;
  agentId: string;
  outcome: 'running' | 'completed' | 'passed' | 'error' | 'terminated';
  startedAt: string;
  endedAt: string | null;
  pgid: number | null;
  rawLogPath: string | null;
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
  referencedMessageIds: number[];
  exploringStatus: 'active' | 'completed' | null;
  exploringNote: string | null;
  createdAt: string;
}

export interface InsertMessageParams {
  roomId: number;
  sessionSeq: number | null;
  authorId: string;
  content: string;
  type?: MessageType;
  targetMessageId?: number;
  referencedMessageIds?: number[];
  summary?: string;
}
