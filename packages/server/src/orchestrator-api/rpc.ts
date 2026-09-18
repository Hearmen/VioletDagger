import { readFileSync } from 'node:fs';
import type { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import {
  listMessages as storageListMessages,
  insertMessage,
  getMessageById,
  countSessions,
  listSessions,
  getMessagesBySession,
  getSession,
  getRoom,
  getRoomAgents,
  getActiveExploring,
  listSessionEvents,
} from '../storage';
import type { MessageType } from '../storage';
import { buildMemoryView } from '../memory';
import {
  onSubstantiveMessagePosted,
  pauseRoom as orchestratorPauseRoom,
  resumeRoom as orchestratorResumeRoom,
  confirmCompletion as orchestratorConfirmCompletion,
  terminateAgentSession as orchestratorTerminateAgentSession,
  setAgentEnabled as orchestratorSetAgentEnabled,
  getStuckAgents,
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
  const { db, roomId, roomEvents, startSession, stopSessionProcess, stuckCounter, failureCounter } = deps;

  return {
    listMessages(params?: { cursor?: number; limit?: number }) {
      return storageListMessages(db, roomId, params?.cursor, params?.limit);
    },

    postHumanMessage(params: {
      content: string;
      type?: MessageType;
      targetMessageId?: number;
      referencedMessageIds?: number[];
    }) {
      // 消息 id 是 room 内编号，跨 room 引用会在 room 内查找不到（见 01-storage.md 第 2 节）。
      if (params.targetMessageId != null && !getMessageById(db, roomId, params.targetMessageId)) {
        throw new ApiError(`targetMessageId ${params.targetMessageId} not found in room ${roomId}`, 400);
      }
      if (params.referencedMessageIds?.length) {
        if (params.type !== 'chain') {
          throw new ApiError('referencedMessageIds is only allowed when type is "chain"', 400);
        }
        for (const refId of params.referencedMessageIds) {
          if (!getMessageById(db, roomId, refId)) {
            throw new ApiError(`referencedMessageIds contains ${refId} which is not found in room ${roomId}`, 400);
          }
        }
      }

      const { message, supersededExploringId } = insertMessage(db, {
        roomId,
        sessionSeq: null,
        authorId: 'human',
        content: params.content,
        type: params.type,
        targetMessageId: params.targetMessageId,
        referencedMessageIds: params.referencedMessageIds,
      });
      roomEvents.emit('message', { roomId, message });
      if (supersededExploringId != null) {
        roomEvents.emit('memoryUpdate', { roomId, messageId: supersededExploringId });
      }
      onSubstantiveMessagePosted(db, roomId, startSession, stuckCounter);
      return { messageId: message.id };
    },

    getMemoryView() {
      return buildMemoryView(db, roomId);
    },

    getRoomStatus() {
      const room = getRoom(db, roomId);
      if (!room) throw new ApiError(`room not found: ${roomId}`, 404);
      const stuckAgentIds = new Set(getStuckAgents(db, roomId, stuckCounter).map((a) => a.agentId));
      const activeExploring = getActiveExploring(db, roomId);

      return {
        currentSessionCount: countSessions(db, roomId),
        status: room.status,
        agents: getRoomAgents(db, roomId).map((agent) => {
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
        })),
      };
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
