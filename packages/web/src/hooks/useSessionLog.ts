import { useCallback, useEffect, useRef, useState } from 'react';
import type { LogChunk, SessionLogFrame } from '../api/types';

export type SessionLogConnectionState = 'connecting' | 'connected' | 'disconnected';
export type SessionLogMode = 'live' | 'replay';

export interface SessionLog {
  onData(cb: (chunk: LogChunk) => void): () => void;
  source: 'live' | 'snapshot' | null;
  truncated: boolean;
  ended: boolean;
  error: string | null;
  connectionState: SessionLogConnectionState;
}

// 只读日志 WS（06 §2.1 / 07 §12.1）：live 为最近日志加持续增量，replay 为磁盘快照。
// 全程只读，不暴露 sendInput/resize；不做断线重连，关闭重开重新拉取。
export function useSessionLog(roomId: number, seq: number, mode: SessionLogMode): SessionLog {
  const wsRef = useRef<WebSocket | null>(null);
  const listenersRef = useRef(new Set<(chunk: LogChunk) => void>());
  const bufferRef = useRef<LogChunk[]>([]);
  const seenOffsetsRef = useRef(new Set<number>());
  const [source, setSource] = useState<'live' | 'snapshot' | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<SessionLogConnectionState>('connecting');

  useEffect(() => {
    setSource(null);
    setTruncated(false);
    setEnded(false);
    setError(null);
    setConnectionState('connecting');
    bufferRef.current = [];
    seenOffsetsRef.current = new Set();

    const ws = new WebSocket(`ws://${window.location.host}/api/rooms/${roomId}/sessions/${seq}/logs?mode=${mode}`);
    wsRef.current = ws;

    const deliver = (chunk: LogChunk) => {
      if (seenOffsetsRef.current.has(chunk.offset)) return;
      seenOffsetsRef.current.add(chunk.offset);
      bufferRef.current.push(chunk);
      listenersRef.current.forEach((cb) => cb(chunk));
    };

    ws.onopen = () => setConnectionState('connected');
    ws.onmessage = (event: { data: string }) => {
      if (typeof event.data !== 'string') return;
      let frame: SessionLogFrame;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      if (frame.type === 'ready') {
        setSource(frame.source);
        setTruncated(frame.truncated);
      } else if (frame.type === 'data') {
        deliver({ offset: frame.offset, stream: frame.stream, text: frame.text });
      } else if (frame.type === 'end') {
        setEnded(true);
        setConnectionState('disconnected');
        ws.close();
      } else if (frame.type === 'error') {
        setError(frame.message);
      }
    };
    // 没有 end 就断开：保留已显示内容，提示重新打开（08 §4）。
    ws.onclose = () => setConnectionState('disconnected');
    ws.onerror = () => ws.close();

    return () => {
      wsRef.current = null;
      ws.close();
    };
  }, [roomId, seq, mode]);

  // 先安装的消费者直接补发已缓存内容（按 offset 去重），之后的增量实时转发。
  const onData = useCallback((cb: (chunk: LogChunk) => void) => {
    listenersRef.current.add(cb);
    bufferRef.current.forEach((chunk) => cb(chunk));
    return () => listenersRef.current.delete(cb);
  }, []);

  return { onData, source, truncated, ended, error, connectionState };
}
