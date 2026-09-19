import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { createTestDb } from '../../src/storage/db';
import { createRoom, getRoom } from '../../src/storage/rooms';
import { createSession, getSession } from '../../src/storage/sessions';
import { insertMessage } from '../../src/storage/messages';
import { createAgentInvocation } from '../../src/agent-invocation/agentInvocation';
import type { AgentRegistry, SpawnProcess, SpawnedProcess } from '../../src/agent-invocation/types';

vi.mock('node:fs', () => ({
  createWriteStream: vi.fn(() => {
    const stream: any = { writableEnded: false, on: vi.fn(), write: vi.fn() };
    stream.end = vi.fn(() => {
      stream.writableEnded = true;
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

  function setup(reg: AgentRegistry = registry) {
    const db = createTestDb();
    const roomAgent = Object.keys(reg.agents)[0];
    const room = createRoom(db, 'a', [roomAgent], 'sequential');
    const session = createSession(db, room.id, roomAgent);
    insertMessage(db, { roomId: room.id, sessionSeq: session.seq, authorId: 'human', content: 'goal text' });
    const fake = createFakeProcess();
    const spawnProcess = vi.fn(() => fake.proc) as unknown as SpawnProcess;
    const onSessionEnded = vi.fn();
    const onSessionExitProgress = vi.fn();
    const invocation = createAgentInvocation({
      db, registry: reg, onSessionEnded, onSessionExitProgress,
      logsDir: '/logs', mcpUrl: 'http://127.0.0.1:4201', spawnProcess,
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
    expect(args[0]).toContain('authorId: codex');
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

    expect(onSessionEnded).toHaveBeenCalledTimes(1);
    expect(onSessionEnded.mock.calls[0][0]).toMatchObject({
      roomId: room.id, seq: session.seq, agentId: 'codex', exitCode: 0, exitCause: 'natural',
    });
  });

  it('reports unexpected exit on nonzero close', async () => {
    const { room, session, fake, invocation, onSessionEnded } = setup();
    invocation.startSession({ roomId: room.id, seq: session.seq, agentId: 'codex', registryKey: 'codex' });
    await flush();
    fake.emitClose(3);
    expect(onSessionEnded.mock.calls[0][0]).toMatchObject({ exitCode: 3, exitCause: 'unexpected' });
  });

  it('reports spawn-failed when spawnProcess throws synchronously', async () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
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
    expect(onSessionEnded).toHaveBeenCalledTimes(1);
  });

  it('does not crash when the onSessionEnded handler throws', async () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
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
    expect(onSessionEnded).toHaveBeenCalledTimes(1);
  });

  it('delivers the prompt via stdin and closes stdin when promptVia is stdin', async () => {
    const stdinRegistry: AgentRegistry = { agents: { kimi: { command: ['kimi', '--auto'], promptVia: 'stdin' } } };
    const { room, session, fake, spawnProcess, invocation } = setup(stdinRegistry);
    invocation.startSession({ roomId: room.id, seq: session.seq, agentId: 'kimi', registryKey: 'kimi' });
    await flush();
    expect(spawnProcess.mock.calls[0][2].stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect(fake.stdin.write).toHaveBeenCalledTimes(1);
    expect(fake.stdin.write.mock.calls[0][0]).toContain('authorId: kimi');
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
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
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

    expect(received).toEqual([1]);
    expect(exits).toEqual([0]);
  });

  it('returns null once the session has exited', async () => {
    const { room, session, fake, invocation } = setup();
    invocation.startSession({ roomId: room.id, seq: session.seq, agentId: 'codex', registryKey: 'codex' });
    await flush();
    fake.emitClose(0);
    expect(invocation.attachSessionLog(room.id, session.seq)).toBeNull();
  });
});

describe('createAgentInvocation - stopSessionProcess', () => {
  beforeEach(() => {
    vi.mocked(createWriteStream).mockClear();
    vi.mocked(writeFile).mockReset().mockResolvedValue(undefined);
  });

  function setup(stopGraceMs = 20, stopConfirmMs = 30) {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: session.seq, authorId: 'human', content: 'goal' });
    const fake = createFakeProcess();
    const reg: AgentRegistry = { agents: { codex: { command: ['codex'], stopGraceMs, stopConfirmMs } } };
    const invocation = createAgentInvocation({
      db, registry: reg, onSessionEnded: vi.fn(), logsDir: '/logs', mcpUrl: 'http://x',
      spawnProcess: (() => fake.proc) as unknown as SpawnProcess,
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
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
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
});
