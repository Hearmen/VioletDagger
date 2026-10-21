import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { createTestDb } from '../../src/storage/db';
import { createRoom, getRoom } from '../../src/storage/rooms';
import { createSession, finishSession, getSession } from '../../src/storage/sessions';
import { insertMessage } from '../../src/storage/messages';
import { createAgentInvocation } from '../../src/agent-invocation/agentInvocation';
import type { AgentRegistry, SpawnProcess, SpawnedProcess } from '../../src/agent-invocation/types';
import { createNullAdapter, type NativeSessionAdapter } from '../../src/agent-invocation/native-session';

// 测试用适配器：locate/archive/analyze 都可替换，默认定位成功的文件型会话。
function fakeAdapter(overrides: Partial<NativeSessionAdapter> = {}): NativeSessionAdapter {
  return {
    ...createNullAdapter('codex'),
    preassignSessionId: () => 'pre-id',
    locate: vi.fn(async () => ({ sessionId: 'thread-1', storage: 'file' as const, originalPath: '/home/.codex/r.jsonl' })),
    archive: vi.fn(async (_ref, copyDir: string) => ({ storage: 'file' as const, copyPath: copyDir })),
    analyze: vi.fn(async () => ({
      usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0, costUsd: null },
      steps: 1, firstResponseAt: null, toolCalls: [],
    })),
    ...overrides,
  };
}

