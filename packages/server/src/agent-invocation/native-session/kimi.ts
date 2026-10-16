import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  asRecord, copyInto, emptyStats, homeDir, isMissing, numberOrNull, parseJsonl, readJsonl, ROOM_MCP_SERVER,
  stringOrNull, sumOrNull, toIso,
  type NativeSessionAdapter, type NativeToolCall,
} from './adapter';

// kimi 适配器（04-agent-invocation.md §7.6，文件型）。
const MCP_PREFIX = `mcp__${ROOM_MCP_SERVER}__`;
const WIRE = path.join('agents', 'main', 'wire.jsonl');

function kimiHome(): string {
  return homeDir('KIMI_CODE_HOME', path.join(os.homedir(), '.kimi-code'));
}

function indexPath(): string {
  return path.join(kimiHome(), 'session_index.jsonl');
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf-8');
  } catch {
    return null;
  }
}

// turn.prompt 的文本是否是本 session 的 prompt（prompt.ts 写入的 roomId / authorId 两行）。
function promptMatches(wire: string, roomId: number, agentId: string): boolean {
  for (const event of parseJsonl(wire)) {
    if (event.type !== 'turn.prompt') continue;
    const input = Array.isArray(event.input) ? event.input : [];
    const text = input.map((part) => String(asRecord(part).text ?? '')).join('\n');
    if (text.includes(`roomId：${roomId}\n`) && text.includes(`authorId：${agentId}\n`)) return true;
  }
  return false;
}

export const kimiAdapter: NativeSessionAdapter = {
  registryKey: 'kimi',

  preassignSessionId: () => null,

  // stdout 里没有会话标识：按工作目录、创建时间与 prompt 内容在索引中匹配，恰好一条才算成功。
  async locate(ctx) {
    const index = await readText(indexPath());
    if (index == null) return null;
    const startMs = Date.parse(ctx.startedAt);
    const endMs = Date.parse(ctx.endedAt);
    const matches: { sessionId: string; sessionDir: string }[] = [];
    for (const entry of parseJsonl(index)) {
      const sessionId = stringOrNull(entry.sessionId);
      const sessionDir = stringOrNull(entry.sessionDir);
      if (!sessionId || !sessionDir || entry.workDir !== ctx.cwd) continue;
      const state = await readText(path.join(sessionDir, 'state.json'));
      if (state == null) continue;
      let createdAt: number | null;
      try {
        createdAt = numberOrNull(asRecord(JSON.parse(state)).createdAt);
      } catch {
        continue;
      }
      if (createdAt == null || createdAt < startMs || createdAt > endMs) continue;
      const wire = await readText(path.join(sessionDir, WIRE));
      if (wire == null || !promptMatches(wire, ctx.roomId, ctx.agentId)) continue;
      matches.push({ sessionId, sessionDir });
    }
    if (matches.length !== 1) return null;
    return { sessionId: matches[0].sessionId, storage: 'file', originalPath: matches[0].sessionDir };
  },

  async archive(ref, copyDir) {
    const ok = await copyInto(copyDir, [{ from: ref.originalPath, to: '.' }]);
    return ok ? { storage: 'file', copyPath: copyDir } : null;
  },

  async analyze(source, signal) {
    signal?.throwIfAborted();
    if (source.storage !== 'file') return emptyStats();
    let events;
    try {
      events = await readJsonl(path.join(source.copyPath, WIRE), signal);
    } catch (err) {
      if (isMissing(err)) return emptyStats();
      throw err;
    }

    const usages: Record<string, unknown>[] = [];
    let firstResponseAt: string | null = null;
    const calls: { id: string | null; name: string }[] = [];
    const results = new Map<string, boolean>(); // toolCallId → isError
    for (const event of events) {
      // 只统计主 agent；子 agent 有自己的 wire 文件。
      if (event.agentId != null && event.agentId !== 'main') continue;
      if (event.type === 'usage.record') {
        usages.push(asRecord(event.usage));
        firstResponseAt ??= toIso(event.time);
      } else if (event.type === 'context.append_loop_event') {
        const loop = asRecord(event.event);
        const callId = stringOrNull(loop.toolCallId);
        if (loop.type === 'tool.call' && typeof loop.name === 'string') {
          calls.push({ id: callId, name: loop.name });
        } else if (loop.type === 'tool.result' && callId) {
          results.set(callId, asRecord(loop.result).isError === true);
        }
      }
    }

    const toolCalls: NativeToolCall[] = calls.map(({ id, name }) => {
      const isRoomMcp = name.startsWith(MCP_PREFIX);
      return {
        name: isRoomMcp ? name.slice(MCP_PREFIX.length) : name,
        isRoomMcp,
        failed: id && results.has(id) ? results.get(id)! : null,
      };
    });
    return {
      usage: {
        inputTokens: sumOrNull(usages.map((u) => numberOrNull(u.inputOther))),
        outputTokens: sumOrNull(usages.map((u) => numberOrNull(u.output))),
        cacheReadTokens: sumOrNull(usages.map((u) => numberOrNull(u.inputCacheRead))),
        cacheWriteTokens: sumOrNull(usages.map((u) => numberOrNull(u.inputCacheCreation))),
        costUsd: null,
      },
      steps: usages.length,
      firstResponseAt,
      toolCalls,
    };
  },

  async deleteOriginal(ref) {
    await rm(ref.originalPath, { recursive: true, force: true });
    // 从索引中移除该会话的行，其余行原样保留：写同目录临时文件后原子 rename 覆盖。
    const file = indexPath();
    const text = await readText(file);
    if (text == null) return;
    const lines = text.split('\n');
    const kept = lines.filter((line) => {
      if (!line.trim()) return true;
      try {
        return asRecord(JSON.parse(line)).sessionId !== ref.sessionId;
      } catch {
        return true;
      }
    });
    if (kept.length === lines.length) return;
    const tmp = path.join(path.dirname(file), `.session_index.${randomUUID()}.tmp`);
    await writeFile(tmp, kept.join('\n'), 'utf-8');
    await rename(tmp, file);
  },
};
