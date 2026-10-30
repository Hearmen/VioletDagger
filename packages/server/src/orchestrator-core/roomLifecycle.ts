import type Database from 'better-sqlite3';
import {
  getRoom, setRoomStatus, increaseMaxSessions, getRoomAgents, deleteRoom as deleteRoomRecord,
} from '../storage';
import { roomEvents } from '../events';
import type { NativeDeleteFailure } from '../agent-invocation';
import { checkAndDispatch, type StartSession } from './dispatch';
import { terminateAgentSession, type StopSessionProcess } from './sessionLifecycle';
import type { StuckCounter } from './stuckCounter';
import type { FailureCounter } from './failureCounter';

export function pauseRoom(db: Database.Database, roomId: number): void {
  const room = getRoom(db, roomId);
  if (!room) throw new Error(`Room ${roomId} not found`);
  // completed 不可再改状态，否则 completed → paused_manual → resumeRoom 会重新打开已结束的房间（03 §4）。
  if (room.status !== 'active') throw new Error('room is not active');

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
  if (room.status !== 'paused_limit' && room.status !== 'paused_manual') {
    throw new Error('room is not paused');
  }

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

// 房间只能由人类通过本函数结束，系统不自动结束房间（需求 3.3.1）。
export function confirmCompletion(db: Database.Database, roomId: number): void {
  const room = getRoom(db, roomId);
  if (!room) throw new Error(`Room ${roomId} not found`);
  if (room.status === 'completed') throw new Error('room is already completed');

  setRoomStatus(db, roomId, 'completed');
  roomEvents.emit('roomStatus', { roomId });
}

export interface DeleteRoomDeps {
  stopSessionProcess: StopSessionProcess;
  startSession: StartSession;
  stuckCounter: StuckCounter;
  failureCounter: FailureCounter;
  deleteRoomArtifacts: (roomId: number) => Promise<NativeDeleteFailure[]>;
}

// 只允许删除 completed 房间；confirmCompletion 不终止遗留的 running/stopping session，
// 删前必须确认它们退出——任一清理失败则中止删除并保留记录与占位供重试（03 §4）。
// 原生会话原件删除失败不中断删除，失败列表返回给调用方提示人类。
export async function deleteRoom(
  db: Database.Database,
  roomId: number,
  deps: DeleteRoomDeps,
): Promise<{ nativeDeleteFailures: NativeDeleteFailure[] }> {
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

  // 必须先于 deleteRoomRecord：原件定位依赖 sessions 表的 native_* 字段。
  const nativeDeleteFailures = await deps.deleteRoomArtifacts(roomId);
  deleteRoomRecord(db, roomId);
  roomEvents.emit('roomDeleted', { roomId });
  return { nativeDeleteFailures };
}