vi.mock('node:fs', () => ({
  createWriteStream: vi.fn(() => {
    const listeners: Record<string, Array<(...args: any[]) => void>> = {};
    const register = (event: string, cb: (...args: any[]) => void) => {
      (listeners[event] ??= []).push(cb);
      return stream;
    };
    const stream: any = { writableEnded: false, on: vi.fn(register), once: vi.fn(register), write: vi.fn() };
    stream.end = vi.fn(() => {
      stream.writableEnded = true;
      // 真实 writable stream 的 'finish' 是异步触发的；这里同步触发即可，
      // 测试只关心 waitForLogFlush 最终会 resolve，不关心具体时序。
      (listeners.finish ?? []).forEach((cb) => cb());
    });
    return stream;
  }),
  mkdirSync: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
  rm: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

import { createWriteStream, mkdirSync } from 'node:fs';
import { readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function createFakeProcess(pid = 424242) {
  const stdoutListeners: ((data: Buffer) => void)[] = [];
  const stderrListeners: ((data: Buffer) => void)[] = [];
  const errorListeners: ((err: Error) => void)[] = [];
  const closeListeners: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
  const process: SpawnedProcess = {
    pid,
    stdout: { on: (_ev: string, cb: any) => stdoutListeners.push(cb) } as any,
    stderr: { on: (_ev: string, cb: any) => stderrListeners.push(cb) } as any,
    stdin: { on: vi.fn(), write: vi.fn(), end: vi.fn() } as any,
    on: (event: string, cb: any) => {
      if (event === 'error') errorListeners.push(cb);
      else if (event === 'close') closeListeners.push(cb);
    },
    kill: vi.fn(() => true),
  };
  return {
    proc: process,
    emitStdout: (data: string) => stdoutListeners.forEach((cb) => cb(Buffer.from(data))),
    emitStderr: (data: string) => stderrListeners.forEach((cb) => cb(Buffer.from(data))),
    emitError: (err: Error) => errorListeners.forEach((cb) => cb(err)),
    emitClose: (code: number | null, signal: NodeJS.Signals | null = null) => closeListeners.forEach((cb) => cb(code, signal)),
    stdin: process.stdin as any,
  };
}

const registry: AgentRegistry = {
  agents: { codex: { command: ['codex', 'exec', '--json', '{{promptFile}}'], stopGraceMs: 20, stopConfirmMs: 30 } },
};

describe('createAgentInvocation - startSession', () => {
  beforeEach(() => {
    vi.mocked(mkdirSync).mockReset();
    vi.mocked(writeFile).mockReset().mockResolvedValue(undefined);
    vi.mocked(createWriteStream).mockClear();
  });

  function setup(reg: AgentRegistry = registry, getAdapter?: (key: string) => NativeSessionAdapter) {
    const db = createTestDb();
    const roomAgent = Object.keys(reg.agents)[0];
    const room = createRoom(db, 'a', [roomAgent], 'parallel');
    const session = createSession(db, room.id, roomAgent, 'broadcast', 'room_flag');
    insertMessage(db, { roomId: room.id, sessionSeq: session.seq, authorId: 'human', content: 'goal text' });
    const fake = createFakeProcess();
    const spawnProcess = vi.fn(() => fake.proc) as unknown as SpawnProcess;
    const onSessionEnded = vi.fn();
    const onSessionExitProgress = vi.fn();
    const invocation = createAgentInvocation({
      db, registry: reg, onSessionEnded, onSessionExitProgress,
      logsDir: '/logs', mcpUrl: 'http://127.0.0.1:4201', spawnProcess, getAdapter,
    });
    return { db, room, session, fake, spawnProcess, onSessionEnded, onSessionExitProgress, invocation };
  }

  it('pauses rather than truncates or spawns when the memory prompt exceeds its budget', () => {
    const { room, session, spawnProcess, invocation, db, onSessionEnded } = setup();
    vi.stubEnv('VIOLETDAGGER_MAX_PROMPT_BYTES', '20');
    try {
      invocation.startSession({ roomId: room.id, seq: session.seq, agentId: 'codex', registryKey: 'codex' });
      expect(spawnProcess).not.toHaveBeenCalled();
      expect(getRoom(db, room.id)?.status).toBe('paused_manual');
      expect(onSessionEnded).toHaveBeenCalledWith(expect.objectContaining({ exitCause: 'spawn-failed', seq: session.seq }));
    } finally { vi.unstubAllEnvs(); }
  });

  it('execs the configured argv non-interactively with placeholders substituted, and records pgid/rawLogPath', async () => {
    const { room, session, spawnProcess, invocation, db } = setup();

    invocation.startSession({ roomId: room.id, seq: session.seq, agentId: 'codex', registryKey: 'codex' });
    await flush();

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = vi.mocked(spawnProcess).mock.calls[0];
    expect(bin).toBe('codex');
    expect(args).toContain('exec');
    expect(args.join(' ')).toContain(`violetdagger-${room.id}-${session.seq}.prompt.txt`);
    expect(opts.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    const stored = getSession(db, room.id, session.seq)!;
    expect(stored.pgid).toBe(424242);
    expect(stored.rawLogPath).toContain(`${room.id}/${session.seq}.jsonl`);
  });

  it('substitutes {{prompt}} with the prompt text as a single argv element', async () => {
    const promptRegistry: AgentRegistry = { agents: { codex: { command: ['codex', '{{prompt}}'] } } };
    const { room, session, spawnProcess, invocation } = setup(promptRegistry);

    invocation.startSession({ roomId: room.id, seq: session.seq, agentId: 'codex', registryKey: 'codex' });
    await flush();

    const args = vi.mocked(spawnProcess).mock.calls[0][1];
    expect(args).toHaveLength(1);
    expect(args[0]).toContain('你的 authorId：codex');
    expect(args[0]).not.toContain('{{prompt}}');
  });

  it('writes an independent per-session mcpFile and substitutes it into env values', async () => {
    const envRegistry: AgentRegistry = {
      agents: {
        opencode: {
          command: ['opencode', 'run', '{{prompt}}'],
          env: { OPENCODE_CONFIG: '{{mcpFile}}' },
          mcpFile: { template: '{"mcp":{"url":"{{mcpUrl}}"}}' },
        },
      },
    };
    const { room, session, spawnProcess, invocation } = setup(envRegistry);

    invocation.startSession({ roomId: room.id, seq: session.seq, agentId: 'opencode', registryKey: 'opencode' });
    await flush();

    const opts = vi.mocked(spawnProcess).mock.calls[0][2];
    expect(opts.env?.OPENCODE_CONFIG).toBe(`/logs/mcp/${room.id}/${session.seq}.json`);
    expect(opts.env?.PATH).toBe(process.env.PATH);
    // mcp template 写入时替换了 {{mcpUrl}}。
    const mcpWrite = vi.mocked(writeFile).mock.calls.find((call) => String(call[0]).includes('/mcp/'));
    expect(String(mcpWrite?.[1])).toContain('http://127.0.0.1:4201');
    expect(String(mcpWrite?.[1])).not.toContain('{{mcpUrl}}');
  });

  it('resolves a configured cwd-relative mcpFile path and substitutes {{mcpFile}} into the command', async () => {
    const pathRegistry: AgentRegistry = {
      agents: {
        kimi: {
          command: ['kimi', '--mcp-config', '{{mcpFile}}'],
          mcpFile: { path: 'relative/mcp.json', template: '{"a":1}' },
        },
      },
    };
    const { room, session, spawnProcess, invocation } = setup(pathRegistry);
    invocation.startSession({ roomId: room.id, seq: session.seq, agentId: 'kimi', registryKey: 'kimi' });
    await flush();

    const args = vi.mocked(spawnProcess).mock.calls[0][1];
    expect(args[1]).toBe(path.resolve(process.cwd(), 'relative/mcp.json'));
    expect(args[1]).not.toContain('{{mcpFile}}');
  });

  it('merges into an existing shared mcpFile without dropping other servers', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(
      JSON.stringify({ mcpServers: { other: { url: 'http://other' } } }) as any,
    );
    const mergeRegistry: AgentRegistry = {
      agents: {
        kimi: {
          command: ['kimi', '--auto', '-p', '{{prompt}}'],
          mcpFile: {
            path: '.kimi-code/mcp.json',
            merge: true,
            template: '{"mcpServers":{"violetdagger":{"url":"{{mcpUrl}}"}}}',
          },
        },
      },
    };
    const { room, session, invocation } = setup(mergeRegistry);
    invocation.startSession({ roomId: room.id, seq: session.seq, agentId: 'kimi', registryKey: 'kimi' });
    await flush();

    const mcpWrite = vi.mocked(writeFile).mock.calls.find((call) => String(call[0]).endsWith('mcp.json'));
    const written = JSON.parse(String(mcpWrite?.[1]));
    expect(written.mcpServers.other).toEqual({ url: 'http://other' });
    expect(written.mcpServers.violetdagger).toEqual({ url: 'http://127.0.0.1:4201' });
  });

  it('expands ~/.kimi-code to $KIMI_CODE_HOME when set', async () => {
    const previous = process.env.KIMI_CODE_HOME;
    process.env.KIMI_CODE_HOME = '/tmp/kimi-home';
    try {
      const kimiRegistry: AgentRegistry = {
        agents: {
          kimi: { command: ['kimi', '-p', '{{prompt}}'], mcpFile: { path: '~/.kimi-code/mcp.json', template: '{}' } },
        },
      };
      const { room, session, invocation } = setup(kimiRegistry);
      invocation.startSession({ roomId: room.id, seq: session.seq, agentId: 'kimi', registryKey: 'kimi' });
      await flush();
      const mcpWrite = vi.mocked(writeFile).mock.calls.find((call) => String(call[0]).includes('mcp.json'));
      expect(mcpWrite?.[0]).toBe('/tmp/kimi-home/mcp.json');
    } finally {
      if (previous === undefined) delete process.env.KIMI_CODE_HOME;
      else process.env.KIMI_CODE_HOME = previous;
    }
  });

  it('records stdout/stderr as offset chunk events and reports natural exit on code 0', async () => {
    const { room, session, fake, invocation, onSessionEnded } = setup();

    invocation.startSession({ roomId: room.id, seq: session.seq, agentId: 'codex', registryKey: 'codex' });
    await flush();
    fake.emitStdout('hello ');
    fake.emitStderr('oops');
    fake.emitClose(0);
    await flush();

    expect(onSessionEnded).toHaveBeenCalledTimes(1);
    expect(onSessionEnded.mock.calls[0][0]).toMatchObject({
      roomId: room.id, seq: session.seq, agentId: 'codex', exitCode: 0, exitCause: 'natural',
    });
  });

  it('runs locate → archive → analyze after exit and attaches usage and native ref (04-agent-invocation.md §7.2)', async () => {
    const adapter = fakeAdapter();
    const { room, session, fake, invocation, onSessionEnded } = setup(registry, () => adapter);
    invocation.startSession({ roomId: room.id, seq: session.seq, agentId: 'codex', registryKey: 'codex' });
    await flush();
    fake.emitClose(0);
    await flush();

    expect(adapter.locate).toHaveBeenCalledWith(expect.objectContaining({
      roomId: room.id, seq: session.seq, agentId: 'codex', preassignedId: 'pre-id',
      rawLogPath: path.join('/logs', String(room.id), `${session.seq}.jsonl`),
    }));
    const copyDir = path.join('/logs', String(room.id), 'native', String(session.seq));
    expect(adapter.archive).toHaveBeenCalledWith(expect.anything(), copyDir);
    const event = onSessionEnded.mock.calls[0][0];
    expect(event.usage).toEqual({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0, costUsd: null });
    expect(event.native).toEqual({ sessionId: 'thread-1', storage: 'file', originalPath: '/home/.codex/r.jsonl', copyPath: copyDir });
  });

  it('injects the preassigned id into {{nativeSessionId}}', async () => {
    const reg: AgentRegistry = { agents: { codex: { command: ['codex', '--session-id', '{{nativeSessionId}}'] } } };
    const { room, session, spawnProcess, invocation } = setup(reg, () => fakeAdapter());
    invocation.startSession({ roomId: room.id, seq: session.seq, agentId: 'codex', registryKey: 'codex' });
    await flush();
    expect(vi.mocked(spawnProcess).mock.calls[0][1]).toEqual(['--session-id', 'pre-id']);
  });

  it('reports all-null usage and no native ref when locate finds nothing', async () => {
    const { room, session, fake, invocation, onSessionEnded } = setup(registry, () => fakeAdapter({ locate: async () => null }));
    invocation.startSession({ roomId: room.id, seq: session.seq, agentId: 'codex', registryKey: 'codex' });
    await flush();
    fake.emitClose(0);
    await flush();
    const event = onSessionEnded.mock.calls[0][0];
    expect(event.usage).toEqual({ inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null });
    expect(event.native).toBeUndefined();
  });

  it('keeps the native ref without a copy when archive fails, and never changes the exit cause', async () => {
    const adapter = fakeAdapter({ archive: async () => { throw new Error('disk full'); } });
    const { room, session, fake, invocation, onSessionEnded, onSessionExitProgress } = setup(registry, () => adapter);
    invocation.startSession({ roomId: room.id, seq: session.seq, agentId: 'codex', registryKey: 'codex' });
    await flush();
    fake.emitClose(0);
    await flush();
    const event = onSessionEnded.mock.calls[0][0];
    expect(event.exitCause).toBe('natural');
    expect(event.native).toMatchObject({ sessionId: 'thread-1', copyPath: null });
    expect(event.usage.inputTokens).toBeNull();
    expect(adapter.analyze).not.toHaveBeenCalled();
    expect(onSessionExitProgress).toHaveBeenCalledWith(room.id, session.seq, 'native_session_failed', 'disk full', 'archive');
  });

  it('records a failed copy (archive returns null) but not a session that locate could not find', async () => {
    const failing = setup(registry, () => fakeAdapter({ archive: async () => null }));
    failing.invocation.startSession({ roomId: failing.room.id, seq: failing.session.seq, agentId: 'codex', registryKey: 'codex' });
    await flush();
    failing.fake.emitClose(0);
    await flush();
    expect(failing.onSessionExitProgress).toHaveBeenCalledWith(
      failing.room.id, failing.session.seq, 'native_session_failed', 'copy failed', 'archive',
    );

    const missing = setup(registry, () => fakeAdapter({ locate: async () => null }));
    missing.invocation.startSession({ roomId: missing.room.id, seq: missing.session.seq, agentId: 'codex', registryKey: 'codex' });
    await flush();
    missing.fake.emitClose(0);
    await flush();
    expect(missing.onSessionExitProgress).not.toHaveBeenCalledWith(
      expect.anything(), expect.anything(), 'native_session_failed', expect.anything(), expect.anything(),
    );
  });

  it('does not attempt to parse usage for a spawn-failed session', async () => {
    const { room, session, spawnProcess, invocation, onSessionEnded } = setup();
    invocation.startSession({ roomId: room.id, seq: session.seq, agentId: 'ghost', registryKey: 'ghost' });
    await flush();
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(onSessionEnded.mock.calls[0][0].usage).toBeUndefined();
    expect(onSessionEnded.mock.calls[0][0].native).toBeUndefined();
  });

  it('reports unexpected exit on nonzero close', async () => {
    const { room, session, fake, invocation, onSessionEnded } = setup();
    invocation.startSession({ roomId: room.id, seq: session.seq, agentId: 'codex', registryKey: 'codex' });
    await flush();
    fake.emitClose(3);
    await flush();
    expect(onSessionEnded.mock.calls[0][0]).toMatchObject({ exitCode: 3, exitCause: 'unexpected' });
  });

  it('reports spawn-failed when spawnProcess throws synchronously', async () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'parallel');
    const session = createSession(db, room.id, 'codex', 'broadcast', 'room_flag');
    insertMessage(db, { roomId: room.id, sessionSeq: session.seq, authorId: 'human', content: 'goal' });
    const onSessionEnded = vi.fn();
    const invocation = createAgentInvocation({
      db, registry, onSessionEnded, logsDir: '/logs', mcpUrl: 'http://x',
      spawnProcess: (() => { throw new Error('ENOENT'); }) as unknown as SpawnProcess,
    });

    invocation.startSession({ roomId: room.id, seq: session.seq, agentId: 'codex', registryKey: 'codex' });
    await flush();

    expect(onSessionEnded).toHaveBeenCalledTimes(1);
    expect(onSessionEnded.mock.calls[0][0].exitCause).toBe('spawn-failed');
  });

  it('reports spawn-failed on the process error event', async () => {
    const { room, session, fake, invocation, onSessionEnded } = setup();
    invocation.startSession({ roomId: room.id, seq: session.seq, agentId: 'codex', registryKey: 'codex' });
    await flush();
    fake.emitError(new Error('boom'));
    expect(onSessionEnded.mock.calls[0][0].exitCause).toBe('spawn-failed');
  });

  it('reports spawn-failed without spawning when the registryKey is unknown', async () => {
    const { room, session, spawnProcess, invocation, onSessionEnded } = setup();
    invocation.startSession({ roomId: room.id, seq: session.seq, agentId: 'ghost', registryKey: 'ghost' });
    await flush();
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(onSessionEnded.mock.calls[0][0]).toMatchObject({ exitCause: 'spawn-failed' });
  });

  it('reports spawn-failed with the real rawLogPath when prompt writing rejects, without spawning', async () => {
    vi.mocked(writeFile).mockRejectedValueOnce(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }));
    const { room, session, spawnProcess, invocation, onSessionEnded } = setup();
    invocation.startSession({ roomId: room.id, seq: session.seq, agentId: 'codex', registryKey: 'codex' });
    await flush();
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(onSessionEnded.mock.calls[0][0]).toMatchObject({
      exitCause: 'spawn-failed',
      rawLogPath: expect.stringContaining(`${room.id}/${session.seq}.jsonl`),
    });
  });

  it('writes JSONL log events with offset/stream/text', async () => {
    const { room, session, fake, invocation } = setup();
    invocation.startSession({ roomId: room.id, seq: session.seq, agentId: 'codex', registryKey: 'codex' });
    await flush();
    fake.emitStdout('a');
    fake.emitStderr('b');

    const stream = vi.mocked(createWriteStream).mock.results[0].value as any;
    const written = stream.write.mock.calls.map((call: any[]) => JSON.parse(call[0]));
    expect(written).toEqual([
      { offset: 0, stream: 'stdout', text: 'a' },
      { offset: 1, stream: 'stderr', text: 'b' },
    ]);
  });

  it('reports only once when close fires twice (idempotency)', async () => {
    const { room, session, fake, invocation, onSessionEnded } = setup();
    invocation.startSession({ roomId: room.id, seq: session.seq, agentId: 'codex', registryKey: 'codex' });
    await flush();
    fake.emitClose(0);
    fake.emitClose(0);
    await flush();
    expect(onSessionEnded).toHaveBeenCalledTimes(1);
  });

  it('does not crash when the onSessionEnded handler throws', async () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'parallel');
    const session = createSession(db, room.id, 'codex', 'broadcast', 'room_flag');
    insertMessage(db, { roomId: room.id, sessionSeq: session.seq, authorId: 'human', content: 'goal' });
    const fake = createFakeProcess();
    const onSessionEnded = vi.fn(() => { throw new Error('handler boom'); });
    const invocation = createAgentInvocation({
      db, registry, onSessionEnded, logsDir: '/logs', mcpUrl: 'http://x',
      spawnProcess: (() => fake.proc) as unknown as SpawnProcess,
    });
    invocation.startSession({ roomId: room.id, seq: session.seq, agentId: 'codex', registryKey: 'codex' });
    await flush();
    expect(() => fake.emitClose(0)).not.toThrow();
    await flush();
    expect(onSessionEnded).toHaveBeenCalledTimes(1);
  });

  it('delivers the prompt via stdin and closes stdin when promptVia is stdin', async () => {
    const stdinRegistry: AgentRegistry = { agents: { kimi: { command: ['kimi', '--auto'], promptVia: 'stdin' } } };
    const { room, session, fake, spawnProcess, invocation } = setup(stdinRegistry);
    invocation.startSession({ roomId: room.id, seq: session.seq, agentId: 'kimi', registryKey: 'kimi' });
    await flush();
    expect(spawnProcess.mock.calls[0][2].stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect(fake.stdin.write).toHaveBeenCalledTimes(1);
    expect(fake.stdin.write.mock.calls[0][0]).toContain('你的 authorId：kimi');
    expect(fake.stdin.end).toHaveBeenCalled();
  });
});

