import { readFileSync } from 'node:fs';
import type { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import {
  listMessages as storageListMessages,
  countSessions,
  listSessions,
  getMessagesBySession,
  getSession,
  getRoom,
  getRoomAgents,
  getActiveExploring,
  listSessionEvents,
  getUsageTotals,
} from '../storage';
import type { CloseReason, MessageType } from '../storage';
import { buildMemoryView } from '../memory';
import {
  submitMessage,
  SubmitMessageError,
  pauseRoom as orchestratorPauseRoom,
  resumeRoom as orchestratorResumeRoom,
  confirmCompletion as orchestratorConfirmCompletion,
  terminateAgentSession as orchestratorTerminateAgentSession,
  setAgentEnabled as orchestratorSetAgentEnabled,
  getStuckAgents,
  isDispatchIdle,
  type StopSessionProcess,
  type FailureCounter,
} from '../orchestrator-core';
import type { StartSession, StuckCounter } from '../orchestrator-core';
import { ApiError } from './rest';

export interface RpcDeps {
  db: Database.Database;
  roomId: number;
  roomEvents: EventEmitter;
  startSession: StartSession;
  stopSessionProcess: StopSessionProcess;
  stuckCounter: StuckCounter;
  failureCounter: FailureCounter;
}

export function createRpcHandlers(deps: RpcDeps): Record<string, (params?: any) => unknown> {
  const { db, roomId, startSession, stopSessionProcess, stuckCounter, failureCounter } = deps;

  return {
    listMessages(params?: { cursor?: number; limit?: number }) {
      return storageListMessages(db, roomId, params?.cursor, params?.limit);
    },

    // 直接交给核心 submitMessage（见 06-orchestrator-api.md §4、03-orchestrator-core.md §1.4）：
    // authorId 固定为 "human"，校验、首条消息规则、状态转换、派发全部在核心完成，这里不做任何特判。
    postHumanMessage(params: {
      content: string;
      type?: MessageType;
      targetMessageId?: number;
      referencedMessageIds?: number[];
      verifyVerdict?: boolean;
      closesQuestion?: boolean;
      chainResolution?: CloseReason;
      summary?: string;
      targetAgentId?: string;
    }) {
      try {
        const { message } = submitMessage(db, {
          roomId,
          author: { kind: 'human' },
          content: params?.content,
          type: params?.type,
          targetMessageId: params?.targetMessageId,
          referencedMessageIds: params?.referencedMessageIds,
          verifyVerdict: params?.verifyVerdict,
          closesQuestion: params?.closesQuestion,
          chainResolution: params?.chainResolution,
          summary: params?.summary,
          targetAgentId: params?.targetAgentId,
        }, startSession, stuckCounter);
        return { messageId: message.id };
      } catch (err) {
        if (err instanceof SubmitMessageError) throw new ApiError(err.message, 400);
        throw err;
      }
    },

    getMemoryView() {
      return buildMemoryView(db, roomId);
    },

    getRoomStatus() {
      const room = getRoom(db, roomId);
      if (!room) throw new ApiError(`room not found: ${roomId}`, 404);
      const stuckAgentIds = new Set(getStuckAgents(db, roomId, stuckCounter).map((a) => a.agentId));
      const activeExploring = getActiveExploring(db, roomId);
      const roomAgents = getRoomAgents(db, roomId);

      return {
        currentSessionCount: countSessions(db, roomId),
        status: room.status,
        dispatchIdle: isDispatchIdle(db, roomId),
        disabledAgentCount: roomAgents.filter((agent) => !agent.dispatchEnabled).length,
        agents: roomAgents.map((agent) => {
          const active = agent.state === 'running' || agent.state === 'stopping';
          const session =
            active && agent.currentSessionSeq != null
              ? getSession(db, roomId, agent.currentSessionSeq)
              : null;
          const exploring = activeExploring.find((m) => m.authorId === agent.agentId);
          const exitWarning = session
            ? listSessionEvents(db, roomId, session.seq).some((event) => event.kind === 'cleanup_failed')
              ? '清理未确认，可重试终止'
              : undefined
            : undefined;
          return {
            agentId: agent.agentId,
            state: agent.state,
            sessionId: active ? agent.currentSessionSeq ?? undefined : undefined,
            sessionStartedAt: session?.startedAt,
            stopIntent: session?.stopIntent ?? undefined,
            exitWarning,
            enabled: agent.dispatchEnabled,
            failureCount: failureCounter.get(roomId, agent.agentId),
            activeExploringSummary: exploring?.summary,
            stuck: stuckAgentIds.has(agent.agentId),
          };
        }),
      };
    },

    // 不再是节点树，只是一张 session 结果/时间的查表——供前端给每条消息的 session 标签
    // 追加 outcome（见 07-frontend.md §9）。消息本身由前端已持有的 listMessages/newMessage
    // 状态提供，不由本接口下发。
    getEventTree() {
      return {
        sessions: listSessions(db, roomId).map((session) => ({
          seq: session.seq,
          agentId: session.agentId,
          outcome: session.outcome,
          startedAt: session.startedAt,
          endedAt: session.endedAt,
          inputTokens: session.inputTokens,
          outputTokens: session.outputTokens,
          cacheReadTokens: session.cacheReadTokens,
          cacheWriteTokens: session.cacheWriteTokens,
          costUsd: session.costUsd,
        })),
      };
    },

    // 按 agent 和整个房间两级聚合用量（见 01-storage.md 的 getUsageTotals/UsageTotals）。
    getUsageSummary() {
      return getUsageTotals(db, roomId);
    },

    getSessionDetail(params: { sessionId: number }) {
      const session = getSession(db, roomId, params.sessionId);
      if (!session) throw new ApiError(`session not found: ${params.sessionId}`, 404);
      const rawLog = session.rawLogPath ? readFileSync(session.rawLogPath, 'utf-8') : '';
      const messages = getMessagesBySession(db, roomId, params.sessionId);
      return {
        sessionId: session.seq,
        agentId: session.agentId,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        outcome: session.outcome,
        messages,
        lifecycleEvents: listSessionEvents(db, roomId, params.sessionId),
        exitCode: session.exitCode,
        exitSignal: session.exitSignal,
        stopIntent: session.stopIntent,
        cleanupStartedAt: session.cleanupStartedAt,
        exitCause: session.exitCause,
        inputTokens: session.inputTokens,
        outputTokens: session.outputTokens,
        cacheReadTokens: session.cacheReadTokens,
        cacheWriteTokens: session.cacheWriteTokens,
        costUsd: session.costUsd,
        rawLog,
        wroteMessages: messages.length > 0,
      };
    },

    async terminateAgentSession(params: { sessionId: number }) {
      await orchestratorTerminateAgentSession(
        db, roomId, params.sessionId, stopSessionProcess, startSession, stuckCounter, failureCounter,
      );
      return { ok: true };
    },

    setAgentEnabled(params: { agentId: string; enabled: boolean }) {
      if (typeof params?.agentId !== 'string' || typeof params?.enabled !== 'boolean') {
        throw new ApiError('setAgentEnabled requires { agentId: string, enabled: boolean }', 400);
      }
      orchestratorSetAgentEnabled(
        db, roomId, params.agentId, params.enabled, startSession, stuckCounter, failureCounter,
      );
      return { ok: true };
    },

    pauseRoom() {
      orchestratorPauseRoom(db, roomId);
      return { ok: true };
    },

    resumeRoom(params?: { additionalSessions?: number }) {
      orchestratorResumeRoom(db, roomId, startSession, stuckCounter, params?.additionalSessions);
      return { ok: true };
    },

    confirmCompletion() {
      orchestratorConfirmCompletion(db, roomId);
      return { ok: true };
    },
  };
}
