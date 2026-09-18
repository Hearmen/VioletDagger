import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { EventEmitter } from 'node:events';
import { createTestDb } from '../../src/storage/db';
import { createRoom } from '../../src/storage/rooms';
import { createSession, finishSession, setSessionRawLogPath } from '../../src/storage/sessions';
import { createStuckCounter } from '../../src/orchestrator-core';
import { attachRoomWebSocket, parseLogFile, type WsServerDeps } from '../../src/orchestrator-api/wsServer';

function listen(httpServer: Server): Promise<number> {
  return new Promise((resolve) => {
    httpServer.listen(0, () => {
      const address = httpServer.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

function waitForMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString())));
  });
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

function baseDeps(overrides: Partial<WsServerDeps> = {}): WsServerDeps {
  return {
    db: createTestDb(),
    roomEvents: new EventEmitter(),
    startSession: vi.fn(),
    stopSessionProcess: vi.fn(),
    stuckCounter: createStuckCounter(),
    attachSessionLog: () => null,
    ...overrides,
  } as WsServerDeps;
}

describe('parseLogFile', () => {
  it('parses JSONL chunks', () => {
    const raw = [
      JSON.stringify({ offset: 0, stream: 'stdout', text: 'a\n' }),
      JSON.stringify({ offset: 1, stream: 'stderr', text: 'b\n' }),
    ].join('\n');
    expect(parseLogFile(raw)).toEqual([
      { offset: 0, stream: 'stdout', text: 'a\n' },
      { offset: 1, stream: 'stderr', text: 'b\n' },
    ]);
  });

  it('falls back to a single stdout chunk for historical plain-text logs', () => {
    expect(parseLogFile('ANSI:\u001b[31mred\u001b[0m done')).toEqual([
      { offset: 0, stream: 'stdout', text: 'ANSI:\u001b[31mred\u001b[0m done' },
    ]);
  });
});

