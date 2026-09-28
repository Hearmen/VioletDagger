import type Database from 'better-sqlite3';
import {
  getRoom, getRoomAgents, setRoomStatus, setAgentState, countSessions, createSession,
  getActiveExploring, countMessages, setDispatchPending, setDirectedPending,
} from '../storage';
import type { DispatchScope, RoomAgentState } from '../storage/types';
import { roomEvents } from '../events';
import type { StuckCounter } from './stuckCounter';

export type StartSession = (params: {
  roomId: number;
  seq: number;
  agentId: string;
  registryKey: string;
}) => void | Promise<void>;

// 派发空闲判定（03-orchestrator-core.md §1.6）：房间进行中、已有消息、没有 running/stopping 的 agent，
// 没有启用 agent 的定向标记待处理，且房间标记为 false 或没有任何启用的 agent。只读，供 getRoomStatus 计算无任务派发提醒。
export function isDispatchIdle(db: Database.Database, roomId: number): boolean {
  const room = getRoom(db, roomId);
  if (!room || room.status !== 'active') return false;
  if (countMessages(db, roomId) === 0) return false;
  const agents = getRoomAgents(db, roomId);
  if (agents.some((agent) => agent.state === 'running' || agent.state === 'stopping')) return false;
  const enabled = agents.filter((agent) => agent.dispatchEnabled);
  if (enabled.some((agent) => agent.directedPending)) return false;
  return !room.dispatchPending || enabled.length === 0;
}

// 待分发标记驱动的派发检查（03-orchestrator-core.md §1.2）。所有标记都为 false 时直接返回：不扫描、不推送。
// 先定向阶段（每个空闲、启用、带定向标记的 agent 各派一个定向 session），再房间阶段（房间标记为 true 时
// 按 joinOrder 选第一个空闲、启用、无定向标记、非标记作者的 agent，选不出退回标记作者本人），最多派一个广播 session。
export function checkAndDispatch(
  db: Database.Database,
  roomId: number,
  startSession: StartSession,
  stuckCounter: StuckCounter,
): void {
  const room = getRoom(db, roomId);
  if (!room || room.status !== 'active') return;

  const agents = getRoomAgents(db, roomId);
  const hasDirected = agents.some((agent) => agent.dispatchEnabled && agent.directedPending);
  if (!room.dispatchPending && !hasDirected) return;

  // 同一次检查里刚派发出去的 agent 视为忙碌（房间阶段要把它们当作 running 扫描）。
  const dispatched = new Set<string>();
  const isBusy = (agent: RoomAgentState) =>
    dispatched.has(agent.agentId) || agent.state === 'running' || agent.state === 'stopping';

  // "派发"（§1.2）：触及上限时把房间置为 paused_limit 并返回 false，调用方就此结束本次检查、保留剩余标记。
  const dispatch = (agent: RoomAgentState, scope: DispatchScope): boolean => {
    if (countSessions(db, roomId) >= room.maxSessions) {
      setRoomStatus(db, roomId, 'paused_limit');
      return false;
    }
    const session = createSession(db, roomId, agent.agentId, scope);
    setAgentState(db, roomId, agent.agentId, 'running', session.seq);
    if (scope === 'directed') setDirectedPending(db, roomId, agent.agentId, false);
    else setDispatchPending(db, roomId, false);
    dispatched.add(agent.agentId);
    // checkAndDispatch 会被进程退出等事件回调直接调用；startSession 即使同步抛错也不能让它冒泡成
    // 未捕获异常打挂 server（见 03-orchestrator-core.md §1.2"派发"第 3 步），这里统一降级为日志。
    try {
      const result = startSession({
        roomId,
        seq: session.seq,
        agentId: agent.agentId,
        registryKey: agent.registryKey,
      });
      if (result && typeof (result as Promise<void>).then === 'function') {
        (result as Promise<void>).catch((err) => {
          console.error(`startSession failed for room ${roomId}, agent ${agent.agentId}:`, err);
        });
      }
    } catch (err) {
      console.error(`startSession threw for room ${roomId}, agent ${agent.agentId}:`, err);
    }
    return true;
  };

  const run = (): void => {
    // 定向阶段。
    for (const agent of agents) {
      if (!agent.dispatchEnabled || !agent.directedPending || isBusy(agent)) continue;
      if (!dispatch(agent, 'directed')) return;
    }

    // 房间阶段：只在房间标记为 true 时扫描，扫描沿途给忙碌且带 active exploring 的 agent 计 stuckCount（§5）。
    if (!room.dispatchPending) return;
    const activeExploringAgentIds = new Set(getActiveExploring(db, roomId).map((m) => m.authorId));
    let target: RoomAgentState | null = null;
    let fallback: RoomAgentState | null = null;
    for (const agent of agents) {
      if (!agent.dispatchEnabled) continue;
      if (isBusy(agent)) {
        if (activeExploringAgentIds.has(agent.agentId)) stuckCounter.increment(roomId, agent.agentId);
        continue;
      }
      // 定向标记待处理的 agent 不接房间标记（需求 3.3.2）。
      if (agent.directedPending) continue;
      if (agent.agentId === room.pendingAuthorId) {
        fallback = fallback ?? agent;
        continue;
      }
      target = agent;
      break;
    }
    const chosen = target ?? fallback;
    if (chosen) dispatch(chosen, 'broadcast');
  };

  run();
  roomEvents.emit('roomStatus', { roomId });
}
