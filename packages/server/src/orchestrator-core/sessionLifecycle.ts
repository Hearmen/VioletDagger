import type Database from 'better-sqlite3';
import {
  getSession, finishSession, setAgentState, getMessagesBySession, insertMessage,
} from '../storage';
import { roomEvents } from '../events';
import { checkAndDispatch, type StartSession } from './dispatch';
import type { StuckCounter } from './stuckCounter';

export function onSessionEnded(
  db: Database.Database,
  event: {
    roomId: number;
    seq: number;
    agentId: string;
    result: 'exited-zero' | 'exited-nonzero';
    rawLogPath: string;
  },
  startSession: StartSession,
  stuckCounter: StuckCounter,
): void {
  const session = getSession(db, event.roomId, event.seq);
  if (!session || session.outcome !== 'running') return;

  let outcome: 'completed' | 'passed' | 'error';
  if (event.result === 'exited-nonzero') {
    outcome = 'error';
  } else {
    const hadTypedMessage = getMessagesBySession(db, event.roomId, event.seq).some((m) => m.type != null);
    outcome = hadTypedMessage ? 'completed' : 'passed';
  }

  finishSession(db, event.roomId, event.seq, outcome, event.rawLogPath);
  setAgentState(db, event.roomId, event.agentId, 'idle');

  if (outcome === 'error') {
    const { message } = insertMessage(db, {
      roomId: event.roomId,
      sessionSeq: event.seq,
      authorId: 'system',
      content: `Agent ${event.agentId} 的 session #${event.seq} 出错退出`,
    });
    roomEvents.emit('message', { roomId: event.roomId, message });
  }

  roomEvents.emit('roomStatus', { roomId: event.roomId });
  checkAndDispatch(db, event.roomId, startSession, stuckCounter);
}
