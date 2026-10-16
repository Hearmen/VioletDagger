import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getNativeSessionAdapter, type LocateContext } from '../../src/agent-invocation/native-session';

// 原生会话适配器（04-agent-invocation.md §7.3–7.6），用临时目录模拟各 CLI 的原生会话位置。

const jsonl = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n';

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'violet-native-'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function writeRawLog(events: unknown[]): string {
  const file = path.join(root, 'raw.jsonl');
  const text = jsonl(events);
  // stdout 被拆成两个 chunk，验证按 offset 拼接后再切行。
  const mid = Math.floor(text.length / 2);
  writeFileSync(file, jsonl([
    { offset: 0, stream: 'stdout', text: text.slice(0, mid) },
    { offset: 1, stream: 'stderr', text: 'noise\n' },
    { offset: 2, stream: 'stdout', text: text.slice(mid) },
  ]));
  return file;
}

function ctx(overrides: Partial<LocateContext> = {}): LocateContext {
  return {
    roomId: 8, seq: 3, agentId: 'kimi', cwd: '/work',
    startedAt: '2026-10-11T11:00:00.000Z', endedAt: '2026-10-11T12:00:00.000Z',
    preassignedId: null, rawLogPath: path.join(root, 'raw.jsonl'),
    ...overrides,
  };
}

describe('unregistered registryKey', () => {
  it('returns a null adapter', async () => {
    const adapter = getNativeSessionAdapter('ghost');
    expect(adapter.preassignSessionId()).toBeNull();
    expect(await adapter.locate(ctx())).toBeNull();
    expect((await adapter.analyze({ storage: 'file', copyPath: root })).toolCalls).toBeNull();
  });
});

describe('claude adapter', () => {
  const id = '11111111-2222-3333-4444-555555555555';

  function writeTranscript() {
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(root, 'claude'));
    const dir = path.join(root, 'claude', 'projects', '-work');
    mkdirSync(path.join(dir, id, 'subagents'), { recursive: true });
    writeFileSync(path.join(dir, id, 'subagents', 'a.jsonl'), '{}\n');
    const usage1 = { input_tokens: 5, output_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 };
    writeFileSync(path.join(dir, `${id}.jsonl`), jsonl([
      { type: 'user', isSidechain: false, message: { role: 'user', content: 'prompt' } },
      // 同一响应拆成两条：用量取最后一条，内容块逐条收集。
      { type: 'assistant', isSidechain: false, timestamp: '2026-10-11T11:00:05.000Z',
        message: { id: 'm1', content: [{ type: 'thinking' }], usage: { ...usage1, output_tokens: 1 } } },
      { type: 'assistant', isSidechain: false, timestamp: '2026-10-11T11:00:06.000Z',
        message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'mcp__violetdagger__post_message' }], usage: usage1 } },
      { type: 'user', isSidechain: false, message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true }] } },
      { type: 'assistant', isSidechain: false, timestamp: '2026-10-11T11:00:09.000Z',
        message: { id: 'm2', content: [{ type: 'tool_use', id: 't2', name: 'Bash' }], usage: { input_tokens: 1, output_tokens: 2 } } },
      // 子 agent 记录不统计。
      { type: 'assistant', isSidechain: true, message: { id: 's1', content: [], usage: { input_tokens: 999 } } },
      { type: 'cost-state', totalCostUSD: 0.5, hasUnknownModelCost: false },
      { type: 'cost-state', totalCostUSD: 1.25, hasUnknownModelCost: false },
    ]));
    return dir;
  }

  it('preassigns a UUID, locates, copies file and directory, and analyzes the copy', async () => {
    const dir = writeTranscript();
    const adapter = getNativeSessionAdapter('claude');
    expect(adapter.preassignSessionId()).toMatch(/^[0-9a-f-]{36}$/);

    const ref = await adapter.locate(ctx({ preassignedId: id }));
    expect(ref).toEqual({ sessionId: id, storage: 'file', originalPath: path.join(dir, `${id}.jsonl`) });

    const copyDir = path.join(root, 'copy');
    const source = await adapter.archive(ref!, copyDir);
    expect(source).toEqual({ storage: 'file', copyPath: copyDir });
    expect(existsSync(path.join(copyDir, id, 'subagents', 'a.jsonl'))).toBe(true);

    const stats = await adapter.analyze(source!);
    expect(stats.usage).toEqual({ inputTokens: 6, outputTokens: 12, cacheReadTokens: 100, cacheWriteTokens: 7, costUsd: 1.25 });
    expect(stats.steps).toBe(2);
    expect(stats.firstResponseAt).toBe('2026-10-11T11:00:05.000Z');
    expect(stats.toolCalls).toEqual([
      { name: 'post_message', isRoomMcp: true, failed: true },
      { name: 'Bash', isRoomMcp: false, failed: null },
    ]);

    await adapter.deleteOriginal(ref!);
    expect(existsSync(path.join(dir, `${id}.jsonl`))).toBe(false);
    expect(existsSync(path.join(dir, id))).toBe(false);
    await expect(adapter.deleteOriginal(ref!)).resolves.toBeUndefined(); // 原件不存在视为成功
  });

  it('reports null cost when the model cost is unknown', async () => {
    const dir = writeTranscript();
    writeFileSync(path.join(dir, `${id}.jsonl`), jsonl([{ type: 'cost-state', totalCostUSD: 3, hasUnknownModelCost: true }]));
    const stats = await getNativeSessionAdapter('claude').analyze({ storage: 'file', copyPath: dir });
    expect(stats.usage.costUsd).toBeNull();
  });
});

