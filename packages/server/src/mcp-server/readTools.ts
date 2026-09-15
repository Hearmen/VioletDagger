import type Database from 'better-sqlite3';
import { buildOverview, buildDetail } from '../memory';
import type { OverviewPayload, MessageWithAnnotations } from '../memory';
import type { MessageType } from '../storage';
import { assertRoomExists, McpToolError } from './validation';

export function createGetOverviewHandler(db: Database.Database) {
  return function getOverview(params: { roomId: number }): OverviewPayload {
    assertRoomExists(db, params.roomId);
    return buildOverview(db, params.roomId);
  };
}

export function createGetDetailHandler(db: Database.Database) {
  return function getDetail(
    params: { roomId: number; messageId?: number; type?: MessageType },
  ): MessageWithAnnotations | MessageWithAnnotations[] {
    assertRoomExists(db, params.roomId);
    const hasMessageId = params.messageId != null;
    const hasType = params.type != null;
    if (hasMessageId === hasType) {
      throw new McpToolError('get_detail requires exactly one of messageId or type');
    }
    if (hasMessageId) {
      try {
        return buildDetail(db, params.roomId, { messageId: params.messageId! });
      } catch (err) {
        if (err instanceof McpToolError) throw err;
        throw new McpToolError(err instanceof Error ? err.message : 'message not found');
      }
    }
    return buildDetail(db, params.roomId, { type: params.type! });
  };
}
