import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../src/storage/db';
import { createRoom, getRoom, listRooms, setRoomStatus, increaseMaxSessions, getRoomAgents, setAgentState } from '../../src/storage/rooms';

describe('rooms', () => {
  it('createRoom sets defaults and getRoom reads them back', () => {
    const db = createTestDb();
    const room = createRoom(db, 'test room', ['codex', 'claude'], 'sequential');
    expect(room.name).toBe('test room');
    expect(room.status).toBe('active');
    expect(room.maxSessions).toBe(20);
    expect(getRoom(db, room.id)).toEqual(room);
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
});
