import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../src/storage/db';
import { createRoom } from '../../src/storage/rooms';
import {
  ApiError, listRoomsHandler, getRoomHandler, createRoomHandler, listAgentsHandler,
} from '../../src/orchestrator-api/rest';
import type { AgentRegistry } from '../../src/agent-invocation';

const registry: AgentRegistry = {
  agents: { codex: { command: 'codex exec' }, claude: { command: 'claude -p' } },
};

describe('listRoomsHandler', () => {
  it('returns all rooms as summaries', () => {
    const db = createTestDb();
    createRoom(db, 'a', ['codex'], 'sequential');
    createRoom(db, 'b', ['claude'], 'sequential');
    expect(listRoomsHandler(db).map((r) => r.name)).toEqual(['a', 'b']);
  });
});

describe('getRoomHandler', () => {
  it('returns the full room', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    expect(getRoomHandler(db, room.id)).toEqual(room);
  });

  it('throws a 404 ApiError for a missing room', () => {
    const db = createTestDb();
    expect(() => getRoomHandler(db, 999)).toThrow(ApiError);
    try {
      getRoomHandler(db, 999);
      throw new Error('expected getRoomHandler to throw');
    } catch (err) {
      expect((err as ApiError).status).toBe(404);
    }
  });
});

describe('listAgentsHandler', () => {
  it('returns all registered agentIds', () => {
    expect(listAgentsHandler(registry).map((a) => a.agentId).sort()).toEqual(['claude', 'codex']);
  });
});

describe('createRoomHandler', () => {
  it('creates a room when agentIds and schedulingMode are valid', () => {
    const db = createTestDb();
    const room = createRoomHandler(db, registry, { name: 'a', agentIds: ['codex'], schedulingMode: 'sequential' });
    expect(room.name).toBe('a');
  });

  it('rejects an empty agentIds array', () => {
    const db = createTestDb();
    expect(() =>
      createRoomHandler(db, registry, { name: 'a', agentIds: [], schedulingMode: 'sequential' }),
    ).toThrow(ApiError);
  });

  it('rejects an agentId not in the registry', () => {
    const db = createTestDb();
    expect(() =>
      createRoomHandler(db, registry, { name: 'a', agentIds: ['unknown'], schedulingMode: 'sequential' }),
    ).toThrow(ApiError);
  });

  it('rejects a schedulingMode other than sequential', () => {
    const db = createTestDb();
    expect(() =>
      createRoomHandler(db, registry, { name: 'a', agentIds: ['codex'], schedulingMode: 'parallel' }),
    ).toThrow(ApiError);
  });
});
