import type Database from 'better-sqlite3';
import type { EventEmitter } from 'node:events';
import { getMessageById, insertMessage } from '../storage';
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

const REACTION_TYPES: MessageType[] = ['endorse', 'challenge', 'verify'];

export function createPostMessageHandler(deps: PostMessageDeps) {
  const { db, roomEvents, onSubstantiveMessagePosted, resetStuckCount } = deps;

  return function postMessage(params: PostMessageParams): { messageId: number } {
    assertRoomExists(db, params.roomId);
    assertNotReservedAuthor(params.authorId);
    const sessionSeq = resolveSessionBinding(db, params.roomId, params.authorId);

    if (params.type && REACTION_TYPES.includes(params.type) && params.targetMessageId == null) {
      throw new McpToolError(`targetMessageId is required for type "${params.type}"`);
    }
    if (params.targetMessageId != null) {
      const target = getMessageById(db, params.roomId, params.targetMessageId);
      if (!target) {
        throw new McpToolError(`targetMessageId ${params.targetMessageId} not found in room ${params.roomId}`);
      }
    }
    if (params.referencedMessageIds?.length) {
      if (params.type !== 'chain') {
        throw new McpToolError('referencedMessageIds is only allowed when type is "chain"');
      }
      for (const refId of params.referencedMessageIds) {
        const ref = getMessageById(db, params.roomId, refId);
        if (!ref) {
          throw new McpToolError(`referencedMessageIds contains ${refId} which is not found in room ${params.roomId}`);
        }
      }
    }

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
