import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchRooms, fetchRoom, fetchAgents, createRoom, deleteRoom } from '../../src/api/rest';

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

  it('fetchAgents calls GET /api/agents and returns agent (registry) keys', async () => {
    mockFetchOnce([{ agentId: 'codex' }]);
    const agents = await fetchAgents();
    expect(fetch).toHaveBeenCalledWith('/api/agents');
    expect(agents).toEqual([{ agentId: 'codex' }]);
  });

  it('createRoom POSTs the body (with duplicates) and returns the created room', async () => {
    mockFetchOnce({ id: 5, name: 'a' });
    const room = await createRoom({ name: 'a', agentIds: ['codex', 'codex'], schedulingMode: 'sequential' });
    expect(fetch).toHaveBeenCalledWith('/api/rooms', expect.objectContaining({ method: 'POST' }));
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body.agentIds).toEqual(['codex', 'codex']);
    expect(room.id).toBe(5);
  });

  it('createRoom passes maxSessions through when provided', async () => {
    mockFetchOnce({ id: 6, name: 'a' });
    await createRoom({ name: 'a', agentIds: ['codex'], schedulingMode: 'sequential', maxSessions: 7 });
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body.maxSessions).toBe(7);
  });

  it('createRoom passes workdir through when provided', async () => {
    mockFetchOnce({ id: 8, name: 'a' });
    await createRoom({ name: 'a', agentIds: ['codex'], schedulingMode: 'sequential', workdir: '/tmp/room-w' });
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body.workdir).toBe('/tmp/room-w');
  });

  it('deleteRoom calls DELETE /api/rooms/:id', async () => {
    mockFetchOnce({ ok: true });
    await deleteRoom(7);
    expect(fetch).toHaveBeenCalledWith('/api/rooms/7', { method: 'DELETE' });
  });

  it('deleteRoom surfaces the server error message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 409, json: () => Promise.resolve({ error: { message: 'only completed rooms can be deleted' } }),
    }));
    await expect(deleteRoom(1)).rejects.toThrow('only completed rooms can be deleted');
  });

  it('throws when the response is not ok', async () => {
    mockFetchOnce({}, false);
    await expect(fetchRooms()).rejects.toThrow();
  });
});
