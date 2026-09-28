import type Database from 'better-sqlite3';
import { buildOverview, buildDetail } from '../memory';
import type { DetailParams } from '../memory/types';
import { assertRoomExists, McpToolError } from './validation';

export function createGetOverviewHandler(db: Database.Database) {
  return function getOverview(params: { roomId: number }) {
    assertRoomExists(db, params.roomId);
    // 房间还没有 goal 时 buildOverview 抛错，按业务错误返回（见 02-memory-management.md §3.2）。
    try { return buildOverview(db, params.roomId); }
    catch (err) { throw new McpToolError(err instanceof Error ? err.message : 'overview query failed'); }
  };
}
export function createGetDetailHandler(db: Database.Database) {
  return function getDetail(params: DetailParams & { roomId: number }) {
    assertRoomExists(db, params.roomId);
    try { return buildDetail(db, params.roomId, params); }
    catch (err) { throw new McpToolError(err instanceof Error ? err.message : 'detail query failed'); }
  };
}
