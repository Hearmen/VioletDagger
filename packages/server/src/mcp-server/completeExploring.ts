import type Database from 'better-sqlite3';
import type { EventEmitter } from 'node:events';
import { getMessageById, completeExploring as markExploringCompleted } from '../storage';
import { assertRoomExists, assertNotReservedAuthor, resolveSessionBinding, McpToolError } from './validation';

export interface CompleteExploringParams {
  roomId: number;
  authorId: string;
  messageId: number;
}

export interface CompleteExploringDeps {
  db: Database.Database;
  roomEvents: EventEmitter;
  resetStuckCount: (roomId: number, agentId: string) => void;
}

export function createCompleteExploringHandler(deps: CompleteExploringDeps) {
  const { db, roomEvents, resetStuckCount } = deps;

  return function completeExploring(params: CompleteExploringParams): { ok: true } {
    assertRoomExists(db, params.roomId);
    assertNotReservedAuthor(params.authorId);
    resolveSessionBinding(db, params.roomId, params.authorId);

    const message = getMessageById(db, params.messageId);
    if (
      !message ||
      message.roomId !== params.roomId ||
      message.authorId !== params.authorId ||
      message.type !== 'exploring' ||
      message.exploringStatus !== 'active'
    ) {
      throw new McpToolError(
        `message ${params.messageId} is not an active exploring record owned by ${params.authorId}`,
      );
    }

    markExploringCompleted(db, params.messageId);
    roomEvents.emit('memoryUpdate', { roomId: params.roomId, messageId: params.messageId });
    resetStuckCount(params.roomId, params.authorId);

    return { ok: true };
  };
}
