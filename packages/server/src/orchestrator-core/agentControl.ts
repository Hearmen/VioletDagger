import type Database from 'better-sqlite3';
import {
  completeExploring, getActiveExploringByAuthor, getMessageById, getRoomAgents,
  setAgentEnabled as storageSetAgentEnabled,
} from '../storage';
import { roomEvents } from '../events';
import { checkAndDispatch, type StartSession } from './dispatch';
import { resetStuckCount, type StuckCounter } from './stuckCounter';
import type { FailureCounter } from './failureCounter';

// releaseExploring 的拒绝原因（03 §3.1 第 1、2 步）；调用方把 message 原样作为业务错误返回。
export class ReleaseExploringError extends Error {}

function isBusy(state: string): boolean {
  return state === 'running' || state === 'stopping';
}

// 停用释放（03 §6）：agent 处于停用状态且空闲时，完成它的 active exploring。
// 由调用方保证执行时机（setAgentEnabled(false) 时 agent 空闲，或 onSessionEnded 结算之后）。
export function releaseDisabledAgentExploring(
  db: Database.Database,
  roomId: number,
  agentId: string,
  stuckCounter: StuckCounter,
): void {
  const agent = getRoomAgents(db, roomId).find((item) => item.agentId === agentId);
  if (!agent || agent.dispatchEnabled || isBusy(agent.state)) return;
  const active = getActiveExploringByAuthor(db, roomId, agentId);
  if (!active) return;
  completeExploring(db, roomId, active.id, { reason: 'agent_disabled', note: 'agent 已停用' });
  resetStuckCount(stuckCounter, roomId, agentId);
  roomEvents.emit('memoryUpdate', { roomId, messageId: active.id });
}

// 人类启停某个 agent 的派发（见 03-orchestrator-core.md §6）。
// 启用时清空其失败计数并触发一次派发检查（重新入队）；停用不终止正在运行的 session，
// agent 空闲时释放它的 active exploring 并做一次派发检查（释放出的方向可能需要续派）。
export function setAgentEnabled(
  db: Database.Database,
  roomId: number,
  agentId: string,
  enabled: boolean,
  startSession: StartSession,
  stuckCounter: StuckCounter,
  failureCounter: FailureCounter,
): void {
  const agent = getRoomAgents(db, roomId).find((item) => item.agentId === agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found in room ${roomId}`);

  storageSetAgentEnabled(db, roomId, agentId, enabled);
  if (enabled) failureCounter.reset(roomId, agentId);
  else releaseDisabledAgentExploring(db, roomId, agentId, stuckCounter);
  roomEvents.emit('roomStatus', { roomId });
  checkAndDispatch(db, roomId, startSession, stuckCounter);
}

// 人类释放一条作者已不会再继续的 active exploring（03 §3.1）。
export function releaseExploring(
  db: Database.Database,
  roomId: number,
  messageId: number,
  startSession: StartSession,
  stuckCounter: StuckCounter,
): void {
  const message = getMessageById(db, roomId, messageId);
  if (!message) throw new ReleaseExploringError('消息不存在');
  if (message.type !== 'exploring') throw new ReleaseExploringError('不是 exploring');
  if (message.exploringStatus !== 'active') throw new ReleaseExploringError('该 exploring 已结束');
  const author = getRoomAgents(db, roomId).find((item) => item.agentId === message.authorId);
  if (author && isBusy(author.state)) {
    throw new ReleaseExploringError('作者 agent 正在运行，请用终止 session 结束它');
  }

  completeExploring(db, roomId, messageId, { reason: 'human_released', note: '人类释放' });
  resetStuckCount(stuckCounter, roomId, message.authorId);
  roomEvents.emit('memoryUpdate', { roomId, messageId });
  checkAndDispatch(db, roomId, startSession, stuckCounter);
}
