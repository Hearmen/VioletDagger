import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../src/storage/db';
import {
  createRoom, getRoom, listRooms, setRoomStatus, increaseMaxSessions, getRoomAgents, setAgentState,
  deleteRoom, assignInstanceIds,
} from '../../src/storage/rooms';
import { createSession, listSessions } from '../../src/storage/sessions';
import { insertMessage, getMessagesByType, getAnnotations } from '../../src/storage/messages';

describe('rooms', () => {
  it('createRoom sets defaults and getRoom reads them back', () => {
    const db = createTestDb();
    const room = createRoom(db, 'test room', ['codex', 'claude'], 'sequential');
    expect(room.name).toBe('test room');
    expect(room.status).toBe('active');
    expect(room.maxSessions).toBe(20);
    expect(getRoom(db, room.id)).toEqual(room);
  });

  it('createRoom uses the default maxSessions when not provided', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    expect(room.maxSessions).toBe(20);
  });

  it('createRoom honors an explicit maxSessions', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential', { maxSessions: 5 });
    expect(room.maxSessions).toBe(5);
  });

  it('createRoom rejects a non-positive / non-integer maxSessions', () => {
    const db = createTestDb();
    expect(() => createRoom(db, 'a', ['codex'], 'sequential', { maxSessions: 0 })).toThrow(/maxSessions/);
    expect(() => createRoom(db, 'a', ['codex'], 'sequential', { maxSessions: -3 })).toThrow(/maxSessions/);
    expect(() => createRoom(db, 'a', ['codex'], 'sequential', { maxSessions: 2.5 })).toThrow(/maxSessions/);
  });

  it('createRoom stores an explicit workdir and defaults to an empty string', () => {
    const db = createTestDb();
    const withDir = createRoom(db, 'a', ['codex'], 'sequential', { workdir: '/tmp/room-work' });
    expect(withDir.workdir).toBe('/tmp/room-work');
    const withoutDir = createRoom(db, 'b', ['codex'], 'sequential');
    expect(withoutDir.workdir).toBe('');
  });

  it('listRooms returns summaries for all rooms', () => {
    const db = createTestDb();
    createRoom(db, 'a', ['codex'], 'sequential');
    createRoom(db, 'b', ['claude'], 'sequential');
    const summaries = listRooms(db);
    expect(summaries.map((r) => r.name)).toEqual(['a', 'b']);
  });

  it('setRoomStatus updates status', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    setRoomStatus(db, room.id, 'paused_manual');
    expect(getRoom(db, room.id)!.status).toBe('paused_manual');
  });

  it('increaseMaxSessions adds to the existing limit', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    increaseMaxSessions(db, room.id, 5);
    expect(getRoom(db, room.id)!.maxSessions).toBe(25);
  });

  it('getRoomAgents returns agents ordered by join order', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex', 'claude'], 'sequential');
    const agents = getRoomAgents(db, room.id);
    expect(agents.map((a) => a.agentId)).toEqual(['codex', 'claude']);
    expect(agents[0]).toMatchObject({ joinOrder: 0, state: 'idle', currentSessionSeq: null });
  });

  it('setAgentState updates state and current session', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    setAgentState(db, room.id, 'codex', 'running', 1);
    expect(getRoomAgents(db, room.id)[0]).toMatchObject({ state: 'running', currentSessionSeq: 1 });
    setAgentState(db, room.id, 'codex', 'idle');
    expect(getRoomAgents(db, room.id)[0]).toMatchObject({ state: 'idle', currentSessionSeq: null });
  });

  it('records the registryKey alongside the instance id', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex', 'codex', 'claude'], 'sequential');
    expect(getRoomAgents(db, room.id).map((a) => ({ agentId: a.agentId, registryKey: a.registryKey }))).toEqual([
      { agentId: 'codex-1', registryKey: 'codex' },
      { agentId: 'codex-2', registryKey: 'codex' },
      { agentId: 'claude', registryKey: 'claude' },
    ]);
  });
});

describe('assignInstanceIds', () => {
  it('leaves a single occurrence unsuffixed and numbers duplicates in order', () => {
    expect(assignInstanceIds(['codex', 'codex', 'claude', 'codex'])).toEqual([
      { agentId: 'codex-1', registryKey: 'codex' },
      { agentId: 'codex-2', registryKey: 'codex' },
      { agentId: 'claude', registryKey: 'claude' },
      { agentId: 'codex-3', registryKey: 'codex' },
    ]);
  });

  it('throws when a generated instance id collides with another registry key', () => {
    expect(() => assignInstanceIds(['codex', 'codex', 'codex-1'])).toThrow(/collision/);
  });
});

describe('deleteRoom', () => {
  it('cascade-deletes messages, references, sessions, agents and the room', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    const first = insertMessage(db, { roomId: room.id, sessionSeq: session.seq, authorId: 'codex', content: 'fact', type: 'fact' }).message;
    const chain = insertMessage(db, {
      roomId: room.id, sessionSeq: session.seq, authorId: 'codex', content: 'chain', type: 'chain',
      referencedMessageIds: [first.id],
    }).message;
    insertMessage(db, { roomId: room.id, sessionSeq: null, authorId: 'human', content: 'reaction', type: 'endorse', targetMessageId: first.id });

    deleteRoom(db, room.id);

    expect(getRoom(db, room.id)).toBeNull();
    expect(listSessions(db, room.id)).toHaveLength(0);
    expect(getMessagesByType(db, room.id, 'fact')).toHaveLength(0);
    expect(getRoomAgents(db, room.id)).toHaveLength(0);
    expect(getAnnotations(db, first.id)).toHaveLength(0);
    expect(chain.id).toBeGreaterThan(first.id);
  });
});
