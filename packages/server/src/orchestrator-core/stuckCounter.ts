import type Database from 'better-sqlite3';
import { getActiveExploring, getRoomAgents } from '../storage';

export interface StuckCounter {
  increment(roomId: number, agentId: string): void;
  reset(roomId: number, agentId: string): void;
  get(roomId: number, agentId: string): number;
}

const STUCK_THRESHOLD = 3;

export function createStuckCounter(): StuckCounter {
  const counts = new Map<string, number>();
  const key = (roomId: number, agentId: string) => `${roomId}:${agentId}`;

  return {
    increment(roomId, agentId) {
      const k = key(roomId, agentId);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    },
    reset(roomId, agentId) {
      counts.delete(key(roomId, agentId));
    },
    get(roomId, agentId) {
      return counts.get(key(roomId, agentId)) ?? 0;
    },
  };
}

export function getStuckAgents(
  db: Database.Database,
  roomId: number,
  stuckCounter: StuckCounter,
): { agentId: string; stuckCount: number }[] {
  const activeExploringAgentIds = new Set(getActiveExploring(db, roomId).map((m) => m.authorId));
  return getRoomAgents(db, roomId)
    .filter((a) => activeExploringAgentIds.has(a.agentId))
    .map((a) => ({ agentId: a.agentId, stuckCount: stuckCounter.get(roomId, a.agentId) }))
    .filter((a) => a.stuckCount >= STUCK_THRESHOLD);
}
