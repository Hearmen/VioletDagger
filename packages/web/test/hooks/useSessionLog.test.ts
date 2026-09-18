import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSessionLog } from '../../src/hooks/useSessionLog';

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
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

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  emit(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

describe('useSessionLog', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('connects to the logs WS path with the mode query and exposes no write capability', () => {
    const { result } = renderHook(() => useSessionLog(3, 5, 'live'));
    expect(FakeWebSocket.instances[0].url).toContain('/api/rooms/3/sessions/5/logs?mode=live');
    expect((result.current as any).sendInput).toBeUndefined();
    expect((result.current as any).resize).toBeUndefined();
  });

  it('applies ready/data/end frames and delivers de-duplicated chunks to subscribers', () => {
    const { result } = renderHook(() => useSessionLog(1, 2, 'live'));
    const ws = FakeWebSocket.instances[0];
    const received: number[] = [];
    act(() => {
      ws.open();
      result.current.onData((chunk) => received.push(chunk.offset));
    });
    act(() => {
      ws.emit({ type: 'ready', source: 'live', truncated: true });
      ws.emit({ type: 'data', offset: 0, stream: 'stdout', text: 'a' });
      ws.emit({ type: 'data', offset: 0, stream: 'stdout', text: 'a' });
      ws.emit({ type: 'data', offset: 1, stream: 'stderr', text: 'b' });
    });

    expect(result.current.source).toBe('live');
    expect(result.current.truncated).toBe(true);
    expect(received).toEqual([0, 1]);
  });

  it('replays already-buffered chunks to a late subscriber without duplicates', () => {
    const { result } = renderHook(() => useSessionLog(1, 2, 'live'));
    const ws = FakeWebSocket.instances[0];
    act(() => {
      ws.open();
      ws.emit({ type: 'data', offset: 0, stream: 'stdout', text: 'early' });
    });
    const received: number[] = [];
    act(() => {
      result.current.onData((chunk) => received.push(chunk.offset));
    });
    expect(received).toEqual([0]);
  });

  it('marks ended and disconnects on an end frame', () => {
    const { result } = renderHook(() => useSessionLog(1, 2, 'replay'));
    const ws = FakeWebSocket.instances[0];
    act(() => {
      ws.open();
      ws.emit({ type: 'ready', source: 'snapshot', truncated: false });
      ws.emit({ type: 'end', reason: 'snapshot-complete', exitCode: 0 });
    });
    expect(result.current.ended).toBe(true);
    expect(result.current.connectionState).toBe('disconnected');
  });

  it('keeps content and reports disconnected when the socket closes without an end frame', () => {
    const { result } = renderHook(() => useSessionLog(1, 2, 'live'));
    const ws = FakeWebSocket.instances[0];
    act(() => {
      ws.open();
      ws.emit({ type: 'data', offset: 0, stream: 'stdout', text: 'partial' });
      ws.close();
    });
    expect(result.current.ended).toBe(false);
    expect(result.current.connectionState).toBe('disconnected');
  });

  it('surfaces an error frame', () => {
    const { result } = renderHook(() => useSessionLog(1, 2, 'live'));
    const ws = FakeWebSocket.instances[0];
    act(() => {
      ws.open();
      ws.emit({ type: 'error', message: 'read failed' });
    });
    expect(result.current.error).toBe('read failed');
  });
});
