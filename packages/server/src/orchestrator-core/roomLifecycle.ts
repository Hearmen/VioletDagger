import type Database from 'better-sqlite3';
import {
  getRoom, setRoomStatus, increaseMaxSessions, getRoomAgents, deleteRoom as deleteRoomRecord,
} from '../storage';
import { roomEvents } from '../events';
import { checkAndDispatch, type StartSession } from './dispatch';
import { terminateAgentSession, type StopSessionProcess } from './sessionLifecycle';
import type { StuckCounter } from './stuckCounter';
import type { FailureCounter } from './failureCounter';

export function pauseRoom(db: Database.Database, roomId: number): void {
  setRoomStatus(db, roomId, 'paused_manual');
  roomEvents.emit('roomStatus', { roomId });
}

export function resumeRoom(
  db: Database.Database,
  roomId: number,
  startSession: StartSession,
  stuckCounter: StuckCounter,
  additionalSessions?: number,
): void {
  const room = getRoom(db, roomId);
  if (!room) throw new Error(`Room ${roomId} not found`);

  if (room.status === 'paused_limit') {
    if (additionalSessions == null) {
      throw new Error('additionalSessions is required to resume a room paused at its session limit');
    }
    increaseMaxSessions(db, roomId, additionalSessions);
  }

  setRoomStatus(db, roomId, 'active');
  roomEvents.emit('roomStatus', { roomId });
  checkAndDispatch(db, roomId, startSession, stuckCounter);
}

export function confirmCompletion(db: Database.Database, roomId: number): void {
  setRoomStatus(db, roomId, 'completed');
  roomEvents.emit('roomStatus', { roomId });
}

export interface DeleteRoomDeps {
  stopSessionProcess: StopSessionProcess;
  startSession: StartSession;
  stuckCounter: StuckCounter;
  failureCounter: FailureCounter;
  deleteRoomArtifacts: (roomId: number) => Promise<void>;
}

// 只允许删除 completed 房间；confirmCompletion 不终止遗留的 running/stopping session，
// 删前必须确认它们退出——任一清理失败则中止删除并保留记录与占位供重试（03 §4）。
export async function deleteRoom(
  db: Database.Database,
  roomId: number,
  deps: DeleteRoomDeps,
): Promise<void> {
  const room = getRoom(db, roomId);
  if (!room) throw new Error(`Room ${roomId} not found`);
  if (room.status !== 'completed') {
    throw new Error('only completed rooms can be deleted');
  }

  for (const agent of getRoomAgents(db, roomId)) {
    if ((agent.state === 'running' || agent.state === 'stopping') && agent.currentSessionSeq != null) {
      await terminateAgentSession(
        db, roomId, agent.currentSessionSeq, deps.stopSessionProcess, deps.startSession,
        deps.stuckCounter, deps.failureCounter,
      );
    }
  }

  await deps.deleteRoomArtifacts(roomId);
  deleteRoomRecord(db, roomId);
  roomEvents.emit('roomDeleted', { roomId });
}
