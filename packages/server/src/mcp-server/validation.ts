import type Database from 'better-sqlite3';
import { getRoom, getRoomAgents } from '../storage';

export class McpToolError extends Error {}

const RESERVED_AUTHOR_IDS: readonly string[] = ['human', 'system'];

export function assertRoomExists(db: Database.Database, roomId: number): void {
  if (!getRoom(db, roomId)) {
    throw new McpToolError(`room not found: ${roomId}`);
  }
}

export function assertNotReservedAuthor(authorId: string): void {
  if (RESERVED_AUTHOR_IDS.includes(authorId)) {
    throw new McpToolError(`authorId "${authorId}" is reserved and cannot be used by MCP tool callers`);
  }
}

export function resolveSessionBinding(db: Database.Database, roomId: number, authorId: string): number {
  const agent = getRoomAgents(db, roomId).find((a) => a.agentId === authorId);
  if (!agent || agent.state !== 'running' || agent.currentSessionSeq == null) {
    throw new McpToolError(`agent "${authorId}" is not in an active session for room ${roomId}`);
  }
  return agent.currentSessionSeq;
}
