import type Database from 'better-sqlite3';
import { getRoom, setRoomStatus, increaseMaxSessions } from '../storage';
import { roomEvents } from '../events';
import { checkAndDispatch, type StartSession } from './dispatch';
import type { StuckCounter } from './stuckCounter';

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