describe('codex adapter', () => {
  const id = '01a12770-0b01-7d71-9e17-1a52382b40a1';

  it('locates through thread.started and analyzes token records and completed items', async () => {
    vi.stubEnv('CODEX_HOME', path.join(root, 'codex'));
    const dayDir = path.join(root, 'codex', 'sessions', '2026', '10', '11');
    mkdirSync(dayDir, { recursive: true });
    const file = path.join(dayDir, `rollout-2026-10-11T04-10-18-${id}.jsonl`);
    const item = (it: object) => ({ type: 'event_msg', payload: { type: 'item_completed', thread_id: id, item: it } });
    writeFileSync(file, jsonl([
      { type: 'session_meta', payload: { id } },
      { type: 'token_usage_record', timestamp: '2026-10-11T04:10:21.000Z',
        payload: { thread_id: id, usage: { input_tokens: 100, cached_input_tokens: 60, cache_write_input_tokens: 0, output_tokens: 7 } } },
      { type: 'token_usage_record', timestamp: '2026-10-11T04:10:25.000Z',
        payload: { thread_id: id, usage: { input_tokens: 50, cached_input_tokens: 40, output_tokens: 3 } } },
      { type: 'token_usage_record', payload: { thread_id: 'sub-agent', usage: { input_tokens: 9999 } } },
      item({ type: 'UserMessage' }),
      item({ type: 'Reasoning' }),
      item({ type: 'ContextCompaction' }),
      item({ type: 'McpToolCall', server: 'violetdagger', tool: 'post_message', status: 'failed' }),
      item({ type: 'McpToolCall', server: 'other', tool: 'search', status: 'completed' }),
      item({ type: 'CommandExecution', status: 'completed' }),
      item({ type: 'CommandExecution', status: 'in_progress' }),
      { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', status: 'completed' } },
    ]));
    const rawLogPath = writeRawLog([{ type: 'thread.started', thread_id: id }, { type: 'turn.started' }]);

    const adapter = getNativeSessionAdapter('codex');
    const ref = await adapter.locate(ctx({ rawLogPath }));
    expect(ref).toEqual({ sessionId: id, storage: 'file', originalPath: file });
    const source = await adapter.archive(ref!, path.join(root, 'copy'));
    const stats = await adapter.analyze(source!);
    expect(stats.usage).toEqual({ inputTokens: 50, outputTokens: 10, cacheReadTokens: 100, cacheWriteTokens: 0, costUsd: null });
    expect(stats.steps).toBe(2);
    expect(stats.firstResponseAt).toBe('2026-10-11T04:10:21.000Z');
    expect(stats.toolCalls).toEqual([
      { name: 'post_message', isRoomMcp: true, failed: true },
      { name: 'search', isRoomMcp: false, failed: false },
      { name: 'CommandExecution', isRoomMcp: false, failed: false },
      { name: 'CommandExecution', isRoomMcp: false, failed: null },
    ]);
  });

  it('returns null when stdout has no thread id', async () => {
    const rawLogPath = writeRawLog([{ type: 'turn.started' }]);
    expect(await getNativeSessionAdapter('codex').locate(ctx({ rawLogPath }))).toBeNull();
  });

  it('aborts analysis when the signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(getNativeSessionAdapter('codex').analyze({ storage: 'file', copyPath: root }, controller.signal))
      .rejects.toThrow();
  });
});

