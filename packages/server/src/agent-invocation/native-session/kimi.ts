import { randomUUID } from 'node:crypto';
import { readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  asRecord, copyInto, emptyStats, homeDir, isMissing, numberOrNull, parseJsonl, readJsonl, readStdoutEvents,
  ROOM_MCP_SERVER, stringOrNull, sumOrNull, toIso,
  type JsonRecord, type LocateContext, type LocatedNativeSession, type NativeSessionAdapter, type NativeToolCall,
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

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

// kimi 记录的是解析后的路径（如 macOS 上 /tmp/x 记为 /private/tmp/x）。路径已不存在时解析最近一个
// 仍存在的上级目录再拼回剩余部分；一路到根目录都解析不了时用原字符串比较。
async function resolvePath(dir: string): Promise<string> {
  let existing = path.resolve(dir);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(await realpath(existing), ...rest);
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return dir;
      rest.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

// prompt 模式结束时 stdout 的 session.resume_hint 带会话标识；没有 rawLog 或没有该事件时为 null。
async function resumeHintSessionId(rawLogPath: string): Promise<string | null> {
  let events: JsonRecord[];
  try {
    events = await readStdoutEvents(rawLogPath);
  } catch {
    return null;
  }
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.role === 'meta' && event.type === 'session.resume_hint') return stringOrNull(event.session_id);
  }
  return null;
}

// 在索引中查找会话标识对应的条目，并确认会话目录存在。
async function locateById(index: JsonRecord[], sessionId: string): Promise<LocatedNativeSession | null> {
  for (const entry of index) {
    if (entry.sessionId !== sessionId) continue;
    const sessionDir = stringOrNull(entry.sessionDir);
    if (sessionDir && (await isDirectory(sessionDir))) return { sessionId, storage: 'file', originalPath: sessionDir };
  }
  return null;
}

// 回退匹配：按工作目录、创建时间与 prompt 内容在索引中匹配，恰好一条才算成功。
async function locateByMatch(index: JsonRecord[], ctx: LocateContext): Promise<LocatedNativeSession | null> {
  const cwd = await resolvePath(ctx.cwd);
  const startMs = Date.parse(ctx.startedAt);
  const endMs = Date.parse(ctx.endedAt);
  const matches: { sessionId: string; sessionDir: string }[] = [];
  for (const entry of index) {
    const sessionId = stringOrNull(entry.sessionId);
    const sessionDir = stringOrNull(entry.sessionDir);
    const workDir = stringOrNull(entry.workDir);
    if (!sessionId || !sessionDir || !workDir || (await resolvePath(workDir)) !== cwd) continue;
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

  // 优先用 stdout 的 session.resume_hint 精确定位；没有该事件或索引里查不到时回退匹配。
  async locate(ctx) {
    const text = await readText(indexPath());
    if (text == null) return null;
    const index = parseJsonl(text);
    const hinted = await resumeHintSessionId(ctx.rawLogPath);
    const byId = hinted ? await locateById(index, hinted) : null;
    return byId ?? locateByMatch(index, ctx);
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
