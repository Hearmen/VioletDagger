import { useCallback, useEffect, useRef, useState } from 'react';

type PushEvent = 'newMessage' | 'memoryUpdate' | 'roomStatus' | 'roomDeleted';
export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

interface PendingCall {
  frame: string;
  resolve: (value: any) => void;
  reject: (err: Error) => void;
}

export interface RoomSocket {
  call<T>(method: string, params?: object): Promise<T>;
  subscribe(event: PushEvent, handler: (data: any) => void): () => void;
  connectionState: ConnectionState;
  reconnectCount: number;
}

const RECONNECT_DELAY_MS = 2000;

export function useRoomSocket(roomId: number): RoomSocket {
  const wsRef = useRef<WebSocket | null>(null);
  const connectedRef = useRef(false);
  const pendingFramesRef = useRef<string[]>([]);
  const pendingRef = useRef<Map<string, PendingCall>>(new Map());
  const subscribersRef = useRef<Map<PushEvent, Set<(data: any) => void>>>(new Map());
  const nextIdRef = useRef(1);
  const roomIdRef = useRef(roomId);
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [reconnectCount, setReconnectCount] = useState(0);

  useEffect(() => {
    if (roomIdRef.current !== roomId) {
      roomIdRef.current = roomId;
      pendingFramesRef.current = [];
      pendingRef.current.clear();
    }

    let stopped = false;
    let hasOpened = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    function connect() {
      setConnectionState('connecting');
      connectedRef.current = false;
      const ws = new WebSocket(`ws://${window.location.host}/api/rooms/${roomId}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        connectedRef.current = true;
        setConnectionState('connected');
        if (hasOpened) setReconnectCount((count) => count + 1);
        hasOpened = true;
        const frames = pendingFramesRef.current;
        pendingFramesRef.current = [];
        frames.forEach((frame) => ws.send(frame));
      };

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
        connectedRef.current = false;
        if (stopped) return;
        setConnectionState('disconnected');
        const inFlight = Array.from(pendingRef.current.values()).map((pending) => pending.frame);
        if (inFlight.length > 0) {
          pendingFramesRef.current = [...inFlight, ...pendingFramesRef.current];
        }
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
    return new Promise<T>((resolve, reject) => {
      const id = String(nextIdRef.current++);
      const frame = JSON.stringify({ id, method, params });
      pendingRef.current.set(id, { frame, resolve, reject });
      const ws = wsRef.current;
      if (ws && connectedRef.current && ws.readyState === WebSocket.OPEN) {
        ws.send(frame);
      } else {
        pendingFramesRef.current.push(frame);
      }
    });
  }, []);

  const subscribe = useCallback((event: PushEvent, handler: (data: any) => void) => {
    if (!subscribersRef.current.has(event)) subscribersRef.current.set(event, new Set());
    subscribersRef.current.get(event)!.add(handler);
    return () => subscribersRef.current.get(event)?.delete(handler);
  }, []);

  return { call, subscribe, connectionState, reconnectCount };
}