describe('attachRoomWebSocket', () => {
  let httpServer: Server;
  let client: WebSocket;

  afterEach(() => {
    client?.on('error', () => {});
    try { client?.close(); } catch { /* already closing/closed */ }
    httpServer?.close();
  });

  it('rejects the upgrade for a room that does not exist', async () => {
    httpServer = createServer();
    attachRoomWebSocket(httpServer, baseDeps());
    const port = await listen(httpServer);

    client = new WebSocket(`ws://localhost:${port}/api/rooms/999/ws`);
    await new Promise<void>((resolve) => {
      client.once('error', () => resolve());
      client.once('close', () => resolve());
    });
    expect(client.readyState).not.toBe(WebSocket.OPEN);
  });

  it('rejects a missing room with a plain HTTP 404 (not a socket reset)', async () => {
    httpServer = createServer();
    attachRoomWebSocket(httpServer, baseDeps());
    const port = await listen(httpServer);

    client = new WebSocket(`ws://localhost:${port}/api/rooms/999/ws`);
    const status = await new Promise<number>((resolve, reject) => {
      client.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      client.once('open', () => reject(new Error('expected the upgrade to be rejected')));
    });
    expect(status).toBe(404);
  });

  it('answers an RPC call over the room-scoped connection', async () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    httpServer = createServer();
    attachRoomWebSocket(httpServer, baseDeps({ db }));
    const port = await listen(httpServer);

    client = new WebSocket(`ws://localhost:${port}/api/rooms/${room.id}/ws`);
    await waitForOpen(client);

    client.send(JSON.stringify({ id: '1', method: 'getMemoryView' }));
    const response = await waitForMessage(client);
    expect(response).toEqual({ id: '1', result: expect.objectContaining({ facts: [] }) });
  });

  it('forwards a roomEvents "message" emit to the matching room connection only', async () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const otherRoom = createRoom(db, 'b', ['codex'], 'sequential');
    httpServer = createServer();
    const roomEvents = new EventEmitter();
    attachRoomWebSocket(httpServer, baseDeps({ db, roomEvents }));
    const port = await listen(httpServer);

    client = new WebSocket(`ws://localhost:${port}/api/rooms/${room.id}/ws`);
    await waitForOpen(client);

    const pushPromise = waitForMessage(client);
    roomEvents.emit('message', { roomId: otherRoom.id, message: { id: 1 } });
    roomEvents.emit('message', { roomId: room.id, message: { id: 2, content: 'hi' } });
    const push = await pushPromise;

    expect(push).toEqual({ event: 'newMessage', data: { id: 2, content: 'hi' } });
  });

  it('drops an unparsable message silently and keeps the connection open', async () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    httpServer = createServer();
    attachRoomWebSocket(httpServer, baseDeps({ db }));
    const port = await listen(httpServer);

    client = new WebSocket(`ws://localhost:${port}/api/rooms/${room.id}/ws`);
    await waitForOpen(client);

    client.send('not valid json');
    client.send(JSON.stringify({ id: '1', method: 'getMemoryView' }));
    const response = await waitForMessage(client);
    expect(response.id).toBe('1');
    expect(client.readyState).toBe(WebSocket.OPEN);
  });

  it('drops a JSON `null` frame silently and keeps the connection open', async () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    httpServer = createServer();
    attachRoomWebSocket(httpServer, baseDeps({ db }));
    const port = await listen(httpServer);

    client = new WebSocket(`ws://localhost:${port}/api/rooms/${room.id}/ws`);
    await waitForOpen(client);

    client.send('null');
    client.send(JSON.stringify({ id: '1', method: 'getMemoryView' }));
    const response = await waitForMessage(client);
    expect(response.id).toBe('1');
    expect(client.readyState).toBe(WebSocket.OPEN);
  });

  it('responds with the unknown-method error for an inherited Object.prototype name instead of crashing', async () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    httpServer = createServer();
    attachRoomWebSocket(httpServer, baseDeps({ db }));
    const port = await listen(httpServer);

    client = new WebSocket(`ws://localhost:${port}/api/rooms/${room.id}/ws`);
    await waitForOpen(client);

    client.send(JSON.stringify({ id: '1', method: 'toString' }));
    const response = await waitForMessage(client);
    expect(response).toEqual({ id: '1', error: { message: 'unknown method: toString' } });
    expect(client.readyState).toBe(WebSocket.OPEN);
  });

  it('pushes roomDeleted to the matching room and then closes the connection', async () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    httpServer = createServer();
    const roomEvents = new EventEmitter();
    attachRoomWebSocket(httpServer, baseDeps({ db, roomEvents }));
    const port = await listen(httpServer);

    client = new WebSocket(`ws://localhost:${port}/api/rooms/${room.id}/ws`);
    await waitForOpen(client);

    const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
    const push = waitForMessage(client);
    roomEvents.emit('roomDeleted', { roomId: room.id });

    expect(await push).toEqual({ event: 'roomDeleted', data: {} });
    await closed;
    expect(client.readyState).toBe(WebSocket.CLOSED);
  });
});