describe('createAgentInvocation - attachSessionLog', () => {
  beforeEach(() => {
    vi.mocked(createWriteStream).mockClear();
    vi.mocked(writeFile).mockReset().mockResolvedValue(undefined);
  });

  function setup() {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'parallel');
    const session = createSession(db, room.id, 'codex', 'broadcast', 'room_flag');
    insertMessage(db, { roomId: room.id, sessionSeq: session.seq, authorId: 'human', content: 'goal' });
    const fake = createFakeProcess();
    const invocation = createAgentInvocation({
      db, registry, onSessionEnded: vi.fn(), logsDir: '/logs', mcpUrl: 'http://x',
      spawnProcess: (() => fake.proc) as unknown as SpawnProcess,
    });
    return { db, room, session, fake, invocation };
  }

  it('returns null for an unknown session', () => {
    const { invocation } = setup();
    expect(invocation.attachSessionLog(1, 99)).toBeNull();
  });

  it('exposes snapshot + incremental chunks + exit and has no write/resize', async () => {
    const { room, session, fake, invocation } = setup();
    invocation.startSession({ roomId: room.id, seq: session.seq, agentId: 'codex', registryKey: 'codex' });
    await flush();
    fake.emitStdout('first');

    const handle = invocation.attachSessionLog(room.id, session.seq)!;
    expect(handle.snapshot()).toEqual({ chunks: [{ offset: 0, stream: 'stdout', text: 'first' }], truncated: false });
    expect((handle as any).write).toBeUndefined();
    expect((handle as any).resize).toBeUndefined();

    const received: number[] = [];
    const exits: number[] = [];
    handle.onData((chunk) => received.push(chunk.offset));
    handle.onExit((event) => exits.push(event.exitCode ?? -1));
    fake.emitStdout('second');
    fake.emitClose(0, null);
    await flush();

    expect(received).toEqual([1]);
    expect(exits).toEqual([0]);
  });

  it('returns null once the session has exited', async () => {
    const { room, session, fake, invocation } = setup();
    invocation.startSession({ roomId: room.id, seq: session.seq, agentId: 'codex', registryKey: 'codex' });
    await flush();
    fake.emitClose(0);
    await flush();
    expect(invocation.attachSessionLog(room.id, session.seq)).toBeNull();
  });
});

