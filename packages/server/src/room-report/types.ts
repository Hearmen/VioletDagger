import type { DispatchTrigger } from '../storage';
import type { NativeToolCall } from '../agent-invocation';
import type { DurationStats, Ratio } from './stats';

// 对外类型（10-room-report.md §2）。
export type { DurationStats, Ratio };

export interface ReportRow {
  agentId: string | null;     // null 表示房间合计行
  registryKey: string | null; // 合计行为 null
  sessions: {
    total: number;
    byOutcome: { completed: number; passed: number; error: number; terminated: number };
    completionRate: Ratio;
    passRate: Ratio;
    errorRate: Ratio;
    byTrigger: { room_flag: number; directed_flag: number; continuation: number; unknown: number };
  };
  time: {
    totalExecMs: number | null;
    exec: DurationStats;
  };
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
  toolNames: {
    room: ToolNameCount[];
    byAgent: Record<string, ToolNameCount[]>;
  };
}

// 第 3 节第 5 步形成的单个已结束 session 记录。
export interface SessionRecord {
  seq: number;
  agentId: string;
  outcome: 'completed' | 'passed' | 'error' | 'terminated';
  trigger: DispatchTrigger | null;
  execMs: number;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  steps: number | null;
  firstResponseMs: number | null;
  toolCalls: NativeToolCall[] | null;
}

export class RoomNotFoundError extends Error {
  constructor(roomId: number) {
    super(`Room ${roomId} not found`);
    this.name = 'RoomNotFoundError';
  }
}