describe('attachRoomWebSocket - logs websocket', () => {
  let httpServer: Server;
  let client: WebSocket;
  let dir: string | undefined;

  afterEach(() => {
    client?.on('error', () => {});
    try { client?.close(); } catch { /* already closing/closed */ }
    httpServer?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function collect(ws: WebSocket): any[] {
    const frames: any[] = [];
    ws.on('message', (data) => frames.push(JSON.parse(data.toString())));
    return frames;
  }

  it('replays a JSONL log snapshot and sends end(snapshot-complete) for a finished session', async () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    dir = mkdtempSync(path.join(tmpdir(), 'violetdagger-logs-'));
    const rawLogPath = path.join(dir, `${session.seq}.jsonl`);
    writeFileSync(rawLogPath, [
      JSON.stringify({ offset: 0, stream: 'stdout', text: 'hello\n' }),
      JSON.stringify({ offset: 1, stream: 'stderr', text: 'oops\n' }),
    ].join('\n'));
    finishSession(db, room.id, session.seq, 'passed', rawLogPath, { exitCode: 0, signal: null, exitCause: 'natural' });

    httpServer = createServer();
    attachRoomWebSocket(httpServer, baseDeps({ db }));
    const port = await listen(httpServer);

    client = new WebSocket(`ws://localhost:${port}/api/rooms/${room.id}/sessions/${session.seq}/logs`);
    const frames = collect(client);
    const done = new Promise<void>((resolve) => client.once('close', () => resolve()));
    await waitForOpen(client);
    await done;

    expect(frames).toEqual([
      { type: 'ready', source: 'snapshot', truncated: false },
      { type: 'data', offset: 0, stream: 'stdout', text: 'hello\n' },
      { type: 'data', offset: 1, stream: 'stderr', text: 'oops\n' },
      { type: 'end', reason: 'snapshot-complete', exitCode: 0 },
    ]);
  });

  it('mode=replay reads the disk snapshot without attaching a live handle', async () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    dir = mkdtempSync(path.join(tmpdir(), 'violetdagger-logs-'));
    const rawLogPath = path.join(dir, `${session.seq}.jsonl`);
    writeFileSync(rawLogPath, 'legacy plain text');
    setSessionRawLogPath(db, room.id, session.seq, rawLogPath);

    const attachSessionLog = vi.fn(() => null);
    httpServer = createServer();
    attachRoomWebSocket(httpServer, baseDeps({ db, attachSessionLog }));
    const port = await listen(httpServer);

    client = new WebSocket(`ws://localhost:${port}/api/rooms/${room.id}/sessions/${session.seq}/logs?mode=replay`);
    const frames = collect(client);
    const done = new Promise<void>((resolve) => client.once('close', () => resolve()));
    await waitForOpen(client);
    await done;

    expect(frames[1]).toEqual({ type: 'data', offset: 0, stream: 'stdout', text: 'legacy plain text' });
    expect(frames.at(-1)).toEqual({ type: 'end', reason: 'snapshot-complete', exitCode: null });
    expect(attachSessionLog).not.toHaveBeenCalled();
  });

  it('streams live chunks and sends end(process-exited) without accepting client input', async () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');

    let dataCb: ((chunk: any) => void) | undefined;
    let exitCb: ((event: any) => void) | undefined;
    const handle = {
      snapshot: () => ({ chunks: [{ offset: 0, stream: 'stdout' as const, text: 'REPLAY' }], truncated: false }),
      onData: (cb: (chunk: any) => void) => { dataCb = cb; return () => {}; },
      onExit: (cb: (event: any) => void) => { exitCb = cb; return () => {}; },
    };
    const attachSessionLog = vi.fn(() => handle);
    httpServer = createServer();
    attachRoomWebSocket(httpServer, baseDeps({ db, attachSessionLog }));
    const port = await listen(httpServer);

    client = new WebSocket(`ws://localhost:${port}/api/rooms/${room.id}/sessions/${session.seq}/logs`);
    const frames = collect(client);
    await waitForOpen(client);
    await vi.waitFor(() => expect(frames.length).toBeGreaterThanOrEqual(2));

    expect(frames[0]).toEqual({ type: 'ready', source: 'live', truncated: false });
    expect(frames[1]).toEqual({ type: 'data', offset: 0, stream: 'stdout', text: 'REPLAY' });

    // 客户端应用数据被忽略（只读日志，没有 input/resize）。
    client.send(JSON.stringify({ type: 'input', data: 'x' }));

    dataCb?.({ offset: 1, stream: 'stdout', text: 'live' });
    await vi.waitFor(() => expect(frames).toContainEqual({ type: 'data', offset: 1, stream: 'stdout', text: 'live' }));

    const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
    exitCb?.({ exitCode: 0 });
    await closed;
    expect(frames.at(-1)).toEqual({ type: 'end', reason: 'process-exited', exitCode: 0 });
  });

  it('closes log connections when the room is deleted', async () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    const roomEvents = new EventEmitter();
    const handle = {
      snapshot: () => ({ chunks: [], truncated: false }),
      onData: () => () => {},
      onExit: () => () => {},
    };
    httpServer = createServer();
    attachRoomWebSocket(httpServer, baseDeps({ db, roomEvents, attachSessionLog: () => handle }));
    const port = await listen(httpServer);

    client = new WebSocket(`ws://localhost:${port}/api/rooms/${room.id}/sessions/${session.seq}/logs`);
    await waitForOpen(client);

    const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
    roomEvents.emit('roomDeleted', { roomId: room.id });
    await closed;
    expect(client.readyState).toBe(WebSocket.CLOSED);
  });
});
