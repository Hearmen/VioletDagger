import type Database from 'better-sqlite3';
import { getMessageById, getMessagesByType, getAnnotations } from '../storage/messages';
import type { MessageType } from '../storage/types';
import type { MessageWithAnnotations } from './types';

export function buildDetail(
  db: Database.Database,
  roomId: number,
  params: { messageId: number } | { type: MessageType },
): MessageWithAnnotations | MessageWithAnnotations[] {
  if ('messageId' in params) {
    const message = getMessageById(db, params.messageId);
    if (!message || message.roomId !== roomId) {
      throw new Error(`Message ${params.messageId} not found in room ${roomId}`);
    }
    return { ...message, annotations: getAnnotations(db, message.id) };
  }

  return getMessagesByType(db, roomId, params.type).map((message) => ({
    ...message,
    annotations: getAnnotations(db, message.id),
  }));
}
