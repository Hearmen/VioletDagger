import type Database from 'better-sqlite3';
import { getFirstMessage, getRecentRawMessages } from '../storage/messages';
import type { Message, StateTransition } from '../storage/types';
import { buildRoomIndex, isQuestion, type RoomIndex } from './roomIndex';
import type {
  ChainOverview, ExploringOverview, KnowledgeOverview, MessageSummary, OverviewPayload, QuestionOverview,
  StateTransitionSummary,
} from './types';

const DEFAULT_RECENT_RAW_MESSAGES = 4;

export const OVERVIEW_GUIDANCE =
  '以上是当前任务的进展情况，仅供参考，请形成你自己的判断——可以采纳、组合、推翻，也可以提出全新方案。';

function readRecentRawMessagesCount(): number {
  const raw = process.env.VIOLETDAGGER_RECENT_RAW_MESSAGES;
  if (raw == null || raw.trim() === '') return DEFAULT_RECENT_RAW_MESSAGES;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_RECENT_RAW_MESSAGES;
}

// 摘要不含作者，只用 source 区分人类与 agent（系统占位消息的作者是 agent 实例标识，归为 agent）。
export function summarize(m: Message): MessageSummary {
  return {
    id: m.id,
    type: m.type,
    source: m.authorId === 'human' ? 'human' : 'agent',
    summary: m.summary,
    targetMessageId: m.targetMessageId,
    referencedMessageIds: m.referencedMessageIds,
    createdAt: m.createdAt,
  };
}

function summarizeTransition(t: StateTransition): StateTransitionSummary {
  return {
    fromType: t.fromType, toType: t.toType, fromStatus: t.fromStatus, toStatus: t.toStatus,
    triggerMessageId: t.triggerMessageId, createdAt: t.createdAt, reason: t.reason,
  };
}

// 按 id 顺序展开，找不到的 id 直接跳过（历史不伪造）。
function expandIds(index: RoomIndex, ids: number[]): MessageSummary[] {
  return ids.flatMap((id) => {
    const m = index.byId.get(id);
    return m ? [summarize(m)] : [];
  });
}

function reactions(index: RoomIndex, messageId: number, type: 'verify' | 'challenge'): MessageSummary[] {
  return (index.reactionsByTarget.get(messageId) ?? []).filter((m) => m.type === type).map(summarize);
}

function transitions(index: RoomIndex, messageId: number): StateTransitionSummary[] {
  return (index.transitionsByMessage.get(messageId) ?? []).map(summarizeTransition);
}

function knowledge(index: RoomIndex, m: Message): KnowledgeOverview {
  return {
    current: summarize(m),
    transitions: transitions(index, m.id),
    verifies: reactions(index, m.id, 'verify'),
    challenges: reactions(index, m.id, 'challenge'),
    references: expandIds(index, m.referencedMessageIds),
  };
}

function chain(index: RoomIndex, m: Message): ChainOverview {
  return {
    current: summarize(m),
    status: m.chainStatus ?? 'CANDIDATE',
    closesQuestion: m.closesQuestion,
    chainResolution: m.chainResolution,
    evidence: expandIds(index, m.referencedMessageIds),
    verifies: reactions(index, m.id, 'verify'),
    challenges: reactions(index, m.id, 'challenge'),
    transitions: transitions(index, m.id),
  };
}

function question(index: RoomIndex, q: Message): QuestionOverview {
  const answers = index.answersByQuestion.get(q.id) ?? [];
  const ofType = (type: Message['type']) => answers.filter((m) => m.type === type);
  return {
    question: summarize(q),
    status: q.questionStatus ?? 'OPEN',
    closeReason: q.questionCloseReason,
    hypotheses: ofType('hypothesis').map((m) => knowledge(index, m)),
    facts: ofType('fact').map((m) => knowledge(index, m)),
    boundaries: ofType('boundary').map((m) => knowledge(index, m)),
    chains: ofType('chain').map((m) => chain(index, m)),
  };
}

function exploring(index: RoomIndex, m: Message): ExploringOverview {
  const target = m.targetMessageId == null ? undefined : index.byId.get(m.targetMessageId);
  return {
    message: summarize(m),
    agentId: m.authorId,
    status: m.exploringStatus ?? 'active',
    target: target ? summarize(target) : null,
    resultSummary: m.exploringResultSummary,
    resultMessages: expandIds(index, m.exploringResultMessageIds),
  };
}

// 以 open_question 为聚合根组装概览（见 02-memory-management.md §3）；状态直接取列值，不从关系推断。
export function buildOverview(db: Database.Database, roomId: number): OverviewPayload {
  const goal = getFirstMessage(db, roomId);
  if (!goal) throw new Error('room has no goal yet');
  const index = buildRoomIndex(db, roomId);
  const goalMessage = index.byId.get(goal.id)!;

  const knowledgeTypes = new Set(['hypothesis', 'fact', 'boundary']);
  return {
    goal: question(index, goalMessage),
    questions: index.messages
      .filter((m) => m.type === 'open_question' && m.id !== goal.id)
      .map((m) => question(index, m)),
    unattachedKnowledge: index.messages
      .filter((m) => knowledgeTypes.has(m.type ?? '')
        && (m.targetMessageId == null || !isQuestion(index.byId.get(m.targetMessageId))))
      .map((m) => knowledge(index, m)),
    activeExploring: index.messages
      .filter((m) => m.type === 'exploring' && m.exploringStatus === 'active')
      .map((m) => exploring(index, m)),
    completedExploring: index.messages
      .filter((m) => m.type === 'exploring' && m.exploringStatus === 'completed')
      .map((m) => exploring(index, m)),
    completionProposals: index.messages.filter((m) => m.type === 'propose_completion').map(summarize),
    recentRawMessages: getRecentRawMessages(db, roomId, readRecentRawMessagesCount()).map(summarize),
    guidance: OVERVIEW_GUIDANCE,
  };
}
