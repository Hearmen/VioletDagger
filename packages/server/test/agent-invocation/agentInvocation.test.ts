import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createTestDb } from '../../src/storage/db';
import { createRoom } from '../../src/storage/rooms';
import { createSession, getSession } from '../../src/storage/sessions';
import { insertMessage } from '../../src/storage/messages';
import { createAgentInvocation } from '../../src/agent-invocation/agentInvocation';
import type { AgentRegistry } from '../../src/agent-invocation/types';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));
vi.mock('node:fs', () => ({
  createWriteStream: vi.fn(() => {
    const stream: any = { writableEnded: false, on: vi.fn() };
    stream.end = vi.fn(() => {
      stream.writableEnded = true;
    });
    return stream;
  }),
  mkdirSync: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

function createFakeChild(pid = 4242): any {
  const child = new EventEmitter();
  Object.assign(child, {
    pid,
    exitCode: null,
    stdout: { pipe: vi.fn() },
    stderr: { pipe: vi.fn() },
  });
  return child;
}

const registry: AgentRegistry = {
  agents: { codex: { command: 'codex exec --json {{promptFile}}' } },
};

describe('createAgentInvocation - startSession', () => {
  beforeEach(() => {
    vi.mocked(spawn).mockReset();
    vi.mocked(mkdirSync).mockReset();
    vi.mocked(writeFile).mockReset().mockResolvedValue(undefined);
  });

  it('spawns the configured command with the prompt file substituted, and records the pgid', async () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: session.seq, authorId: 'human', content: 'goal text' });

    const fakeChild = createFakeChild();
    vi.mocked(spawn).mockReturnValue(fakeChild as any);
    const onSessionEnded = vi.fn();
    const { startSession } = createAgentInvocation({ db, registry, onSessionEnded, logsDir: '/logs' });

    startSession({ roomId: room.id, seq: session.seq, agentId: 'codex' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, opts] = vi.mocked(spawn).mock.calls[0];
    expect(command).toContain('codex exec --json');
    expect(command).toContain(`violetdagger-${room.id}-${session.seq}.prompt.txt`);
    expect(opts).toMatchObject({ shell: true, detached: true });
    expect(getSession(db, room.id, session.seq)!.pgid).toBe(4242);
  });

  it('reports exited-zero via onSessionEnded when the child exits with code 0', async () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: session.seq, authorId: 'human', content: 'goal text' });

    const fakeChild = createFakeChild();
    vi.mocked(spawn).mockReturnValue(fakeChild as any);
    const onSessionEnded = vi.fn();
    const { startSession } = createAgentInvocation({ db, registry, onSessionEnded, logsDir: '/logs' });

    startSession({ roomId: room.id, seq: session.seq, agentId: 'codex' });
    await new Promise((resolve) => setImmediate(resolve));
    fakeChild.exitCode = 0;
    fakeChild.emit('exit', 0);

    expect(onSessionEnded).toHaveBeenCalledWith({
      roomId: room.id, seq: session.seq, agentId: 'codex',
      result: 'exited-zero', rawLogPath: expect.stringContaining(`${room.id}/${session.seq}.log`),
    });
  });

  it('reports exited-nonzero without spawning when the agentId is not in the registry', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');

    const onSessionEnded = vi.fn();
    const { startSession } = createAgentInvocation({ db, registry, onSessionEnded, logsDir: '/logs' });

    startSession({ roomId: room.id, seq: session.seq, agentId: 'unknown-agent' });

    expect(spawn).not.toHaveBeenCalled();
    expect(onSessionEnded).toHaveBeenCalledWith({
      roomId: room.id, seq: session.seq, agentId: 'unknown-agent',
      result: 'exited-nonzero', rawLogPath: '',
    });
  });

  it('does not report a second time when the exit event fires twice (idempotency)', async () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: session.seq, authorId: 'human', content: 'goal text' });

    const fakeChild = createFakeChild();
    vi.mocked(spawn).mockReturnValue(fakeChild as any);
    const onSessionEnded = vi.fn();
    const { startSession } = createAgentInvocation({ db, registry, onSessionEnded, logsDir: '/logs' });

    startSession({ roomId: room.id, seq: session.seq, agentId: 'codex' });
    await new Promise((resolve) => setImmediate(resolve));
    fakeChild.emit('exit', 0);
    fakeChild.emit('exit', 0);

    expect(onSessionEnded).toHaveBeenCalledTimes(1);
  });

  it('reports exited-nonzero when spawn itself fails (child process emits "error")', async () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: session.seq, authorId: 'human', content: 'goal text' });

    const fakeChild = createFakeChild();
    vi.mocked(spawn).mockReturnValue(fakeChild as any);
    const onSessionEnded = vi.fn();
    const { startSession } = createAgentInvocation({ db, registry, onSessionEnded, logsDir: '/logs' });

    startSession({ roomId: room.id, seq: session.seq, agentId: 'codex' });
    await new Promise((resolve) => setImmediate(resolve));
    fakeChild.emit('error', new Error('ENOENT'));

    expect(onSessionEnded).toHaveBeenCalledWith({
      roomId: room.id, seq: session.seq, agentId: 'codex',
      result: 'exited-nonzero', rawLogPath: expect.stringContaining(`${room.id}/${session.seq}.log`),
    });
  });

  it('does not report twice when both "error" and "exit" fire for the same spawn failure (idempotency)', async () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: session.seq, authorId: 'human', content: 'goal text' });

    const fakeChild = createFakeChild();
    vi.mocked(spawn).mockReturnValue(fakeChild as any);
    const onSessionEnded = vi.fn();
    const { startSession } = createAgentInvocation({ db, registry, onSessionEnded, logsDir: '/logs' });

    startSession({ roomId: room.id, seq: session.seq, agentId: 'codex' });
    await new Promise((resolve) => setImmediate(resolve));
    fakeChild.emit('error', new Error('ENOENT'));
    fakeChild.emit('exit', 1);

    expect(onSessionEnded).toHaveBeenCalledTimes(1);
  });

  it('reports exited-nonzero via onSessionEnded (with the real rawLogPath) when writePromptFile rejects, without spawning', async () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: session.seq, authorId: 'human', content: 'goal text' });

    vi.mocked(writeFile).mockRejectedValueOnce(new Error('ENOSPC: no space left on device'));
    const onSessionEnded = vi.fn();
    const { startSession } = createAgentInvocation({ db, registry, onSessionEnded, logsDir: '/logs' });

    startSession({ roomId: room.id, seq: session.seq, agentId: 'codex' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(spawn).not.toHaveBeenCalled();
    expect(onSessionEnded).toHaveBeenCalledTimes(1);
    expect(onSessionEnded).toHaveBeenCalledWith({
      roomId: room.id, seq: session.seq, agentId: 'codex',
      result: 'exited-nonzero', rawLogPath: expect.stringContaining(`${room.id}/${session.seq}.log`),
    });
  });

  it('ends the log stream on "close" (stdio fully drained), not on "exit", and never ends it twice', async () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: session.seq, authorId: 'human', content: 'goal text' });

    const fakeChild = createFakeChild();
    vi.mocked(spawn).mockReturnValue(fakeChild as any);
    const onSessionEnded = vi.fn();
    const { startSession } = createAgentInvocation({ db, registry, onSessionEnded, logsDir: '/logs' });

    startSession({ roomId: room.id, seq: session.seq, agentId: 'codex' });
    await new Promise((resolve) => setImmediate(resolve));

    const logStream = vi.mocked(createWriteStream).mock.results.at(-1)!.value as any;

    fakeChild.emit('exit', 0);
    expect(logStream.end).not.toHaveBeenCalled();

    fakeChild.emit('close', 0);
    expect(logStream.end).toHaveBeenCalledTimes(1);

    // 'error' 兜底路径与 'close' 共存时也不能重复 end（writableEnded 守卫）
    fakeChild.emit('error', new Error('late error'));
    expect(logStream.end).toHaveBeenCalledTimes(1);
  });

  it('reports exited-nonzero, without recording a pgid, when spawn returns a child with no pid', async () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: session.seq, authorId: 'human', content: 'goal text' });

    // spawn 同步失败（EAGAIN/EMFILE 等）时 Node 返回的 child 没有 pid
    const fakeChild = createFakeChild();
    fakeChild.pid = undefined;
    vi.mocked(spawn).mockReturnValue(fakeChild as any);
    const onSessionEnded = vi.fn();
    const { startSession } = createAgentInvocation({ db, registry, onSessionEnded, logsDir: '/logs' });

    startSession({ roomId: room.id, seq: session.seq, agentId: 'codex' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(getSession(db, room.id, session.seq)!.pgid).toBeNull();
    expect(onSessionEnded).toHaveBeenCalledWith({
      roomId: room.id, seq: session.seq, agentId: 'codex',
      result: 'exited-nonzero', rawLogPath: expect.stringContaining(`${room.id}/${session.seq}.log`),
    });

    // 监听器已在 spawn 之后立刻挂好：随后的 'error' 有人接，且不会重复上报
    fakeChild.emit('error', new Error('EAGAIN'));
    expect(onSessionEnded).toHaveBeenCalledTimes(1);
  });

  it('creates the log directory before opening the log stream, and attaches an error listener on it', async () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: session.seq, authorId: 'human', content: 'goal text' });

    const fakeChild = createFakeChild();
    vi.mocked(spawn).mockReturnValue(fakeChild as any);
    const onSessionEnded = vi.fn();
    const { startSession } = createAgentInvocation({ db, registry, onSessionEnded, logsDir: '/logs' });

    startSession({ roomId: room.id, seq: session.seq, agentId: 'codex' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(mkdirSync).toHaveBeenCalledWith(`/logs/${room.id}`, { recursive: true });
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe('createAgentInvocation - killSession', () => {
  beforeEach(() => {
    vi.mocked(spawn).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function startFakeSession(db: ReturnType<typeof createTestDb>, roomId: number, seq: number) {
    const fakeChild = createFakeChild();
    vi.mocked(spawn).mockReturnValue(fakeChild as any);
    const onSessionEnded = vi.fn();
    const invocation = createAgentInvocation({ db, registry, onSessionEnded, logsDir: '/logs' });
    invocation.startSession({ roomId, seq, agentId: 'codex' });
    await new Promise((resolve) => setImmediate(resolve));
    return { invocation, fakeChild, onSessionEnded };
  }

  it('returns killed:false with an empty rawLogPath for an unknown session', async () => {
    const db = createTestDb();
    const invocation = createAgentInvocation({ db, registry, onSessionEnded: vi.fn(), logsDir: '/logs' });
    const result = await invocation.killSession(999, 1);
    expect(result).toEqual({ killed: false, rawLogPath: '' });
  });

  it('sends SIGTERM and does not SIGKILL if the process already exited within the grace period', async () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: session.seq, authorId: 'human', content: 'goal' });
    const { invocation, fakeChild } = await startFakeSession(db, room.id, session.seq);

    vi.useFakeTimers();
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true as any);

    const resultPromise = invocation.killSession(room.id, session.seq);
    fakeChild.exitCode = 0;
    await vi.advanceTimersByTimeAsync(2000);
    const result = await resultPromise;

    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');
    expect(killSpy).not.toHaveBeenCalledWith(-4242, 'SIGKILL');
    expect(result.killed).toBe(true);
  });

  it('sends SIGKILL if the process is still alive after the grace period', async () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: session.seq, authorId: 'human', content: 'goal' });
    const { invocation } = await startFakeSession(db, room.id, session.seq);

    vi.useFakeTimers();
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true as any);

    const resultPromise = invocation.killSession(room.id, session.seq);
    await vi.advanceTimersByTimeAsync(2000);
    const result = await resultPromise;

    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');
    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGKILL');
    expect(result.rawLogPath).toContain(`${room.id}/${session.seq}.log`);
  });

  it('does not report via onSessionEnded when the child exits after killSession has already resolved it', async () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: session.seq, authorId: 'human', content: 'goal' });
    const { invocation, fakeChild, onSessionEnded } = await startFakeSession(db, room.id, session.seq);

    vi.useFakeTimers();
    vi.spyOn(process, 'kill').mockReturnValue(true as any);

    const resultPromise = invocation.killSession(room.id, session.seq);
    await vi.advanceTimersByTimeAsync(2000);
    await resultPromise;

    // 被杀掉的进程随后自然退出——resolved 已在发信号前置位，这次 'exit' 必须是 no-op
    fakeChild.exitCode = 143;
    fakeChild.emit('exit', 143);

    expect(onSessionEnded).not.toHaveBeenCalled();
  });

  it('does not spawn an orphan when killSession lands during the prompt-write window', async () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: session.seq, authorId: 'human', content: 'goal' });

    let releaseWrite: () => void = () => {};
    vi.mocked(writeFile).mockImplementationOnce(
      () => new Promise<void>((resolve) => { releaseWrite = () => resolve(); }) as any,
    );

    vi.mocked(spawn).mockReturnValue(createFakeChild() as any);
    const onSessionEnded = vi.fn();
    const invocation = createAgentInvocation({ db, registry, onSessionEnded, logsDir: '/logs' });

    invocation.startSession({ roomId: room.id, seq: session.seq, agentId: 'codex' });
    const result = await invocation.killSession(room.id, session.seq);

    expect(result.killed).toBe(false);
    expect(result.rawLogPath).toContain(`${room.id}/${session.seq}.log`);

    releaseWrite();
    await new Promise((resolve) => setImmediate(resolve));

    expect(spawn).not.toHaveBeenCalled();
    expect(onSessionEnded).not.toHaveBeenCalled();
  });

  it('returns killed:false when SIGTERM itself throws, but still waits out the grace period', async () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: session.seq, authorId: 'human', content: 'goal' });
    const { invocation } = await startFakeSession(db, room.id, session.seq);

    vi.useFakeTimers();
    vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('ESRCH'); });

    const resultPromise = invocation.killSession(room.id, session.seq);
    await vi.advanceTimersByTimeAsync(2000);
    const result = await resultPromise;

    expect(result.killed).toBe(false);
  });
});
