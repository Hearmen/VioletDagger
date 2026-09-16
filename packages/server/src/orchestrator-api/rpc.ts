import { readFileSync } from 'node:fs';
import type { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import {
  listMessages as storageListMessages,
  insertMessage,
  countSessions,
  listSessions,
  getMessagesBySession,
  getSession,
  getRoom,
  getRoomAgents,
  getActiveExploring,
} from '../storage';
import type { MessageType } from '../storage';
import { buildMemoryView } from '../memory';
import {
  onSubstantiveMessagePosted,
  pauseRoom as orchestratorPauseRoom,
  resumeRoom as orchestratorResumeRoom,
  confirmCompletion as orchestratorConfirmCompletion,
  terminateAgentSession as orchestratorTerminateAgentSession,
  getStuckAgents,
} from '../orchestrator-core';
import type { StartSession, StuckCounter } from '../orchestrator-core';
import type { KillSession } from '../agent-invocation';
import { ApiError } from './rest';

export interface RpcDeps {
  db: Database.Database;
  roomId: number;
  roomEvents: EventEmitter;
  startSession: StartSession;
  killSession: KillSession;
  stuckCounter: StuckCounter;
}

export function createRpcHandlers(deps: RpcDeps): Record<string, (params?: any) => unknown> {
  const { db, roomId, roomEvents, startSession, killSession, stuckCounter } = deps;

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
          const session =
            agent.state === 'running' && agent.currentSessionSeq != null
              ? getSession(db, roomId, agent.currentSessionSeq)
              : null;
          const exploring = activeExploring.find((m) => m.authorId === agent.agentId);
          return {
            agentId: agent.agentId,
            state: agent.state,
            sessionId: agent.state === 'running' ? agent.currentSessionSeq ?? undefined : undefined,
            sessionStartedAt: session?.startedAt,
            activeExploringSummary: exploring?.summary,
            stuck: stuckAgentIds.has(agent.agentId),
          };
        }),
      };
    },

    getEventTree() {
      return {
        sessions: listSessions(db, roomId).map((session) => ({
          seq: session.seq,
          agentId: session.agentId,
          outcome: session.outcome,
          startedAt: session.startedAt,
          endedAt: session.endedAt,
          messages: getMessagesBySession(db, roomId, session.seq),
        })),
      };
    },

    getSessionDetail(params: { sessionId: number }) {
      const session = getSession(db, roomId, params.sessionId);
      if (!session) throw new ApiError(`session not found: ${params.sessionId}`, 404);
      const rawLog = session.rawLogPath ? readFileSync(session.rawLogPath, 'utf-8') : '';
      return {
        agentId: session.agentId,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        outcome: session.outcome,
        rawLog,
        wroteMessages: getMessagesBySession(db, roomId, params.sessionId).length > 0,
      };
    },

    async terminateAgentSession(params: { sessionId: number }) {
      await orchestratorTerminateAgentSession(db, roomId, params.sessionId, killSession, startSession, stuckCounter);
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
