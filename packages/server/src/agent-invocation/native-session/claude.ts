import { randomUUID } from 'node:crypto';
import { access, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  asRecord, copyInto, emptyStats, findInCopy, homeDir, listDir, numberOrNull, readJsonl, ROOM_MCP_SERVER,
  stringOrNull, sumOrNull, toIso,
  type NativeSessionAdapter, type NativeToolCall,
} from './adapter';

// claude 适配器（04-agent-invocation.md §7.3，文件型）。
const MCP_PREFIX = `mcp__${ROOM_MCP_SERVER}__`;

function claudeHome(): string {
  return homeDir('CLAUDE_CONFIG_DIR', path.join(os.homedir(), '.claude'));
}

export const claudeAdapter: NativeSessionAdapter = {
  registryKey: 'claude',

  preassignSessionId: () => randomUUID(),

  async locate(ctx) {
    const id = ctx.preassignedId;
    if (!id) return null;
    const projects = path.join(claudeHome(), 'projects');
    for (const dir of await listDir(projects)) {
      const file = path.join(projects, dir, `${id}.jsonl`);
      try {
        await access(file);
        return { sessionId: id, storage: 'file', originalPath: file };
      } catch {
        // 不在这个项目目录
      }
    }
    return null;
  },

  async archive(ref, copyDir) {
    const dir = ref.originalPath.replace(/\.jsonl$/, '');
    const ok = await copyInto(copyDir, [
      { from: ref.originalPath, to: path.basename(ref.originalPath) },
      { from: dir, to: path.basename(dir), optional: true },
    ]);
    return ok ? { storage: 'file', copyPath: copyDir } : null;
  },

  async analyze(source, signal) {
    signal?.throwIfAborted();
    if (source.storage !== 'file') return emptyStats();
    const file = await findInCopy(source.copyPath, (name) => name.endsWith('.jsonl'));
    if (!file) return emptyStats();
    const entries = await readJsonl(file, signal);

    // 同一响应按内容块拆成多条 assistant 条目、共享 message.id：用量取最后一条，内容块逐条收集。
    const lastById = new Map<string, Record<string, unknown>>();
    let firstResponseAt: string | null = null;
    const toolUses = new Map<string, string>(); // tool_use id → name
    const toolErrors = new Map<string, boolean>(); // tool_use id → is_error
    let costEntry: Record<string, unknown> | null = null;

    for (const entry of entries) {
      if (entry.type === 'cost-state') costEntry = entry;
      if (entry.isSidechain === true) continue;
      const message = asRecord(entry.message);
      const content = Array.isArray(message.content) ? message.content : [];
      if (entry.type === 'assistant') {
        const id = stringOrNull(message.id);
        if (!id) continue;
        lastById.set(id, message);
        firstResponseAt ??= toIso(entry.timestamp);
        for (const block of content.map(asRecord)) {
          if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
            toolUses.set(block.id, block.name);
          }
        }
      } else if (entry.type === 'user') {
        for (const block of content.map(asRecord)) {
          if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
            toolErrors.set(block.tool_use_id, block.is_error === true);
          }
        }
      }
    }

    const usages = [...lastById.values()].map((m) => asRecord(m.usage));
    const costUsd = costEntry && costEntry.hasUnknownModelCost !== true ? numberOrNull(costEntry.totalCostUSD) : null;
    const toolCalls: NativeToolCall[] = [...toolUses].map(([id, name]) => {
      const isRoomMcp = name.startsWith(MCP_PREFIX);
      return {
        name: isRoomMcp ? name.slice(MCP_PREFIX.length) : name,
        isRoomMcp,
        failed: toolErrors.has(id) ? toolErrors.get(id)! : null,
      };
    });

    return {
      usage: {
        inputTokens: sumOrNull(usages.map((u) => numberOrNull(u.input_tokens))),
        outputTokens: sumOrNull(usages.map((u) => numberOrNull(u.output_tokens))),
        cacheReadTokens: sumOrNull(usages.map((u) => numberOrNull(u.cache_read_input_tokens))),
        cacheWriteTokens: sumOrNull(usages.map((u) => numberOrNull(u.cache_creation_input_tokens))),
        costUsd,
      },
      steps: lastById.size,
      firstResponseAt,
      toolCalls,
    };
  },

  async deleteOriginal(ref) {
    await rm(ref.originalPath, { force: true });
    await rm(ref.originalPath.replace(/\.jsonl$/, ''), { recursive: true, force: true });
  },
};
