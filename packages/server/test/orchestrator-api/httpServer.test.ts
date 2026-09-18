import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'node:http';
import { createTestDb } from '../../src/storage/db';
import { createRoom, getRoom, setRoomStatus } from '../../src/storage/rooms';
import { createHttpServer } from '../../src/orchestrator-api/httpServer';
import type { AgentRegistry } from '../../src/agent-invocation';

const registry: AgentRegistry = { agents: { codex: { command: ['codex', 'exec'] } } };
const noopDeleteRoom = async () => {};

function listen(httpServer: Server): Promise<number> {
  return new Promise((resolve) => {
    httpServer.listen(0, () => {
      const address = httpServer.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

describe('createHttpServer', () => {
  let httpServer: Server;

  afterEach(() => {
    httpServer?.close();
  });

  it('GET /api/rooms returns the room list', async () => {
    const db = createTestDb();
    createRoom(db, 'a', ['codex'], 'sequential');
    httpServer = createHttpServer({ db, registry, deleteRoom: noopDeleteRoom });
    const port = await listen(httpServer);

    const res = await fetch(`http://localhost:${port}/api/rooms`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toHaveLength(1);
  });

  it('GET /api/rooms/:id returns 404 for a missing room', async () => {
    const db = createTestDb();
    httpServer = createHttpServer({ db, registry, deleteRoom: noopDeleteRoom });
    const port = await listen(httpServer);

    const res = await fetch(`http://localhost:${port}/api/rooms/999`);
    expect(res.status).toBe(404);
  });

  it('GET /api/agents returns the registered agentIds', async () => {
    const db = createTestDb();
    httpServer = createHttpServer({ db, registry, deleteRoom: noopDeleteRoom });
    const port = await listen(httpServer);

    const res = await fetch(`http://localhost:${port}/api/agents`);
    const body = await res.json();
    expect(body).toEqual([{ agentId: 'codex', available: true }]);
  });

  it('POST /api/rooms creates a room and returns 201', async () => {
    const db = createTestDb();
    httpServer = createHttpServer({ db, registry, deleteRoom: noopDeleteRoom });
    const port = await listen(httpServer);

    const res = await fetch(`http://localhost:${port}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'a', agentIds: ['codex'], schedulingMode: 'sequential' }),
    });
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.name).toBe('a');
  });

  it('POST /api/rooms honors an optional maxSessions', async () => {
    const db = createTestDb();
    httpServer = createHttpServer({ db, registry, deleteRoom: noopDeleteRoom });
    const port = await listen(httpServer);

    const res = await fetch(`http://localhost:${port}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'a', agentIds: ['codex'], schedulingMode: 'sequential', maxSessions: 4 }),
    });
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.maxSessions).toBe(4);
  });

  it('POST /api/rooms returns 400 for a non-positive maxSessions', async () => {
    const db = createTestDb();
    httpServer = createHttpServer({ db, registry, deleteRoom: noopDeleteRoom });
    const port = await listen(httpServer);

    const res = await fetch(`http://localhost:${port}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'a', agentIds: ['codex'], schedulingMode: 'sequential', maxSessions: -1 }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/rooms returns 400 for an invalid body', async () => {
    const db = createTestDb();
    httpServer = createHttpServer({ db, registry, deleteRoom: noopDeleteRoom });
    const port = await listen(httpServer);

    const res = await fetch(`http://localhost:${port}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'a', agentIds: [], schedulingMode: 'sequential' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/rooms returns 400 for malformed JSON body', async () => {
    const db = createTestDb();
    httpServer = createHttpServer({ db, registry, deleteRoom: noopDeleteRoom });
    const port = await listen(httpServer);

    const res = await fetch(`http://localhost:${port}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not valid json',
    });
    expect(res.status).toBe(400);
  });

  it('DELETE /api/rooms/:id delegates to the injected deleteRoom and returns ok', async () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const calls: number[] = [];
    httpServer = createHttpServer({
      db,
      registry,
      deleteRoom: async (roomId) => { calls.push(roomId); },
    });
    const port = await listen(httpServer);

    const res = await fetch(`http://localhost:${port}/api/rooms/${room.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls).toEqual([room.id]);
  });

  it('DELETE /api/rooms/:id returns 409 when deleteRoom rejects (e.g. not completed)', async () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    setRoomStatus(db, room.id, 'active');
    httpServer = createHttpServer({
      db,
      registry,
      deleteRoom: async () => { throw new Error('only completed rooms can be deleted'); },
    });
    const port = await listen(httpServer);

    const res = await fetch(`http://localhost:${port}/api/rooms/${room.id}`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect(getRoom(db, room.id)).not.toBeNull();
  });
});
