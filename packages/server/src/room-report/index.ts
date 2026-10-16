import type Database from 'better-sqlite3';
import { getFirstMessage, getRoom, getRoomAgents, listSessions, type Room, type Session } from '../storage';
import type { NativeSessionAdapter } from '../agent-invocation';
import { aggregateRow, aggregateToolNames } from './aggregate';
import { collectSessionRecords, isEnded } from './collect';
import { ratio } from './stats';
import { RoomNotFoundError, type RoomReport } from './types';

export * from './types';

// 任务分析报告（10-room-report.md）：只读，按需计算，不缓存、不写存储、不 emit 事件。
export async function getRoomReport(
  db: Database.Database,
  roomId: number,
  options: { getAdapter?: (registryKey: string) => NativeSessionAdapter; timeoutMs?: number } = {},
): Promise<RoomReport> {
  const room = getRoom(db, roomId);
  if (!room) throw new RoomNotFoundError(roomId);
  const generatedAt = new Date().toISOString();

  const agents = getRoomAgents(db, roomId);
  const sessions = listSessions(db, roomId);
  const ended = sessions.filter(isEnded);
  const registryKeys = new Map(agents.map((agent) => [agent.agentId, agent.registryKey]));
  const records = await collectSessionRecords(ended, registryKeys, options);

  // 合计行用全部已结束 session 按同一套规则计算，不是各 agent 行的再加工（§3 第 6 步）。
  const roomRow = aggregateRow(records, { agentId: null, registryKey: null });
  const agentRows = agents.map((agent) => {
    const row = aggregateRow(
      records.filter((r) => r.agentId === agent.agentId),
      { agentId: agent.agentId, registryKey: agent.registryKey },
    );
    row.tokens.shareOfRoom = ratio(row.tokens.total, roomRow.tokens.total);
    return row;
  });

  const byAgent: RoomReport['toolNames']['byAgent'] = {};
  for (const agent of agents) {
    byAgent[agent.agentId] = aggregateToolNames(records.filter((r) => r.agentId === agent.agentId));
  }

  return {
    roomId,
    generatedAt,
    runningSessions: sessions.length - ended.length,
    room: {
      ...roomRow,
      maxSessions: room.maxSessions,
      sessionsCreated: sessions.length,
      sessionUsageRate: ratio(sessions.length, room.maxSessions),
      roomDurationMs: roomDurationMs(db, room, sessions, generatedAt),
    },
    agents: agentRows,
    toolNames: { room: aggregateToolNames(records), byAgent },
  };
}

// 墙钟时长，含暂停期间（§4.2）：起点为首条消息；已结束房间终点取 completed_at 与各 session endedAt 中较晚者，
// 否则为 generatedAt。没有首条消息，或已结束但 completed_at 为空时为 null。
function roomDurationMs(db: Database.Database, room: Room, sessions: Session[], generatedAt: string): number | null {
  const first = getFirstMessage(db, room.id);
  if (!first) return null;
  let end: number;
  if (room.status === 'completed') {
    if (!room.completedAt) return null;
    end = Date.parse(room.completedAt);
    for (const session of sessions) {
      if (session.endedAt) end = Math.max(end, Date.parse(session.endedAt));
    }
  } else {
    end = Date.parse(generatedAt);
  }
  const ms = end - Date.parse(first.createdAt);
  return Number.isFinite(ms) ? Math.max(0, ms) : null;
}
