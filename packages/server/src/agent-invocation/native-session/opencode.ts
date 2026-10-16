import { access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  asRecord, emptyStats, homeDir, isMissing, numberOrNull, readStdoutEvents, ROOM_MCP_SERVER, runCommand, stringOrNull,
  sumOrNull, toIso,
  type NativeSessionAdapter, type NativeSessionStats, type NativeToolCall,
} from './adapter';

// opencode 适配器（04-agent-invocation.md §7.5，数据库型：不复制，只读原库）。
const MCP_PREFIX = `${ROOM_MCP_SERVER}_`;

function opencodeDb(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const dataDir = xdg && xdg.trim() ? path.join(xdg, 'opencode') : path.join(os.homedir(), '.local', 'share', 'opencode');
  return path.join(dataDir, 'opencode.db');
}

function openReadonly(file: string): Database.Database {
  return new Database(file, { readonly: true, fileMustExist: true });
}

function sessionExists(file: string, id: string): boolean {
  const db = openReadonly(file);
  try {
    return db.prepare(`SELECT 1 FROM session WHERE id = ?`).get(id) != null;
  } finally {
    db.close();
  }
}

function parseData(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') return {};
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return {};
  }
}

export const opencodeAdapter: NativeSessionAdapter = {
  registryKey: 'opencode',

  preassignSessionId: () => null,

  async locate(ctx) {
    const event = (await readStdoutEvents(ctx.rawLogPath)).find((e) => typeof e.sessionID === 'string');
    const id = stringOrNull(event?.sessionID);
    if (!id) return null;
    const file = opencodeDb();
    try {
      return sessionExists(file, id) ? { sessionId: id, storage: 'database', originalPath: file } : null;
    } catch {
      return null;
    }
  },

  async archive(ref) {
    return { storage: 'database', originalPath: ref.originalPath, sessionId: ref.sessionId };
  },

  async analyze(source, signal): Promise<NativeSessionStats> {
    signal?.throwIfAborted();
    if (source.storage !== 'database') return emptyStats();
    const db = openReadonly(source.originalPath);
    try {
      let partRows: { data: unknown }[];
      let messageRows: { data: unknown }[];
      try {
        partRows = db.prepare(`SELECT data FROM part WHERE session_id = ? ORDER BY time_created, id`).all(source.sessionId) as {
          data: unknown;
        }[];
        messageRows = db
          .prepare(`SELECT data FROM message WHERE session_id = ? ORDER BY time_created, id`)
          .all(source.sessionId) as { data: unknown }[];
      } catch {
        // 表结构不符（opencode 升级后变化）：全部字段取 null。
        return emptyStats();
      }
      signal?.throwIfAborted();

      const parts = partRows.map((row) => parseData(row.data));
      const steps = parts.filter((p) => p.type === 'step-finish');
      const tokens = steps.map((p) => asRecord(p.tokens));
      const outputs = tokens.map((t) => {
        const output = numberOrNull(t.output);
        const reasoning = numberOrNull(t.reasoning);
        return output == null && reasoning == null ? null : (output ?? 0) + (reasoning ?? 0);
      });
      const toolCalls: NativeToolCall[] = parts
        .filter((p) => p.type === 'tool' && typeof p.tool === 'string')
        .map((p) => {
          const name = p.tool as string;
          const isRoomMcp = name.startsWith(MCP_PREFIX);
          const status = asRecord(p.state).status;
          return {
            name: isRoomMcp ? name.slice(MCP_PREFIX.length) : name,
            isRoomMcp,
            failed: status === 'error' ? true : status === 'completed' ? false : null,
          };
        });
      const firstAssistant = messageRows.map((row) => parseData(row.data)).find((m) => m.role === 'assistant');

      return {
        usage: {
          inputTokens: sumOrNull(tokens.map((t) => numberOrNull(t.input))),
          outputTokens: sumOrNull(outputs),
          cacheReadTokens: sumOrNull(tokens.map((t) => numberOrNull(asRecord(t.cache).read))),
          cacheWriteTokens: sumOrNull(tokens.map((t) => numberOrNull(asRecord(t.cache).write))),
          costUsd: sumOrNull(steps.map((p) => numberOrNull(p.cost))),
        },
        steps: steps.length,
        firstResponseAt: firstAssistant ? toIso(asRecord(firstAssistant.time).completed) : null,
        toolCalls,
      };
    } finally {
      db.close();
    }
  },

  async deleteOriginal(ref) {
    try {
      await access(ref.originalPath);
    } catch (err) {
      if (isMissing(err)) return; // 原库不存在视为成功
      throw err;
    }
    if (!sessionExists(ref.originalPath, ref.sessionId)) return; // 会话已不在库中视为成功
    await runCommand('opencode', ['session', 'delete', ref.sessionId]);
  },
};