describe('createAgentInvocation - stopSessionProcess', () => {
  beforeEach(() => {
    vi.mocked(createWriteStream).mockClear();
    vi.mocked(writeFile).mockReset().mockResolvedValue(undefined);
  });

  function setup(stopGraceMs = 20, stopConfirmMs = 30, getAdapter?: (key: string) => NativeSessionAdapter) {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'parallel');
    const session = createSession(db, room.id, 'codex', 'broadcast', 'room_flag');
    insertMessage(db, { roomId: room.id, sessionSeq: session.seq, authorId: 'human', content: 'goal' });
    const fake = createFakeProcess();
    const reg: AgentRegistry = { agents: { codex: { command: ['codex'], stopGraceMs, stopConfirmMs } } };
    const invocation = createAgentInvocation({
      db, registry: reg, onSessionEnded: vi.fn(), logsDir: '/logs', mcpUrl: 'http://x',
      spawnProcess: (() => fake.proc) as unknown as SpawnProcess, getAdapter,
    });
    return { db, room, session, fake, invocation };
  }

  it('returns unconfirmed for an unknown session', async () => {
    const { invocation } = setup();
    await expect(invocation.stopSessionProcess(1, 99)).resolves.toMatchObject({ confirmed: false });
  });

  it('sends SIGTERM and returns managed-stop when the process exits within the grace period', async () => {
    const { room, session, fake, invocation } = setup();
    invocation.startSession({ roomId: room.id, seq: session.seq, agentId: 'codex', registryKey: 'codex' });
    await flush();

    const pending = invocation.stopSessionProcess(room.id, session.seq);
    await new Promise((resolve) => setTimeout(resolve, 5));
    fake.emitClose(null, 'SIGTERM');
    const result = await pending;

    expect(fake.proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(fake.proc.kill).not.toHaveBeenCalledWith('SIGKILL');
    expect(result).toMatchObject({ confirmed: true, exit: { exitCause: 'managed-stop', signal: 'SIGTERM' } });
  });

  it('returns only after native analysis finishes, even when it outlasts the confirm window (04 §5)', async () => {
    let release!: () => void;
    const adapter = fakeAdapter({
      analyze: vi.fn(() => new Promise((resolve) => {
        release = () => resolve({
          usage: { inputTokens: 9, outputTokens: 9, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null },
          steps: 1, firstResponseAt: null, toolCalls: [],
        });
      })),
    });
    const { room, session, fake, invocation } = setup(5, 10, () => adapter);
    invocation.startSession({ roomId: room.id, seq: session.seq, agentId: 'codex', registryKey: 'codex' });
    await flush();

    let settled = false;
    const pending = invocation.stopSessionProcess(room.id, session.seq).then((result) => { settled = true; return result; });
    fake.emitClose(null, 'SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(settled).toBe(false);
    expect(fake.proc.kill).not.toHaveBeenCalledWith('SIGKILL');
    release();
    await expect(pending).resolves.toMatchObject({
      confirmed: true, exit: { exitCause: 'managed-stop', usage: { inputTokens: 9 }, native: { sessionId: 'thread-1' } },
    });
  });

  it('escalates to SIGKILL when still alive after the grace period', async () => {
    const { room, session, fake, invocation } = setup(5, 200);
    invocation.startSession({ roomId: room.id, seq: session.seq, agentId: 'codex', registryKey: 'codex' });
    await flush();

    const pending = invocation.stopSessionProcess(room.id, session.seq);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.proc.kill).toHaveBeenCalledWith('SIGKILL');
    fake.emitClose(null, 'SIGKILL');
    await expect(pending).resolves.toMatchObject({ confirmed: true, exit: { exitCause: 'managed-stop' } });
  });

  it('reports cleanup_failed and returns unconfirmed when exit cannot be confirmed', async () => {
    const { room, session, invocation } = setup(5, 5);
    invocation.startSession({ roomId: room.id, seq: session.seq, agentId: 'codex', registryKey: 'codex' });
    await flush();
    const result = await invocation.stopSessionProcess(room.id, session.seq);
    expect(result).toMatchObject({ confirmed: false });
  });

  it('cancels startup (not-started) when terminated during the prompt-write window', async () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'parallel');
    const session = createSession(db, room.id, 'codex', 'broadcast', 'room_flag');
    insertMessage(db, { roomId: room.id, sessionSeq: session.seq, authorId: 'human', content: 'goal' });
    let releasePrepare: () => void = () => {};
    vi.mocked(writeFile).mockImplementationOnce(() => new Promise<void>((resolve) => { releasePrepare = resolve; }));
    const fake = createFakeProcess();
    const spawnProcess = vi.fn(() => fake.proc) as unknown as SpawnProcess;
    const invocation = createAgentInvocation({
      db, registry, onSessionEnded: vi.fn(), logsDir: '/logs', mcpUrl: 'http://x', spawnProcess,
    });

    invocation.startSession({ roomId: room.id, seq: session.seq, agentId: 'codex', registryKey: 'codex' });
    await flush();
    const result = await invocation.stopSessionProcess(room.id, session.seq);
    releasePrepare();
    await flush();

    expect(result).toMatchObject({ confirmed: true, exit: { exitCause: 'not-started' } });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('shares a single cleanup promise across concurrent stop requests', async () => {
    const { room, session, fake, invocation } = setup(50, 50);
    invocation.startSession({ roomId: room.id, seq: session.seq, agentId: 'codex', registryKey: 'codex' });
    await flush();

    const first = invocation.stopSessionProcess(room.id, session.seq);
    const second = invocation.stopSessionProcess(room.id, session.seq);
    expect(first).toBe(second);
    fake.emitClose(null, 'SIGTERM');
    await first;
  });
});

