import type { Message } from '../storage/types';

export type MemorySummary = Pick<Message, 'id' | 'type' | 'summary' | 'targetMessageId' | 'referencedMessageIds' | 'exploringStatus' | 'exploringNote' | 'exploringEndReason' | 'exploringResultSummary' | 'exploringResultMessageIds'>;
export interface MessageRelations {
  annotationIds: number[];
  answerIds: number[];
  referencedByIds: number[];
}
export interface OverviewPayload {
  goal: string;
  facts: MemorySummary[]; boundaries: MemorySummary[]; openQuestions: MemorySummary[];
  chains: MemorySummary[]; hypotheses: MemorySummary[];
  activeExploring: (MemorySummary & { agentId: string })[];
  completedExploring: MemorySummary[];
  completionProposals: MemorySummary[];
  reactions: MemorySummary[];
  contextMessages: MemorySummary[];
  relations: Record<number, MessageRelations>;
  recentRawMessages: Message[];
  guidance: string;
}
export interface MessageWithAnnotations extends Message {
  annotations: Message[];
  answers: Message[];
  referencedByIds: number[];
}
export interface MemoryViewPayload {
  facts: Message[]; boundaries: Message[]; openQuestions: Message[];
  chains: Message[]; hypotheses: Message[]; exploring: Message[];
  completionProposals: Message[]; reactions: Message[]; contextMessages: Message[];
  relations: Record<number, MessageRelations>;
}
export interface DetailParams {
  messageId?: number; type?: Message['type']; list?: boolean;
  targetMessageId?: number; beforeId?: number; limit?: number;
}
export interface DetailPage { messages: MessageWithAnnotations[]; nextCursor: number | null }
