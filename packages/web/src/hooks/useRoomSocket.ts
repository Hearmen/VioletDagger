import { useCallback, useEffect, useRef, useState } from 'react';

type PushEvent = 'newMessage' | 'memoryUpdate' | 'roomStatus';
export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

interface PendingCall {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
}

export interface RoomSocket {
  call<T>(method: string, params?: object): Promise<T>;
  subscribe(event: PushEvent, handler: (data: any) => void): () => void;
  connectionState: ConnectionState;
}

const RECONNECT_DELAY_MS = 2000;

export function useRoomSocket(roomId: number): RoomSocket {
  const wsRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef<Map<string, PendingCall>>(new Map());
  const subscribersRef = useRef<Map<PushEvent, Set<(data: any) => void>>>(new Map());
  const nextIdRef = useRef(1);
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');

  useEffect(() => {
    let stopped = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    function connect() {
      setConnectionState('connecting');
      const ws = new WebSocket(`ws://${window.location.host}/api/rooms/${roomId}/ws`);
      wsRef.current = ws;

      ws.onopen = () => setConnectionState('connected');

      ws.onmessage = (event: { data: string }) => {
        const payload = JSON.parse(event.data);
        if ('id' in payload) {
          const pending = pendingRef.current.get(payload.id);
          if (!pending) return;
          pendingRef.current.delete(payload.id);
          if (payload.error) pending.reject(new Error(payload.error.message));
          else pending.resolve(payload.result);
        } else if ('event' in payload) {
          const handlers = subscribersRef.current.get(payload.event as PushEvent);
          handlers?.forEach((handler) => handler(payload.data));
        }
      };

      ws.onclose = () => {
        if (stopped) return;
        setConnectionState('disconnected');
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
      };
      ws.onerror = () => ws.close();
    }

    connect();

    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, [roomId]);

  const call = useCallback(<T,>(method: string, params?: object): Promise<T> => {
    return new Promise((resolve, reject) => {
      const id = String(nextIdRef.current++);
      pendingRef.current.set(id, { resolve, reject });
      wsRef.current?.send(JSON.stringify({ id, method, params }));
    });
  }, []);

  const subscribe = useCallback((event: PushEvent, handler: (data: any) => void) => {
    if (!subscribersRef.current.has(event)) subscribersRef.current.set(event, new Set());
    subscribersRef.current.get(event)!.add(handler);
    return () => subscribersRef.current.get(event)?.delete(handler);
  }, []);

  return { call, subscribe, connectionState };
}
