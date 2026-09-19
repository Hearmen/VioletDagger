import type Database from 'better-sqlite3';
import { buildOverview, buildDetail } from '../memory';
import type { DetailParams } from '../memory/types';
import { assertRoomExists, McpToolError } from './validation';

export function createGetOverviewHandler(db: Database.Database) {
  return function getOverview(params: { roomId: number }) {
    assertRoomExists(db, params.roomId);
    return buildOverview(db, params.roomId);
  };
}
export function createGetDetailHandler(db: Database.Database) {
  return function getDetail(params: DetailParams & { roomId: number }) {
    assertRoomExists(db, params.roomId);
    try { return buildDetail(db, params.roomId, params); }
    catch (err) { throw new McpToolError(err instanceof Error ? err.message : 'detail query failed'); }
  };
}
