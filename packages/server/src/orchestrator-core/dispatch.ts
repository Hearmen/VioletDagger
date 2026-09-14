import type Database from 'better-sqlite3';
import {
  getRoom, getRoomAgents, setRoomStatus, setAgentState, countSessions, createSession, getActiveExploring,
} from '../storage';
import { roomEvents } from '../events';
import type { StuckCounter } from './stuckCounter';

export type StartSession = (params: { roomId: number; seq: number; agentId: string }) => void;

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
  let dispatchTarget: string | null = null;

  for (const agent of getRoomAgents(db, roomId)) {
    if (agent.state === 'running') {
      if (activeExploringAgentIds.has(agent.agentId)) {
        stuckCounter.increment(roomId, agent.agentId);
      }
      continue;
    }
    dispatchTarget = agent.agentId;
    break;
  }

  if (!dispatchTarget) {
    roomEvents.emit('roomStatus', { roomId });
    return;
  }

  const session = createSession(db, roomId, dispatchTarget);
  setAgentState(db, roomId, dispatchTarget, 'running', session.seq);
  startSession({ roomId, seq: session.seq, agentId: dispatchTarget });
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
