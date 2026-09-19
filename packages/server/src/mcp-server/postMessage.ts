import type Database from 'better-sqlite3';
import type { EventEmitter } from 'node:events';
import { validateMessageRelations, insertMessage } from '../storage/messages';
import type { MessageType } from '../storage';
import { assertRoomExists, assertNotReservedAuthor, resolveSessionBinding, McpToolError } from './validation';

export interface PostMessageParams {
  roomId: number;
  authorId: string;
  content: string;
  type?: MessageType;
  targetMessageId?: number;
  referencedMessageIds?: number[];
  summary?: string;
}

export interface PostMessageDeps {
  db: Database.Database;
  roomEvents: EventEmitter;
  onSubstantiveMessagePosted: (roomId: number) => void;
  resetStuckCount: (roomId: number, agentId: string) => void;
}

export function createPostMessageHandler(deps: PostMessageDeps) {
  const { db, roomEvents, onSubstantiveMessagePosted, resetStuckCount } = deps;

  return function postMessage(params: PostMessageParams): { messageId: number } {
    assertRoomExists(db, params.roomId);
    assertNotReservedAuthor(params.authorId);
    const sessionSeq = resolveSessionBinding(db, params.roomId, params.authorId);

    try { validateMessageRelations(db, params.roomId, params); }
    catch (err) { throw new McpToolError((err as Error).message); }

    const { message, supersededExploringId } = insertMessage(db, {
      roomId: params.roomId,
      sessionSeq,
      authorId: params.authorId,
      content: params.content,
      type: params.type,
      targetMessageId: params.targetMessageId,
      referencedMessageIds: params.referencedMessageIds,
      summary: params.summary,
    });

    roomEvents.emit('message', { roomId: params.roomId, message });
    if (supersededExploringId != null) {
      roomEvents.emit('memoryUpdate', { roomId: params.roomId, messageId: supersededExploringId });
      resetStuckCount(params.roomId, params.authorId);
    }
    if (params.type != null) {
      onSubstantiveMessagePosted(params.roomId);
    }

    return { messageId: message.id };
  };
}
