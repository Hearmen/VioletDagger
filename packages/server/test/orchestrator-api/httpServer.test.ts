import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'node:http';
import { createTestDb } from '../../src/storage/db';
import { createRoom } from '../../src/storage/rooms';
import { createHttpServer } from '../../src/orchestrator-api/httpServer';
import type { AgentRegistry } from '../../src/agent-invocation';

const registry: AgentRegistry = { agents: { codex: { command: 'codex exec' } } };

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
    httpServer = createHttpServer({ db, registry });
    const port = await listen(httpServer);

    const res = await fetch(`http://localhost:${port}/api/rooms`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toHaveLength(1);
  });

  it('GET /api/rooms/:id returns 404 for a missing room', async () => {
    const db = createTestDb();
    httpServer = createHttpServer({ db, registry });
    const port = await listen(httpServer);

    const res = await fetch(`http://localhost:${port}/api/rooms/999`);
    expect(res.status).toBe(404);
  });

  it('GET /api/agents returns the registered agentIds', async () => {
    const db = createTestDb();
    httpServer = createHttpServer({ db, registry });
    const port = await listen(httpServer);

    const res = await fetch(`http://localhost:${port}/api/agents`);
    const body = await res.json();
    expect(body).toEqual([{ agentId: 'codex' }]);
  });

  it('POST /api/rooms creates a room and returns 201', async () => {
    const db = createTestDb();
    httpServer = createHttpServer({ db, registry });
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

  it('POST /api/rooms returns 400 for an invalid body', async () => {
    const db = createTestDb();
    httpServer = createHttpServer({ db, registry });
    const port = await listen(httpServer);

    const res = await fetch(`http://localhost:${port}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'a', agentIds: [], schedulingMode: 'sequential' }),
    });
    expect(res.status).toBe(400);
  });
});
