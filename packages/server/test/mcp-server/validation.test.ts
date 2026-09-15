import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../src/storage/db';
import { createRoom, setAgentState } from '../../src/storage/rooms';
import {
  McpToolError, assertRoomExists, assertNotReservedAuthor, resolveSessionBinding,
} from '../../src/mcp-server/validation';

describe('assertRoomExists', () => {
  it('does not throw for an existing room', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    expect(() => assertRoomExists(db, room.id)).not.toThrow();
  });

  it('throws McpToolError for a missing room', () => {
    const db = createTestDb();
    expect(() => assertRoomExists(db, 999)).toThrow(McpToolError);
  });
});

describe('assertNotReservedAuthor', () => {
  it('rejects "human" and "system"', () => {
    expect(() => assertNotReservedAuthor('human')).toThrow(McpToolError);
    expect(() => assertNotReservedAuthor('system')).toThrow(McpToolError);
  });

  it('accepts a normal agentId', () => {
    expect(() => assertNotReservedAuthor('codex')).not.toThrow();
  });
});

describe('resolveSessionBinding', () => {
  it('returns the currentSessionSeq when the agent is running', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    setAgentState(db, room.id, 'codex', 'running', 3);
    expect(resolveSessionBinding(db, room.id, 'codex')).toBe(3);
  });

  it('throws when the agent is idle', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    expect(() => resolveSessionBinding(db, room.id, 'codex')).toThrow(McpToolError);
  });

  it('throws when the agentId is not part of the room', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    expect(() => resolveSessionBinding(db, room.id, 'claude')).toThrow(McpToolError);
  });
});
