import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { ApiError, RestClient, RoomConnection } from '../src/api';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

// 模拟编排器：/api/rooms/1/ws 接受升级，其余回 404（与 06 §2 一致）。
async function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/rooms/2') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'room not found' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([{ id: 1, name: 'r', status: 'active', createdAt: '' }]));
  });
  const wss = new WebSocketServer({ noServer: true });
  const sockets: WebSocket[] = [];
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/api/rooms/1/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.end();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.push(ws);
      ws.on('message', (raw) => {
        const req = JSON.parse(raw.toString());
        if (req.method === 'fail') ws.send(JSON.stringify({ id: req.id, error: { message: 'boom' } }));
        else if (req.method !== 'hang') ws.send(JSON.stringify({ id: req.id, result: { echo: req.method, params: req.params } }));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  cleanups.push(() => {
    sockets.forEach((s) => s.terminate());
    wss.close();
    server.close();
  });
  return { port, sockets, base: `http://127.0.0.1:${port}`, wsBase: `ws://127.0.0.1:${port}` };
}

describe('RestClient', () => {
  it('parses success and maps error bodies', async () => {
    const { base } = await startServer();
    const rest = new RestClient(base);
    await expect(rest.listRooms()).resolves.toHaveLength(1);
    await expect(rest.getRoom(2)).rejects.toMatchObject({ message: 'room not found', status: 404 });
  });

  it('reports an unreachable orchestrator', async () => {
    const rest = new RestClient('http://127.0.0.1:1');
    await expect(rest.listRooms()).rejects.toThrow('编排器不可达');
  });
});

describe('RoomConnection', () => {
  it('round-trips RPC calls and errors', async () => {
    const { wsBase } = await startServer();
    const conn = new RoomConnection(wsBase, 1, { watch: false });
    cleanups.push(() => conn.close());
    await expect(conn.call('getRoomStatus', { a: 1 })).resolves.toEqual({ echo: 'getRoomStatus', params: { a: 1 } });
    await expect(conn.call('fail')).rejects.toThrow('boom');
  });

  it('times out unanswered calls', async () => {
    const { wsBase } = await startServer();
    const conn = new RoomConnection(wsBase, 1, { watch: false, rpcTimeoutMs: 50 });
    cleanups.push(() => conn.close());
    await expect(conn.call('hang')).rejects.toThrow('hang 超时');
  });

  it('treats a 404 upgrade as a gone room and stops', async () => {
    const { wsBase } = await startServer();
    let gone = 0;
    const conn = new RoomConnection(wsBase, 2, { watch: true, handlers: { onGone: () => { gone += 1; } } });
    cleanups.push(() => conn.close());
    const err = await conn.call('getRoomStatus').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
    expect(gone).toBe(1);
    expect(conn.isGone).toBe(true);
  });

  it('delivers pushes and reconnects a watched room after a drop', async () => {
    const { wsBase, sockets } = await startServer();
    let opens = 0;
    const pushes: string[] = [];
    const conn = new RoomConnection(wsBase, 1, {
      watch: true,
      maxBackoffMs: 20,
      handlers: { onOpen: () => { opens += 1; }, onPush: (event) => pushes.push(event) },
    });
    cleanups.push(() => conn.close());
    await expect.poll(() => opens).toBe(1);
    sockets[0].send(JSON.stringify({ event: 'roomStatus', data: {} }));
    await expect.poll(() => pushes).toEqual(['roomStatus']);
    sockets[0].terminate();
    await expect.poll(() => opens).toBe(2);
  });

  it('reports an unreachable orchestrator for calls', async () => {
    const conn = new RoomConnection('ws://127.0.0.1:1', 1, { watch: false });
    cleanups.push(() => conn.close());
    await expect(conn.call('getRoomStatus')).rejects.toThrow('编排器不可达');
  });
});
