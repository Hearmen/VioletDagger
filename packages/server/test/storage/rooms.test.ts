import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../src/storage/db';
import { createRoom, getRoom, listRooms, setRoomStatus, increaseMaxSessions } from '../../src/storage/rooms';

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
});
