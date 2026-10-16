import { access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  asRecord, copyInto, emptyStats, findInCopy, homeDir, isMissing, listDir, numberOrNull, readJsonl, readStdoutEvents,
  ROOM_MCP_SERVER, runCommand, stringOrNull, sumOrNull, toIso,
  type NativeSessionAdapter, type NativeToolCall,
} from './adapter';

// codex 适配器（04-agent-invocation.md §7.4，文件型）。
const NON_TOOL_ITEMS = new Set(['UserMessage', 'AgentMessage', 'Reasoning']);

function codexHome(): string {
  return homeDir('CODEX_HOME', path.join(os.homedir(), '.codex'));
}

// rollout 文件按日期分目录：sessions/YYYY/MM/DD/rollout-<时间>-<id>.jsonl。
async function findRollout(id: string): Promise<string | null> {
  const root = path.join(codexHome(), 'sessions');
  const suffix = `-${id}.jsonl`;
  for (const year of await listDir(root)) {
    for (const month of await listDir(path.join(root, year))) {
      for (const day of await listDir(path.join(root, year, month))) {
        const dir = path.join(root, year, month, day);
        const name = (await listDir(dir)).find((n) => n.startsWith('rollout-') && n.endsWith(suffix));
        if (name) return path.join(dir, name);
      }
    }
  }
  return null;
}

export const codexAdapter: NativeSessionAdapter = {
  registryKey: 'codex',

  preassignSessionId: () => null,

  async locate(ctx) {
    const started = (await readStdoutEvents(ctx.rawLogPath)).find((e) => e.type === 'thread.started');
    const id = stringOrNull(started?.thread_id);
    if (!id) return null;
    const file = await findRollout(id);
    return file ? { sessionId: id, storage: 'file', originalPath: file } : null;
  },

  async archive(ref, copyDir) {
    const ok = await copyInto(copyDir, [{ from: ref.originalPath, to: path.basename(ref.originalPath) }]);
    return ok ? { storage: 'file', copyPath: copyDir } : null;
  },

  async analyze(source, signal) {
    signal?.throwIfAborted();
    if (source.storage !== 'file') return emptyStats();
    const file = await findInCopy(source.copyPath, (name) => name.startsWith('rollout-') && name.endsWith('.jsonl'));
    if (!file) return emptyStats();
    const entries = await readJsonl(file, signal);

    // 只统计本线程：子 agent 的记录带别的 thread_id。
    const meta = entries.find((e) => e.type === 'session_meta');
    const threadId = stringOrNull(asRecord(meta?.payload).id);
    const ownThread = (payload: Record<string, unknown>) =>
      threadId == null || payload.thread_id == null || payload.thread_id === threadId;

    const records: { usage: Record<string, unknown>; timestamp: unknown }[] = [];
    const toolCalls: NativeToolCall[] = [];
    for (const entry of entries) {
      const payload = asRecord(entry.payload);
      if (entry.type === 'token_usage_record' && ownThread(payload)) {
        records.push({ usage: asRecord(payload.usage), timestamp: entry.timestamp });
      } else if (entry.type === 'event_msg' && payload.type === 'item_completed' && ownThread(payload)) {
        const item = asRecord(payload.item);
        const type = stringOrNull(item.type);
        // 没有 status 字段的条目（SubAgentActivity、ContextCompaction 等）不是工具调用。
        if (!type || NON_TOOL_ITEMS.has(type) || !('status' in item)) continue;
        const failed = item.status === 'failed' ? true : item.status === 'completed' ? false : null;
        if (type === 'McpToolCall') {
          toolCalls.push({ name: String(item.tool ?? type), isRoomMcp: item.server === ROOM_MCP_SERVER, failed });
        } else {
          toolCalls.push({ name: type, isRoomMcp: false, failed });
        }
      }
    }

    const usages = records.map((r) => r.usage);
    // input_tokens 含缓存命中部分；非缓存输入 = input_tokens − cached_input_tokens。
    const inputs = usages.map((u) => {
      const input = numberOrNull(u.input_tokens);
      return input == null ? null : input - (numberOrNull(u.cached_input_tokens) ?? 0);
    });
    return {
      usage: {
        inputTokens: sumOrNull(inputs),
        outputTokens: sumOrNull(usages.map((u) => numberOrNull(u.output_tokens))),
        cacheReadTokens: sumOrNull(usages.map((u) => numberOrNull(u.cached_input_tokens))),
        cacheWriteTokens: sumOrNull(usages.map((u) => numberOrNull(u.cache_write_input_tokens))),
        costUsd: null,
      },
      steps: records.length,
      firstResponseAt: records.length ? toIso(records[0].timestamp) : null,
      toolCalls,
    };
  },

  async deleteOriginal(ref) {
    try {
      await access(ref.originalPath);
    } catch (err) {
      if (isMissing(err)) return; // 原件不存在视为成功
      throw err;
    }
    // codex 会同时清理自己的线程索引。
    // --force：非交互删除，不弹确认（需要 UUID 形式的 id）。
    await runCommand('codex', ['delete', '--force', ref.sessionId]);
  },
};
