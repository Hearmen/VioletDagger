import type Database from 'better-sqlite3';
import { getMessagesByType } from '../storage/messages';
import type { MemoryViewPayload } from './types';

export function buildMemoryView(db: Database.Database, roomId: number): MemoryViewPayload {
  return {
    facts: getMessagesByType(db, roomId, 'fact'),
    boundaries: getMessagesByType(db, roomId, 'boundary'),
    openQuestions: getMessagesByType(db, roomId, 'open_question'),
    chains: getMessagesByType(db, roomId, 'chain'),
    hypotheses: getMessagesByType(db, roomId, 'hypothesis'),
    exploring: getMessagesByType(db, roomId, 'exploring'),
  };
}
