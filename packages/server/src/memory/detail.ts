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
    // 消息 id 是 room 内编号，按 (roomId, messageId) 查即天然保证属于本 room。
    const message = getMessageById(db, roomId, params.messageId);
    if (!message) {
      throw new Error(`Message ${params.messageId} not found in room ${roomId}`);
    }
    return { ...message, annotations: getAnnotations(db, roomId, message.id) };
  }

  return getMessagesByType(db, roomId, params.type).map((message) => ({
    ...message,
    annotations: getAnnotations(db, roomId, message.id),
  }));
}