describe('createAgentInvocation - deleteRoomArtifacts', () => {
  afterEach(() => {
    vi.mocked(rm).mockClear();
    vi.mocked(readdir).mockClear();
    vi.mocked(unlink).mockClear();
  });

  it('removes room logs, per-session mcp configs, and prompt files only', async () => {
    const db = createTestDb();
    vi.mocked(readdir).mockResolvedValueOnce(['violetdagger-1-1.prompt.txt', 'other.txt'] as any);
    const invocation = createAgentInvocation({
      db, registry, onSessionEnded: vi.fn(), logsDir: '/logs', mcpUrl: 'http://x', promptDir: '/logs/prompts',
    });

    await invocation.deleteRoomArtifacts(1);

    expect(vi.mocked(rm).mock.calls.map((call) => call[0])).toEqual([
      '/logs/1',
      path.join('/logs', 'mcp', '1'),
    ]);
    expect(vi.mocked(unlink)).toHaveBeenCalledWith('/logs/prompts/violetdagger-1-1.prompt.txt');
    expect(vi.mocked(unlink)).not.toHaveBeenCalledWith('/logs/prompts/other.txt');
  });

  it('deletes native originals recorded on sessions and returns per-original failures without stopping', async () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex', 'claude', 'kimi'], 'parallel');
    const native = (sessionId: string) => ({ sessionId, storage: 'file' as const, originalPath: `/orig/${sessionId}`, copyPath: null });
    const s1 = createSession(db, room.id, 'codex', 'broadcast', 'room_flag');
    finishSession(db, room.id, s1.seq, 'completed', undefined, undefined, undefined, native('a'));
    const s2 = createSession(db, room.id, 'claude', 'broadcast', 'room_flag');
    finishSession(db, room.id, s2.seq, 'completed', undefined, undefined, undefined, native('b'));
    const s3 = createSession(db, room.id, 'kimi', 'broadcast', 'room_flag');
    finishSession(db, room.id, s3.seq, 'error'); // 没有原生会话引用：跳过

    const deleted: string[] = [];
    const getAdapter = (key: string) => fakeAdapter({
      deleteOriginal: async (ref) => {
        if (key === 'codex') throw new Error('codex delete timed out');
        deleted.push(`${key}:${ref.sessionId}`);
      },
    });
    const invocation = createAgentInvocation({
      db, registry, onSessionEnded: vi.fn(), logsDir: '/logs', mcpUrl: 'http://x', promptDir: '/logs/prompts', getAdapter,
    });

    const failures = await invocation.deleteRoomArtifacts(room.id);

    expect(deleted).toEqual(['claude:b']);
    expect(failures).toEqual([{ seq: s1.seq, agentId: 'codex', target: '/orig/a', error: 'codex delete timed out' }]);
    expect(vi.mocked(rm)).toHaveBeenCalledWith(`/logs/${room.id}`, { recursive: true, force: true });
  });
});
