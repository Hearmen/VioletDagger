import type Database from 'better-sqlite3';
import { getRoomAgents } from '../storage';

// 连续失败计数（内存，重启归零，与 stuckCount 同类），达到阈值后核心把 agent 的 dispatch_enabled 置为 0。
export interface FailureCounter {
  increment(roomId: number, agentId: string): number;
  reset(roomId: number, agentId: string): void;
  get(roomId: number, agentId: string): number;
}

export const FAILURE_THRESHOLD = 3;

export function createFailureCounter(): FailureCounter {
  const counts = new Map<string, number>();
  const key = (roomId: number, agentId: string) => `${roomId}:${agentId}`;

  return {
    increment(roomId, agentId) {
      const k = key(roomId, agentId);
      const next = (counts.get(k) ?? 0) + 1;
      counts.set(k, next);
      return next;
    },
    reset(roomId, agentId) {
      counts.delete(key(roomId, agentId));
    },
    get(roomId, agentId) {
      return counts.get(key(roomId, agentId)) ?? 0;
    },
  };
}

export function getAgentFailures(
  db: Database.Database,
  roomId: number,
  failureCounter: FailureCounter,
): { agentId: string; failureCount: number }[] {
  return getRoomAgents(db, roomId).map((agent) => ({
    agentId: agent.agentId,
    failureCount: failureCounter.get(roomId, agent.agentId),
  }));
}
