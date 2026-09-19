import type Database from 'better-sqlite3';
import { getFirstMessage, getRecentRawMessages } from '../storage/messages';
import type { Message } from '../storage/types';
import { buildMemoryView } from './memoryView';
import type { OverviewPayload, MemorySummary } from './types';

const DEFAULT_RECENT_RAW_MESSAGES = 4;

function readRecentRawMessagesCount(): number {
  const raw = process.env.VIOLETDAGGER_RECENT_RAW_MESSAGES;
  if (raw == null || raw.trim() === '') return DEFAULT_RECENT_RAW_MESSAGES;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_RECENT_RAW_MESSAGES;
}

function summarize(m: Message): MemorySummary {
  return {
    id: m.id, type: m.type, summary: m.summary, targetMessageId: m.targetMessageId,
    referencedMessageIds: m.referencedMessageIds, exploringStatus: m.exploringStatus,
    exploringNote: m.exploringNote, exploringEndReason: m.exploringEndReason,
    exploringResultSummary: m.exploringResultSummary, exploringResultMessageIds: m.exploringResultMessageIds,
  };
}
export function buildOverview(db: Database.Database, roomId: number): OverviewPayload {
  const view = buildMemoryView(db, roomId);
  return {
    goal: getFirstMessage(db, roomId)?.content ?? '',
    facts: view.facts.map(summarize), boundaries: view.boundaries.map(summarize),
    openQuestions: view.openQuestions.map(summarize), chains: view.chains.map(summarize),
    hypotheses: view.hypotheses.map(summarize),
    activeExploring: view.exploring.filter(m => m.exploringStatus === 'active').map(m => ({ ...summarize(m), agentId: m.authorId })),
    completedExploring: view.exploring.filter(m => m.exploringStatus === 'completed').map(summarize),
    completionProposals: view.completionProposals.map(summarize),
    reactions: view.reactions.map(summarize), contextMessages: view.contextMessages.map(summarize),
    relations: view.relations, recentRawMessages: getRecentRawMessages(db, roomId, readRecentRawMessagesCount()),
    guidance: '以上是当前任务的进展情况，仅供参考，请形成你自己的判断——可以采纳、组合、推翻，也可以提出全新方案。',
  };
}
