import type Database from 'better-sqlite3';
import {
  getSession, finishSession, setAgentState, getMessagesBySession, insertMessage, getRoomAgents,
  getActiveExploring, completeExploring, markSessionTerminating, markSessionCleanupStarted, appendSessionEvent,
  setAgentEnabled,
} from '../storage';
import { roomEvents } from '../events';
import type { SessionExitEvent, StopResult } from '../agent-invocation';
import { checkAndDispatch, type StartSession } from './dispatch';
import type { StuckCounter } from './stuckCounter';
import { FAILURE_THRESHOLD, type FailureCounter } from './failureCounter';

export type StopSessionProcess = (roomId: number, seq: number) => Promise<StopResult>;

// 人工清理进度事件：由 agent 调用层在清理过程中回调（03 §3 第 5 步），落生命周期表并推送状态。
export function onSessionExitProgress(
  db: Database.Database,
  roomId: number,
  seq: number,
  kind: 'cleanup_started' | 'sigterm_sent' | 'sigkill_sent' | 'cleanup_failed',
  detail?: string,
  cleanupAttemptId?: string,
): void {
  const attemptId = cleanupAttemptId ?? '';
  if (kind === 'cleanup_started') {
    markSessionCleanupStarted(db, roomId, seq, attemptId);
    appendSessionEvent(db, roomId, seq, 'cleanup_started', detail, attemptId);
  } else {
    appendSessionEvent(db, roomId, seq, kind, detail, attemptId);
  }
  roomEvents.emit('roomStatus', { roomId });
}

// 仅在 agent 仍指向本 seq 时释放占位（见 01-storage.md §5.3）。
function releaseAgentIfCurrent(db: Database.Database, roomId: number, agentId: string, seq: number): void {
  const agent = getRoomAgents(db, roomId).find((a) => a.agentId === agentId);
  if (agent && agent.currentSessionSeq === seq) setAgentState(db, roomId, agentId, 'idle');
}

// 一次 session 进程结果确定后的唯一结算入口（03 §2）：只处理 running/stopping，幂等。
export function onSessionEnded(
  db: Database.Database,
  event: SessionExitEvent,
  startSession: StartSession,
  stuckCounter: StuckCounter,
  failureCounter: FailureCounter,
): void {
  const session = getSession(db, event.roomId, event.seq);
  if (!session || (session.outcome !== 'running' && session.outcome !== 'stopping')) return;

  const terminated = session.stopIntent === 'terminate' || event.exitCause === 'not-started';
  let outcome: 'completed' | 'passed' | 'error' | 'terminated';
  if (terminated) {
    outcome = 'terminated';
  } else if (event.exitCause === 'natural') {
    const hadTypedMessage = getMessagesBySession(db, event.roomId, event.seq).some((m) => m.type != null);
    outcome = hadTypedMessage ? 'completed' : 'passed';
  } else {
    outcome = 'error';
  }

  finishSession(db, event.roomId, event.seq, outcome, event.rawLogPath || undefined, {
    exitCode: event.exitCode,
    signal: event.signal,
    exitCause: event.exitCause,
  });
  appendSessionEvent(db, event.roomId, event.seq, 'process_exited', undefined, event.cleanupAttemptId);
  if (terminated) {
    appendSessionEvent(db, event.roomId, event.seq, 'terminated', undefined, event.cleanupAttemptId);
  }
  releaseAgentIfCurrent(db, event.roomId, event.agentId, event.seq);

  if (outcome === 'error') {
    const { message } = insertMessage(db, {
      roomId: event.roomId,
      sessionSeq: event.seq,
      authorId: 'system',
      content: `Agent ${event.agentId} 的 session #${event.seq} 异常退出`,
    });
    roomEvents.emit('message', { roomId: event.roomId, message });

    // 连续失败达到阈值 -> 自动停用该 agent 的派发（见 03 §6）。
    const failures = failureCounter.increment(event.roomId, event.agentId);
    if (failures >= FAILURE_THRESHOLD) {
      setAgentEnabled(db, event.roomId, event.agentId, false);
      failureCounter.reset(event.roomId, event.agentId);
    }
  } else {
    failureCounter.reset(event.roomId, event.agentId);
  }

  roomEvents.emit('roomStatus', { roomId: event.roomId });
  checkAndDispatch(db, event.roomId, startSession, stuckCounter);
}

export async function terminateAgentSession(
  db: Database.Database,
  roomId: number,
  seq: number,
  stopSessionProcess: StopSessionProcess,
  startSession: StartSession,
  stuckCounter: StuckCounter,
  failureCounter: FailureCounter,
): Promise<void> {
  const session = getSession(db, roomId, seq);
  if (!session || (session.outcome !== 'running' && session.outcome !== 'stopping')) return;

  // 同步事务：置 stopping + 记录终止请求，不提前写 terminated（03 §3）。
  db.transaction(() => {
    const { changed } = markSessionTerminating(db, roomId, seq);
    if (changed) {
      appendSessionEvent(db, roomId, seq, 'terminate_requested');
      const agent = getRoomAgents(db, roomId).find((a) => a.agentId === session.agentId);
      if (agent && agent.currentSessionSeq === seq) {
        setAgentState(db, roomId, session.agentId, 'stopping', seq);
      }
    }
  })();
  roomEvents.emit('roomStatus', { roomId });

  const result = await stopSessionProcess(roomId, seq);
  if (!result.confirmed) {
    // 无法确认退出：保持 stopping 与占位，错误上抛供人类重试（03 §3 第 4 步）。
    roomEvents.emit('roomStatus', { roomId });
    throw new Error(result.error);
  }

  const current = getSession(db, roomId, seq);
  if (current && (current.outcome === 'running' || current.outcome === 'stopping')) {
    // 从未启动（not-started）等没有进程退出事件的路径：在这里结算 terminated。
    finishSession(db, roomId, seq, 'terminated', result.exit.rawLogPath || undefined, {
      exitCode: result.exit.exitCode,
      signal: result.exit.signal,
      exitCause: result.exit.exitCause,
    });
    appendSessionEvent(db, roomId, seq, 'process_exited', undefined, result.exit.cleanupAttemptId);
    appendSessionEvent(db, roomId, seq, 'terminated', undefined, result.exit.cleanupAttemptId);
    releaseAgentIfCurrent(db, roomId, session.agentId, seq);
    roomEvents.emit('roomStatus', { roomId });
    checkAndDispatch(db, roomId, startSession, stuckCounter);
  }

  // 人类强制完成该 agent 当前 active 的 exploring（03 §3 第 3 步）。
  const activeExploring = getActiveExploring(db, roomId).find((m) => m.authorId === session.agentId);
  if (activeExploring) {
    completeExploring(db, roomId, activeExploring.id, '人类强制终止');
    stuckCounter.reset(roomId, session.agentId);
    roomEvents.emit('memoryUpdate', { roomId, messageId: activeExploring.id });
  }

  // 人工终止属于非失败终态：清零连续失败计数（幂等）。
  failureCounter.reset(roomId, session.agentId);

  roomEvents.emit('roomStatus', { roomId });
}
