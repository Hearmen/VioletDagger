import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRoomSocket } from '../../src/hooks/useRoomSocket';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  url: string;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.onclose?.();
  }

  emit(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

describe('useRoomSocket', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket as any);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('connects to the room-scoped WS path', () => {
    renderHook(() => useRoomSocket(7));
    expect(FakeWebSocket.instances[0].url).toContain('/api/rooms/7/ws');
  });

  it('call() sends an envelope and resolves when a matching response arrives', async () => {
    const { result } = renderHook(() => useRoomSocket(7));
    const ws = FakeWebSocket.instances[0];

    let resolved: any;
    const promise = act(async () => {
      const p = result.current.call<{ facts: [] }>('getMemoryView');
      p.then((r) => (resolved = r));
      return p;
    });

    const sentEnvelope = JSON.parse(ws.sent[0]);
    expect(sentEnvelope.method).toBe('getMemoryView');
    act(() => {
      ws.emit({ id: sentEnvelope.id, result: { facts: [] } });
    });
    await promise;

    expect(resolved).toEqual({ facts: [] });
  });

  it('call() rejects when the response carries an error', async () => {
    const { result } = renderHook(() => useRoomSocket(7));
    const ws = FakeWebSocket.instances[0];

    const promise = result.current.call('pauseRoom');
    const sentEnvelope = JSON.parse(ws.sent[0]);
    act(() => {
      ws.emit({ id: sentEnvelope.id, error: { message: 'boom' } });
    });

    await expect(promise).rejects.toThrow('boom');
  });

  it('subscribe() invokes the handler for matching push events and can unsubscribe', () => {
    const { result } = renderHook(() => useRoomSocket(7));
    const ws = FakeWebSocket.instances[0];
    const handler = vi.fn();

    const unsubscribe = result.current.subscribe('newMessage', handler);
    act(() => {
      ws.emit({ event: 'newMessage', data: { id: 1, content: 'hi' } });
    });
    expect(handler).toHaveBeenCalledWith({ id: 1, content: 'hi' });

    unsubscribe();
    act(() => {
      ws.emit({ event: 'newMessage', data: { id: 2, content: 'again' } });
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('starts in "connecting" and becomes "connected" once the socket opens', () => {
    const { result } = renderHook(() => useRoomSocket(7));
    expect(result.current.connectionState).toBe('connecting');

    const ws = FakeWebSocket.instances[0];
    act(() => {
      ws.onopen?.();
    });
    expect(result.current.connectionState).toBe('connected');
  });

  it('goes to "disconnected" on close, reconnects after 2s, and recovers to "connected"', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useRoomSocket(7));
    const ws = FakeWebSocket.instances[0];
    act(() => {
      ws.onopen?.();
    });

    act(() => {
      ws.onclose?.();
    });
    expect(result.current.connectionState).toBe('disconnected');
    expect(FakeWebSocket.instances).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);

    act(() => {
      FakeWebSocket.instances[1].onopen?.();
    });
    expect(result.current.connectionState).toBe('connected');

    vi.useRealTimers();
  });
});
