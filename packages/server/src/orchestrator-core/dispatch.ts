import type Database from 'better-sqlite3';
import {
  getRoom, getRoomAgents, setRoomStatus, setAgentState, countSessions, createSession, getActiveExploring,
} from '../storage';
import { roomEvents } from '../events';
import type { StuckCounter } from './stuckCounter';

export type StartSession = (params: {
  roomId: number;
  seq: number;
  agentId: string;
  registryKey: string;
}) => void | Promise<void>;

export function checkAndDispatch(
  db: Database.Database,
  roomId: number,
  startSession: StartSession,
  stuckCounter: StuckCounter,
): void {
  const room = getRoom(db, roomId);
  if (!room || room.status !== 'active') return;

  if (countSessions(db, roomId) >= room.maxSessions) {
    setRoomStatus(db, roomId, 'paused_limit');
    roomEvents.emit('roomStatus', { roomId });
    return;
  }

  const activeExploringAgentIds = new Set(getActiveExploring(db, roomId).map((m) => m.authorId));
  const agents = getRoomAgents(db, roomId);
  let dispatchTarget: (typeof agents)[number] | null = null;

  for (const agent of agents) {
    // 被停用派发的 agent（连续失败自动停用或人类手动停用，见 03 §6）直接跳过。
    if (!agent.dispatchEnabled) continue;
    if (agent.state === 'running' || agent.state === 'stopping') {
      if (activeExploringAgentIds.has(agent.agentId)) {
        stuckCounter.increment(roomId, agent.agentId);
      }
      continue;
    }
    dispatchTarget = agent;
    break;
  }

  if (!dispatchTarget) {
    roomEvents.emit('roomStatus', { roomId });
    return;
  }

  const session = createSession(db, roomId, dispatchTarget.agentId);
  setAgentState(db, roomId, dispatchTarget.agentId, 'running', session.seq);
  // checkAndDispatch 会被进程退出等事件回调直接调用；startSession 即使同步抛错也不能让它冒泡成
  // 未捕获异常打挂 server（见 03-orchestrator-core.md §1.2 第 5 步），这里统一降级为日志。
  try {
    const result = startSession({
      roomId,
      seq: session.seq,
      agentId: dispatchTarget.agentId,
      registryKey: dispatchTarget.registryKey,
    });
    if (result && typeof (result as Promise<void>).then === 'function') {
      (result as Promise<void>).catch((err) => {
        console.error(`startSession failed for room ${roomId}, agent ${dispatchTarget.agentId}:`, err);
      });
    }
  } catch (err) {
    console.error(`startSession threw for room ${roomId}, agent ${dispatchTarget.agentId}:`, err);
  }
  roomEvents.emit('roomStatus', { roomId });
}

export function onSubstantiveMessagePosted(
  db: Database.Database,
  roomId: number,
  startSession: StartSession,
  stuckCounter: StuckCounter,
): void {
  checkAndDispatch(db, roomId, startSession, stuckCounter);
}
