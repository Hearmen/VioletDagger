import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchRooms, fetchRoom, fetchAgents, createRoom } from '../../src/api/rest';

function mockFetchOnce(body: unknown, ok = true) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(body) }),
  );
}

describe('rest api client', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetchRooms calls GET /api/rooms and returns the body', async () => {
    mockFetchOnce([{ id: 1, name: 'a', status: 'active', createdAt: 'now' }]);
    const rooms = await fetchRooms();
    expect(fetch).toHaveBeenCalledWith('/api/rooms');
    expect(rooms).toHaveLength(1);
  });

  it('fetchRoom calls GET /api/rooms/:id', async () => {
    mockFetchOnce({ id: 1, name: 'a' });
    await fetchRoom(1);
    expect(fetch).toHaveBeenCalledWith('/api/rooms/1');
  });

  it('fetchAgents calls GET /api/agents', async () => {
    mockFetchOnce([{ agentId: 'codex' }]);
    const agents = await fetchAgents();
    expect(fetch).toHaveBeenCalledWith('/api/agents');
    expect(agents).toEqual([{ agentId: 'codex' }]);
  });

  it('createRoom POSTs the body and returns the created room', async () => {
    mockFetchOnce({ id: 5, name: 'a' });
    const room = await createRoom({ name: 'a', agentIds: ['codex'], schedulingMode: 'sequential' });
    expect(fetch).toHaveBeenCalledWith('/api/rooms', expect.objectContaining({ method: 'POST' }));
    expect(room.id).toBe(5);
  });

  it('throws when the response is not ok', async () => {
    mockFetchOnce({}, false);
    await expect(fetchRooms()).rejects.toThrow();
  });
});
