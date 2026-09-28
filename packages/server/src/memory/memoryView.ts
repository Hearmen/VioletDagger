import type Database from 'better-sqlite3';
import type { Message, MessageType, StateTransition } from '../storage/types';
import { buildRoomIndex } from './roomIndex';
import type { MemoryViewPayload } from './types';

// 前端记忆面板的全文数据（见 02-memory-management.md §5）：按当前 type 分组，每条只出现在一组。
export function buildMemoryView(db: Database.Database, roomId: number): MemoryViewPayload {
  const index = buildRoomIndex(db, roomId);
  const ofType = (type: MessageType): Message[] => index.messages.filter((m) => m.type === type);
  const transitions: Record<number, StateTransition[]> = {};
  for (const [messageId, list] of index.transitionsByMessage) transitions[messageId] = list;
  return {
    goalMessageId: index.messages[0]?.id ?? null,
    openQuestions: ofType('open_question'),
    hypotheses: ofType('hypothesis'),
    facts: ofType('fact'),
    boundaries: ofType('boundary'),
    chains: ofType('chain'),
    exploring: ofType('exploring'),
    completionProposals: ofType('propose_completion'),
    challenges: ofType('challenge'),
    verifies: ofType('verify'),
    transitions,
  };
}
