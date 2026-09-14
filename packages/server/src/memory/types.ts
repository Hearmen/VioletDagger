import type { Message } from '../storage/types';

export interface OverviewPayload {
  goal: string;
  facts: { id: number; summary: string }[];
  boundaries: { id: number; summary: string }[];
  openQuestions: { id: number; summary: string }[];
  chains: { id: number; summary: string }[];
  hypotheses: { id: number; summary: string }[];
  activeExploring: { agentId: string; summary: string }[];
  recentRawMessages: Message[];
  guidance: string;
}

export interface MessageWithAnnotations extends Message {
  annotations: Message[];
}

export interface MemoryViewPayload {
  facts: Message[];
  boundaries: Message[];
  openQuestions: Message[];
  chains: Message[];
  hypotheses: Message[];
  exploring: Message[];
}
