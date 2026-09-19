import type Database from 'better-sqlite3';
import { getRoomMessages } from '../storage/messages';
import { projectMemory } from './memoryView';
import type { DetailParams, DetailPage, MessageWithAnnotations } from './types';

export function buildDetail(db: Database.Database, roomId: number, params: DetailParams): MessageWithAnnotations | MessageWithAnnotations[] | DetailPage {
  const hasId = params.messageId != null;
  const paged = params.list === true;
  if (hasId && (params.type != null || params.list !== undefined || params.targetMessageId != null || params.beforeId != null || params.limit != null)) throw new Error('messageId cannot be combined with list filters');
  if (!hasId && !paged && (params.type == null || params.targetMessageId != null || params.beforeId != null || params.limit != null)) throw new Error('get_detail requires messageId, type, or list:true');
  for (const value of [params.messageId, params.targetMessageId, params.beforeId]) {
    if (value != null && (!Number.isInteger(value) || value <= 0)) throw new Error('message IDs must be positive integers');
  }
  const limit = params.limit ?? 30;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be between 1 and 100');
  const messages = getRoomMessages(db, roomId);
  const byId = new Map(messages.map(m => [m.id, m]));
  const { relations } = projectMemory(messages);
  const expand = (m: typeof messages[number]): MessageWithAnnotations => ({
    ...m, annotations: relations[m.id].annotationIds.map(id => byId.get(id)!),
    answers: relations[m.id].answerIds.map(id => byId.get(id)!),
    referencedByIds: relations[m.id].referencedByIds,
  });
  if (hasId) {
    const message = byId.get(params.messageId!);
    if (!message) throw new Error(`Message ${params.messageId} not found in room ${roomId}`);
    return expand(message);
  }
  let matches = messages.filter(m => (params.type == null || m.type === params.type) &&
    (params.targetMessageId == null || m.targetMessageId === params.targetMessageId) &&
    (params.beforeId == null || m.id < params.beforeId));
  if (!paged) return matches.map(expand);
  const hasMore = matches.length > limit;
  matches = matches.slice(-limit);
  return { messages: matches.map(expand), nextCursor: hasMore ? matches[0].id : null };
}
