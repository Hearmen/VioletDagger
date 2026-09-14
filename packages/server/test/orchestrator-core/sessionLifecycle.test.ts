import { describe, it, expect, vi } from 'vitest';
import { createTestDb } from '../../src/storage/db';
import { createRoom } from '../../src/storage/rooms';
import { createSession, getSession } from '../../src/storage/sessions';
import { insertMessage, getMessagesBySession, getActiveExploring } from '../../src/storage/messages';
import { createStuckCounter } from '../../src/orchestrator-core/stuckCounter';
import { onSessionEnded, terminateAgentSession } from '../../src/orchestrator-core/sessionLifecycle';

describe('onSessionEnded', () => {
  it('marks the session completed when it exited zero and posted a typed message', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: session.seq, authorId: 'codex', content: 'a fact', type: 'fact' });

    onSessionEnded(
      db,
      { roomId: room.id, seq: session.seq, agentId: 'codex', result: 'exited-zero', rawLogPath: '/logs/1.jsonl' },
      vi.fn(),
      createStuckCounter(),
    );

    expect(getSession(db, room.id, session.seq)!.outcome).toBe('completed');
  });

  it('marks the session passed when it exited zero without any typed message', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: session.seq, authorId: 'codex', content: 'just chatting' });

    onSessionEnded(
      db,
      { roomId: room.id, seq: session.seq, agentId: 'codex', result: 'exited-zero', rawLogPath: '/logs/1.jsonl' },
      vi.fn(),
      createStuckCounter(),
    );

    expect(getSession(db, room.id, session.seq)!.outcome).toBe('passed');
  });

  it('marks the session error and inserts a system message on nonzero exit', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');

    onSessionEnded(
      db,
      { roomId: room.id, seq: session.seq, agentId: 'codex', result: 'exited-nonzero', rawLogPath: '/logs/1.jsonl' },
      vi.fn(),
      createStuckCounter(),
    );

    expect(getSession(db, room.id, session.seq)!.outcome).toBe('error');
    const messages = getMessagesBySession(db, room.id, session.seq);
    expect(messages.some((m) => m.authorId === 'system')).toBe(true);
  });

  it('is idempotent when the session has already finished', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    onSessionEnded(
      db,
      { roomId: room.id, seq: session.seq, agentId: 'codex', result: 'exited-zero', rawLogPath: '/logs/1.jsonl' },
      vi.fn(),
      createStuckCounter(),
    );
    const startSession = vi.fn();

    onSessionEnded(
      db,
      { roomId: room.id, seq: session.seq, agentId: 'codex', result: 'exited-nonzero', rawLogPath: '/logs/2.jsonl' },
      startSession,
      createStuckCounter(),
    );

    expect(getSession(db, room.id, session.seq)!.outcome).toBe('passed'); // unchanged from first call
  });

  it('triggers a dispatch check after the state transition', () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex', 'claude'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    const startSession = vi.fn();

    onSessionEnded(
      db,
      { roomId: room.id, seq: session.seq, agentId: 'codex', result: 'exited-zero', rawLogPath: '/logs/1.jsonl' },
      startSession,
      createStuckCounter(),
    );

    expect(startSession).toHaveBeenCalled();
  });
});

describe('terminateAgentSession', () => {
  it('kills the process, marks the session terminated, completes active exploring, and frees the agent', async () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    insertMessage(db, { roomId: room.id, sessionSeq: session.seq, authorId: 'codex', content: 'exploring X', type: 'exploring' });
    const killSession = vi.fn().mockResolvedValue({ rawLogPath: '/logs/1.jsonl' });
    const startSession = vi.fn();

    await terminateAgentSession(db, room.id, session.seq, killSession, startSession, createStuckCounter());

    expect(killSession).toHaveBeenCalledWith(room.id, session.seq);
    expect(getSession(db, room.id, session.seq)!.outcome).toBe('terminated');
    const active = getActiveExploring(db, room.id);
    expect(active).toEqual([]);
  });

  it('is idempotent when the session has already finished', async () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    const killSession = vi.fn().mockResolvedValue({ rawLogPath: null });
    await terminateAgentSession(db, room.id, session.seq, killSession, vi.fn(), createStuckCounter());

    killSession.mockClear();
    await terminateAgentSession(db, room.id, session.seq, killSession, vi.fn(), createStuckCounter());

    expect(killSession).not.toHaveBeenCalled();
  });

  it('triggers a dispatch check after cleanup', async () => {
    const db = createTestDb();
    const room = createRoom(db, 'a', ['codex', 'claude'], 'sequential');
    const session = createSession(db, room.id, 'codex');
    const startSession = vi.fn();

    await terminateAgentSession(
      db, room.id, session.seq,
      vi.fn().mockResolvedValue({ rawLogPath: null }),
      startSession,
      createStuckCounter(),
    );

    expect(startSession).toHaveBeenCalled();
  });
});