describe('opencode adapter', () => {
  const id = 'ses_abc';

  function writeDb(): string {
    vi.stubEnv('XDG_DATA_HOME', root);
    mkdirSync(path.join(root, 'opencode'), { recursive: true });
    const file = path.join(root, 'opencode', 'opencode.db');
    const db = new Database(file);
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);`);
    db.prepare(`INSERT INTO session VALUES (?)`).run(id);
    const msg = db.prepare(`INSERT INTO message VALUES (?, ?, ?, ?)`);
    msg.run('m0', id, 1, JSON.stringify({ role: 'user', time: { created: 1 } }));
    msg.run('m1', id, 2, JSON.stringify({ role: 'assistant', time: { created: 2, completed: 1791659683921 } }));
    const part = db.prepare(`INSERT INTO part VALUES (?, ?, ?, ?, ?)`);
    part.run('p1', 'm1', id, 1, JSON.stringify({ type: 'step-finish', cost: 0.25,
      tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 30, write: 1 } } }));
    part.run('p2', 'm1', id, 2, JSON.stringify({ type: 'step-finish', cost: 0.5,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }));
    part.run('p3', 'm1', id, 3, JSON.stringify({ type: 'tool', tool: 'violetdagger_get_detail', state: { status: 'error' } }));
    part.run('p4', 'm1', id, 4, JSON.stringify({ type: 'tool', tool: 'read', state: { status: 'completed' } }));
    part.run('p5', 'm1', 'ses_child', 5, JSON.stringify({ type: 'step-finish', tokens: { input: 999 } }));
    db.close();
    return file;
  }

  it('locates through stdout sessionID and analyzes the original database read-only', async () => {
    const file = writeDb();
    const rawLogPath = writeRawLog([{ type: 'step_start', sessionID: id }]);
    const adapter = getNativeSessionAdapter('opencode');
    const ref = await adapter.locate(ctx({ rawLogPath }));
    expect(ref).toEqual({ sessionId: id, storage: 'database', originalPath: file });
    const source = await adapter.archive(ref!, path.join(root, 'copy'));
    expect(source).toEqual({ storage: 'database', originalPath: file, sessionId: id });
    expect(existsSync(path.join(root, 'copy'))).toBe(false);

    const stats = await adapter.analyze(source!);
    expect(stats.usage).toEqual({ inputTokens: 11, outputTokens: 8, cacheReadTokens: 30, cacheWriteTokens: 1, costUsd: 0.75 });
    expect(stats.steps).toBe(2);
    expect(stats.firstResponseAt).toBe(new Date(1791659683921).toISOString());
    expect(stats.toolCalls).toEqual([
      { name: 'get_detail', isRoomMcp: true, failed: true },
      { name: 'read', isRoomMcp: false, failed: false },
    ]);
  });

  it('returns all-null stats when the table layout does not match', async () => {
    const file = path.join(root, 'other.db');
    new Database(file).close();
    const stats = await getNativeSessionAdapter('opencode').analyze({ storage: 'database', originalPath: file, sessionId: id });
    expect(stats).toEqual({
      usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null },
      steps: null, firstResponseAt: null, toolCalls: null,
    });
  });

  it('treats a session that is no longer in the database as already deleted', async () => {
    const file = writeDb();
    await expect(getNativeSessionAdapter('opencode').deleteOriginal({ sessionId: 'ses_gone', storage: 'database', originalPath: file }))
      .resolves.toBeUndefined();
  });
});

describe('kimi adapter', () => {
  const home = () => path.join(root, 'kimi');

  function writeSession(sessionId: string, opts: { workDir?: string; createdAt?: number; prompt?: string }) {
    const dir = path.join(home(), 'sessions', 'wd_x', sessionId);
    mkdirSync(path.join(dir, 'agents', 'main'), { recursive: true });
    writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ createdAt: opts.createdAt ?? Date.parse('2026-10-11T11:30:00Z') }));
    writeFileSync(path.join(dir, 'agents', 'main', 'wire.jsonl'), jsonl([
      { type: 'turn.prompt', input: [{ type: 'text', text: opts.prompt ?? '任务\nroomId：8\n你的 authorId：kimi\n\n正文' }] },
      { type: 'usage.record', agentId: 'main', usage: { inputOther: 10, output: 3, inputCacheRead: 20, inputCacheCreation: 0 }, time: 1791717620506 },
      { type: 'usage.record', agentId: 'main', usage: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 }, time: 1791717630000 },
      { type: 'context.append_loop_event', event: { type: 'tool.call', toolCallId: 'a', name: 'mcp__violetdagger__post_message' } },
      { type: 'context.append_loop_event', event: { type: 'tool.result', toolCallId: 'a', result: { isError: true } } },
      { type: 'context.append_loop_event', event: { type: 'tool.call', toolCallId: 'b', name: 'Read' } },
      { type: 'context.append_loop_event', event: { type: 'tool.result', toolCallId: 'b', result: { output: 'ok' } } },
      { type: 'context.append_loop_event', event: { type: 'tool.call', toolCallId: 'c', name: 'Bash' } },
    ]));
    return { sessionId, sessionDir: dir, workDir: opts.workDir ?? '/work' };
  }

  function writeIndex(entries: object[]) {
    writeFileSync(path.join(home(), 'session_index.jsonl'), jsonl(entries));
  }

  it('locates the unique matching session and analyzes the copy', async () => {
    vi.stubEnv('KIMI_CODE_HOME', home());
    const target = writeSession('session_a', {});
    writeIndex([
      target,
      writeSession('session_other_room', { prompt: 'roomId：80\n你的 authorId：kimi\n' }),
      writeSession('session_other_dir', { workDir: '/elsewhere' }),
      writeSession('session_too_early', { createdAt: Date.parse('2026-10-11T10:00:00Z') }),
    ]);
    const adapter = getNativeSessionAdapter('kimi');
    const ref = await adapter.locate(ctx());
    expect(ref).toEqual({ sessionId: 'session_a', storage: 'file', originalPath: target.sessionDir });

    const source = await adapter.archive(ref!, path.join(root, 'copy'));
    const stats = await adapter.analyze(source!);
    expect(stats.usage).toEqual({ inputTokens: 11, outputTokens: 4, cacheReadTokens: 20, cacheWriteTokens: 0, costUsd: null });
    expect(stats.steps).toBe(2);
    expect(stats.firstResponseAt).toBe(new Date(1791717620506).toISOString());
    expect(stats.toolCalls).toEqual([
      { name: 'post_message', isRoomMcp: true, failed: true },
      { name: 'Read', isRoomMcp: false, failed: false },
      { name: 'Bash', isRoomMcp: false, failed: null },
    ]);
  });

  it('fails to locate when more than one session matches', async () => {
    vi.stubEnv('KIMI_CODE_HOME', home());
    writeIndex([writeSession('session_a', {}), writeSession('session_b', {})]);
    expect(await getNativeSessionAdapter('kimi').locate(ctx())).toBeNull();
  });

  it('deletes the session directory and only its index line', async () => {
    vi.stubEnv('KIMI_CODE_HOME', home());
    const a = writeSession('session_a', {});
    const b = writeSession('session_b', {});
    writeIndex([a, b]);
    await getNativeSessionAdapter('kimi').deleteOriginal({ sessionId: 'session_a', storage: 'file', originalPath: a.sessionDir });
    expect(existsSync(a.sessionDir)).toBe(false);
    const remaining = readFileSync(path.join(home(), 'session_index.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(remaining).toEqual([b]);
  });
});
