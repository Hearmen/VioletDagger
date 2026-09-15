import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WebSocket } from 'ws';
import { EventEmitter } from 'node:events';
import { createTestDb } from '../../src/storage/db';
import { createRoom } from '../../src/storage/rooms';
import { createStuckCounter } from '../../src/orchestrator-core';
import { attachRoomWebSocket } from '../../src/orchestrator-api/wsServer';

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

describe('attachRoomWebSocket', () => {
  let httpServer: Server;
  let client: WebSocket;

  afterEach(() => {
    client?.close();
    httpServer?.close();
  });

  it('rejects the upgrade for a room that does not exist', async () => {
    const db = createTestDb();
    httpServer = createServer();
    const roomEvents = new EventEmitter();
    attachRoomWebSocket(httpServer, {
      db, roomEvents, startSession: vi.fn(), killSession: vi.fn(), stuckCounter: createStuckCounter(),
    });
    const port = await listen(httpServer);

    client = new WebSocket(`ws://localhost:${port}/api/rooms/999/ws`);
    await new Promise<void>((resolve) => {
      client.once('error', () => resolve());
      client.once('close', () => resolve());
    });
    expect(client.readyState).not.toBe(WebSocket.OPEN);
  });

  it('answers an RPC call over the room-scoped connection', async () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    httpServer = createServer();
    const roomEvents = new EventEmitter();
    attachRoomWebSocket(httpServer, {
      db, roomEvents, startSession: vi.fn(), killSession: vi.fn(), stuckCounter: createStuckCounter(),
    });
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
    attachRoomWebSocket(httpServer, {
      db, roomEvents, startSession: vi.fn(), killSession: vi.fn(), stuckCounter: createStuckCounter(),
    });
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
    const roomEvents = new EventEmitter();
    attachRoomWebSocket(httpServer, {
      db, roomEvents, startSession: vi.fn(), killSession: vi.fn(), stuckCounter: createStuckCounter(),
    });
    const port = await listen(httpServer);

    client = new WebSocket(`ws://localhost:${port}/api/rooms/${room.id}/ws`);
    await waitForOpen(client);

    client.send('not valid json');
    // 之后连接仍然可用：正常的 RPC 调用应该照常收到响应
    client.send(JSON.stringify({ id: '1', method: 'getMemoryView' }));
    const response = await waitForMessage(client);
    expect(response.id).toBe('1');
    expect(client.readyState).toBe(WebSocket.OPEN);
  });

  it('responds with an error envelope for an unknown method, without closing the connection', async () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    httpServer = createServer();
    const roomEvents = new EventEmitter();
    attachRoomWebSocket(httpServer, {
      db, roomEvents, startSession: vi.fn(), killSession: vi.fn(), stuckCounter: createStuckCounter(),
    });
    const port = await listen(httpServer);

    client = new WebSocket(`ws://localhost:${port}/api/rooms/${room.id}/ws`);
    await waitForOpen(client);

    client.send(JSON.stringify({ id: '9', method: 'doesNotExist' }));
    const response = await waitForMessage(client);
    expect(response).toEqual({ id: '9', error: { message: 'unknown method: doesNotExist' } });
    expect(client.readyState).toBe(WebSocket.OPEN);
  });
});
