import type Database from 'better-sqlite3';
import { getRoomAgents, setAgentEnabled as storageSetAgentEnabled } from '../storage';
import { roomEvents } from '../events';
import { checkAndDispatch, type StartSession } from './dispatch';
import type { StuckCounter } from './stuckCounter';
import type { FailureCounter } from './failureCounter';

// 人类启停某个 agent 的派发（见 03-orchestrator-core.md §6）。
// 启用时清空其失败计数并触发一次派发检查（重新入队）；停用不终止正在运行的 session。
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
  roomEvents.emit('roomStatus', { roomId });
  if (enabled) checkAndDispatch(db, roomId, startSession, stuckCounter);
}
