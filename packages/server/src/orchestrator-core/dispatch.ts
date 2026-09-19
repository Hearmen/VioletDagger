import type Database from 'better-sqlite3';
import {
  getRoom, getRoomAgents, setRoomStatus, setAgentState, countSessions, createSession, getActiveExploring,
  getLatestDispatchTriggerAt, getLatestSessionStartedAt,
} from '../storage';
import type { MessageType } from '../storage/types';
import { roomEvents } from '../events';
import type { StuckCounter } from './stuckCounter';

export type StartSession = (params: {
  roomId: number;
  seq: number;
  agentId: string;
  registryKey: string;
}) => void | Promise<void>;

// 触发派发的 agent 消息类型（人类消息一律触发，见 03 §1.2）。exploring/propose_completion/endorse/verify 只是
// 状态广播、信号或纯注解，不把其他 agent 拉起——否则它们会互相刷出永不停止的调度。
export const DISPATCH_TRIGGER_TYPES: MessageType[] = [
  'fact', 'hypothesis', 'boundary', 'open_question', 'chain', 'challenge',
];

// 一个空闲 agent 是否“待派发”：存在一条非本人发出的触发型消息，其时间严格晚于它自己上次 session 的开始时间。
// 从没跑过视为待派发；同一毫秒并列视为已消费（宁可少派一次，见 03 §1.2）。
function isDispatchOwed(db: Database.Database, roomId: number, agentId: string): boolean {
  const latestTrigger = getLatestDispatchTriggerAt(db, roomId, agentId, DISPATCH_TRIGGER_TYPES);
  if (latestTrigger == null) return false;
  const lastStart = getLatestSessionStartedAt(db, roomId, agentId);
  return lastStart == null || latestTrigger > lastStart;
}

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
    // 空闲但不“待派发”（没有晚于它上次 session 的触发型消息）就跳过——否则 session 结束会无条件重新拉起，
    // 出现任务完成后仍一遍遍空转。跳过而不是停下：不能让一个没有新信息的空闲 agent 挡住后面待派发的 agent。
    if (!isDispatchOwed(db, roomId, agent.agentId)) continue;
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
