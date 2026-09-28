import type {
  ChainStatus, CloseReason, Message, MessageType, QuestionStatus, StateTransition,
} from '../storage/types';

// ---- 概览（给 agent 的摘要/索引，见 02-memory-management.md §3）----

export interface MessageSummary {
  id: number;
  type: MessageType | null;                  // 当前 type；无 type 的聊天为 null
  source: 'human' | 'agent';
  summary: string;
  targetMessageId: number | null;
  referencedMessageIds: number[];
  createdAt: string;
}

export interface StateTransitionSummary {
  fromType: string | null;
  toType: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  triggerMessageId: number;
  createdAt: string;
  reason: string | null;
}

export interface KnowledgeOverview {
  current: MessageSummary;                   // 当前 type：hypothesis/fact/boundary
  transitions: StateTransitionSummary[];
  verifies: MessageSummary[];
  challenges: MessageSummary[];
  references: MessageSummary[];              // referencedMessageIds 展开的依据
}

export interface ChainOverview {
  current: MessageSummary;
  status: ChainStatus;
  closesQuestion: boolean;
  chainResolution: CloseReason | null;
  evidence: MessageSummary[];                // referencedMessageIds 展开的依据
  verifies: MessageSummary[];
  challenges: MessageSummary[];
  transitions: StateTransitionSummary[];
}

export interface QuestionOverview {
  question: MessageSummary;
  status: QuestionStatus;
  closeReason: CloseReason | null;
  hypotheses: KnowledgeOverview[];
  facts: KnowledgeOverview[];
  boundaries: KnowledgeOverview[];
  chains: ChainOverview[];
}

export interface ExploringOverview {
  message: MessageSummary;
  agentId: string;
  status: 'active' | 'completed';
  // 指向的 open_question 或 hypothesis；写入校验保证存在，找不到时按"历史不伪造"为 null。
  target: MessageSummary | null;
  resultSummary: string | null;              // complete_exploring 写入的结果摘要
  resultMessages: MessageSummary[];
}

export interface OverviewPayload {
  goal: QuestionOverview;                    // 房间首条 open_question 即 goal
  questions: QuestionOverview[];             // goal 之外的全部 open_question，按 id 升序
  unattachedKnowledge: KnowledgeOverview[];  // 未指向任何问题的 fact/boundary，及其经 challenge 转成的 hypothesis
  activeExploring: ExploringOverview[];
  completedExploring: ExploringOverview[];
  completionProposals: MessageSummary[];
  recentRawMessages: MessageSummary[];       // 最近若干条不分类型的原始消息，默认 4 条
  guidance: string;                          // 固定引导语
}

// ---- 详情（给 agent 的全文，见 02 §4）----

export interface DetailParams {
  messageId?: number;
  type?: MessageType;
  list?: boolean;
  targetMessageId?: number;
  beforeId?: number;
  limit?: number;
}

export interface MessageWithAnnotations extends Message {
  annotations: Message[];         // 指向它的 challenge/verify 全文
  answers: Message[];             // 它是 open_question 时，回答它的 hypothesis/fact/boundary/chain 全文
  referencedByIds: number[];
  transitions: StateTransition[]; // 它自己的 type/状态转换历史
}

export interface DetailPage { messages: MessageWithAnnotations[]; nextCursor: number | null }

// ---- 记忆视图（给前端的全文，见 02 §5）----

export interface MemoryViewPayload {
  goalMessageId: number | null;             // 房间首条消息 id；房间为空时为 null
  openQuestions: Message[];                 // 含 goal，前端据 goalMessageId 单独标出
  hypotheses: Message[];
  facts: Message[];
  boundaries: Message[];
  chains: Message[];
  exploring: Message[];                     // 全部，不分 active/completed
  completionProposals: Message[];
  challenges: Message[];
  verifies: Message[];
  transitions: Record<number, StateTransition[]>; // messageId → 转换历史，只包含有转换的消息
}
