import type Database from 'better-sqlite3';
import {
  getFirstMessage, getMessagesByType, getActiveExploring, getRecentRawMessages,
} from '../storage/messages';
import type { OverviewPayload } from './types';

const RECENT_RAW_MESSAGES_COUNT = 4;
const GUIDANCE_TEXT =
  '以上是聊天室的既有记忆，仅供参考，请形成你自己的判断——可以采纳、组合、推翻，也可以提出全新方案。';

function toSummaryList(messages: { id: number; summary: string }[]) {
  return messages.map((m) => ({ id: m.id, summary: m.summary }));
}

export function buildOverview(db: Database.Database, roomId: number): OverviewPayload {
  const first = getFirstMessage(db, roomId);
  return {
    goal: first?.content ?? '',
    facts: toSummaryList(getMessagesByType(db, roomId, 'fact')),
    boundaries: toSummaryList(getMessagesByType(db, roomId, 'boundary')),
    openQuestions: toSummaryList(getMessagesByType(db, roomId, 'open_question')),
    chains: toSummaryList(getMessagesByType(db, roomId, 'chain')),
    hypotheses: toSummaryList(getMessagesByType(db, roomId, 'hypothesis')),
    activeExploring: getActiveExploring(db, roomId).map((m) => ({
      agentId: m.authorId,
      summary: m.summary,
    })),
    recentRawMessages: getRecentRawMessages(db, roomId, RECENT_RAW_MESSAGES_COUNT),
    guidance: GUIDANCE_TEXT,
  };
}
