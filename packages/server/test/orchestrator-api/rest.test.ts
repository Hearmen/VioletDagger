import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { createTestDb } from '../../src/storage/db';
import { createRoom, getRoomAgents } from '../../src/storage/rooms';
import {
  ApiError, listRoomsHandler, getRoomHandler, createRoomHandler, listAgentsHandler, resolveWorkdir,
} from '../../src/orchestrator-api/rest';
import type { AgentRegistry } from '../../src/agent-invocation';

const registry: AgentRegistry = {
  agents: { codex: { command: ['codex', 'exec'] }, claude: { command: ['claude', '-p'] } },
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
  it('returns all registered agent (registry) keys', () => {
    expect(listAgentsHandler(registry).map((a) => a.agentId).sort()).toEqual(['claude', 'codex']);
  });
});

describe('resolveWorkdir', () => {
  it('defaults to the server process cwd and resolves to an absolute path', () => {
    expect(resolveWorkdir()).toBe(process.cwd());
    expect(resolveWorkdir('')).toBe(process.cwd());
    expect(resolveWorkdir('   ')).toBe(process.cwd());
  });

  it('accepts an existing directory', () => {
    expect(resolveWorkdir(process.cwd())).toBe(process.cwd());
  });

  it('rejects a non-existent path', () => {
    expect(() => resolveWorkdir('/no/such/dir/violetdagger-xyz')).toThrow(ApiError);
    expect(() => resolveWorkdir('/no/such/dir/violetdagger-xyz')).toThrow(/does not exist/);
  });

  it('rejects a path that is a file, not a directory', () => {
    expect(() => resolveWorkdir(path.join(process.cwd(), 'package.json'))).toThrow(/not a directory/);
  });
});

describe('createRoomHandler', () => {
  it('creates a room when agentIds and schedulingMode are valid', () => {
    const db = createTestDb();
    const room = createRoomHandler(db, registry, { name: 'a', agentIds: ['codex'], schedulingMode: 'sequential' });
    expect(room.name).toBe('a');
  });

  it('allows the same agentId multiple times and numbers the instances', () => {
    const db = createTestDb();
    const room = createRoomHandler(db, registry, {
      name: 'a', agentIds: ['codex', 'codex', 'claude'], schedulingMode: 'sequential',
    });
    expect(getRoomAgents(db, room.id).map((a) => a.agentId)).toEqual(['codex-1', 'codex-2', 'claude']);
  });

  it('rejects a missing name', () => {
    const db = createTestDb();
    expect(() =>
      createRoomHandler(db, registry, { agentIds: ['codex'], schedulingMode: 'sequential' } as any),
    ).toThrow(ApiError);
  });

  it('rejects an empty string name', () => {
    const db = createTestDb();
    expect(() =>
      createRoomHandler(db, registry, { name: '', agentIds: ['codex'], schedulingMode: 'sequential' }),
    ).toThrow(ApiError);
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

  it('honors an explicit maxSessions', () => {
    const db = createTestDb();
    const room = createRoomHandler(db, registry, {
      name: 'a', agentIds: ['codex'], schedulingMode: 'sequential', maxSessions: 3,
    });
    expect(room.maxSessions).toBe(3);
  });

  it('rejects a non-positive maxSessions', () => {
    const db = createTestDb();
    expect(() =>
      createRoomHandler(db, registry, { name: 'a', agentIds: ['codex'], schedulingMode: 'sequential', maxSessions: 0 }),
    ).toThrow(/maxSessions/);
    expect(() =>
      createRoomHandler(db, registry, { name: 'a', agentIds: ['codex'], schedulingMode: 'sequential', maxSessions: 2.5 }),
    ).toThrow(/maxSessions/);
  });

  it('stores an explicit workdir (resolved to an absolute path)', () => {
    const db = createTestDb();
    const room = createRoomHandler(db, registry, {
      name: 'a', agentIds: ['codex'], schedulingMode: 'sequential', workdir: process.cwd(),
    });
    expect(room.workdir).toBe(process.cwd());
  });

  it('rejects a workdir that does not exist', () => {
    const db = createTestDb();
    expect(() =>
      createRoomHandler(db, registry, {
        name: 'a', agentIds: ['codex'], schedulingMode: 'sequential', workdir: '/no/such/dir/violetdagger-xyz',
      }),
    ).toThrow(/workdir/);
  });

  it('rejects a schedulingMode other than sequential', () => {
    const db = createTestDb();
    expect(() =>
      createRoomHandler(db, registry, { name: 'a', agentIds: ['codex'], schedulingMode: 'parallel' }),
    ).toThrow(ApiError);
  });
});
