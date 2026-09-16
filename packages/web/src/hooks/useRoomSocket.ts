import { useCallback, useEffect, useRef } from 'react';

type PushEvent = 'newMessage' | 'memoryUpdate' | 'roomStatus';

interface PendingCall {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
}

export interface RoomSocket {
  call<T>(method: string, params?: object): Promise<T>;
  subscribe(event: PushEvent, handler: (data: any) => void): () => void;
}

export function useRoomSocket(roomId: number): RoomSocket {
  const wsRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef<Map<string, PendingCall>>(new Map());
  const subscribersRef = useRef<Map<PushEvent, Set<(data: any) => void>>>(new Map());
  const nextIdRef = useRef(1);

  useEffect(() => {
    const ws = new WebSocket(`ws://${window.location.host}/api/rooms/${roomId}/ws`);
    wsRef.current = ws;

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

    return () => ws.close();
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

  return { call, subscribe };
}
