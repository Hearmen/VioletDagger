import type Database from 'better-sqlite3';
import { getRoomMessages } from '../storage/messages';
import type { Message } from '../storage/types';
import type { MemoryViewPayload, MessageRelations } from './types';

export function buildMemoryView(db: Database.Database, roomId: number): MemoryViewPayload {
  return projectMemory(getRoomMessages(db, roomId));
}

export function projectMemory(messages: Message[]): MemoryViewPayload {
  const byId = new Map(messages.map(m => [m.id, m]));
  const relations: Record<number, MessageRelations> = {};
  const contextIds = new Set<number>();
  for (const m of messages) relations[m.id] = { annotationIds: [], answerIds: [], referencedByIds: [] };
  for (const m of messages) {
    const target = m.targetMessageId == null ? undefined : byId.get(m.targetMessageId);
    if (target) {
      if (['endorse', 'challenge', 'verify', 'open_question'].includes(m.type ?? '')) relations[target.id].annotationIds.push(m.id);
      if (target.type === 'open_question' && ['hypothesis', 'fact'].includes(m.type ?? '')) relations[target.id].answerIds.push(m.id);
    }
    for (const id of m.referencedMessageIds) relations[id]?.referencedByIds.push(m.id);
    if (m.type) {
      for (const id of [m.targetMessageId, ...m.referencedMessageIds, ...m.exploringResultMessageIds]) {
        if (id != null && byId.get(id)?.type === null) contextIds.add(id);
      }
    }
  }
  const ofType = (type: Message['type']) => messages.filter(m => m.type === type);
  return {
    facts: ofType('fact'), boundaries: ofType('boundary'), openQuestions: ofType('open_question'),
    chains: ofType('chain'), hypotheses: ofType('hypothesis'), exploring: ofType('exploring'),
    completionProposals: ofType('propose_completion'),
    reactions: messages.filter(m => ['endorse', 'challenge', 'verify'].includes(m.type ?? '')),
    contextMessages: messages.filter(m => contextIds.has(m.id)), relations,
  };
}
