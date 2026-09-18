import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { WebSocketServer, WebSocket } from 'ws';
import { getRoom, getSession } from '../storage';
import { createRpcHandlers } from './rpc';
import type { StartSession, StuckCounter, StopSessionProcess, FailureCounter } from '../orchestrator-core';
import type { LogChunk, SessionLogFrame, SessionLogHandle } from '../agent-invocation';

export interface WsServerDeps {
  db: Database.Database;
  roomEvents: EventEmitter;
  startSession: StartSession;
  stopSessionProcess: StopSessionProcess;
  stuckCounter: StuckCounter;
  failureCounter: FailureCounter;
  attachSessionLog: (roomId: number, seq: number) => SessionLogHandle | null;
}

const ROOM_WS_PATH = /^\/api\/rooms\/(\d+)\/ws$/;
const LOGS_WS_PATH = /^\/api\/rooms\/(\d+)\/sessions\/(\d+)\/logs$/;

// 拒绝一次 WS 升级时必须回一个正常的 HTTP 响应再优雅关闭；直接 socket.destroy() 会发 RST，
// 让反向代理（Vite dev server 的 ws proxy 等）把一次普通的"房间不存在"误报成 ECONNRESET/socket hang up。
function rejectUpgrade(socket: import('node:stream').Duplex, status = 404, statusText = 'Not Found'): void {
  if (socket.writable) {
    socket.write(`HTTP/1.1 ${status} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
  socket.end();
}

// 磁盘日志是 JSONL（每行一个 {offset, stream, text}）；历史 PTY 文本日志按 stdout 分块兼容回放（04 §6）。
export function parseLogFile(raw: string): LogChunk[] {
  const lines = raw.split(/\r?\n/);
  const parsed: LogChunk[] = [];
  let allJson = true;
  for (const line of lines) {
    if (line.trim() === '') continue;
    try {
      const value = JSON.parse(line) as Partial<LogChunk>;
      if (
        typeof value?.offset === 'number' &&
        (value.stream === 'stdout' || value.stream === 'stderr') &&
        typeof value.text === 'string'
      ) {
        parsed.push({ offset: value.offset, stream: value.stream, text: value.text });
        continue;
      }
    } catch {
      // fall through
    }
    allJson = false;
    break;
  }
  if (allJson) return parsed;
  if (raw === '') return [];
  return [{ offset: 0, stream: 'stdout', text: raw }];
}

export function attachRoomWebSocket(httpServer: HttpServer, deps: WsServerDeps): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  const logsWss = new WebSocketServer({ noServer: true });
  const logSockets = new Map<number, Set<WebSocket>>();
  deps.roomEvents.on('roomDeleted', ({ roomId }: { roomId: number }) => {
    logSockets.get(roomId)?.forEach((ws) => ws.close());
    logSockets.delete(roomId);
  });

  httpServer.on('upgrade', (req: IncomingMessage, socket, head) => {
    let parsed: URL;
    try {
      parsed = new URL(req.url ?? '', 'http://localhost');
    } catch {
      rejectUpgrade(socket);
      return;
    }
    const roomMatch = parsed.pathname.match(ROOM_WS_PATH);
    const logsMatch = parsed.pathname.match(LOGS_WS_PATH);

    if (roomMatch) {
      const roomId = Number(roomMatch[1]);
      if (!getRoom(deps.db, roomId)) {
        rejectUpgrade(socket);
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req, roomId);
      });
      return;
    }

    if (logsMatch) {
      const roomId = Number(logsMatch[1]);
      const seq = Number(logsMatch[2]);
      if (!getRoom(deps.db, roomId) || !getSession(deps.db, roomId, seq)) {
        rejectUpgrade(socket);
        return;
      }
      const mode = parsed.searchParams.get('mode') === 'replay' ? 'replay' : 'live';
      logsWss.handleUpgrade(req, socket, head, (ws) => {
        logsWss.emit('connection', ws, req, roomId, seq, mode);
      });
      return;
    }

    rejectUpgrade(socket);
  });

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage, roomId: number) => {
    const handlers = createRpcHandlers({
      db: deps.db,
      roomId,
      roomEvents: deps.roomEvents,
      startSession: deps.startSession,
      stopSessionProcess: deps.stopSessionProcess,
      stuckCounter: deps.stuckCounter,
      failureCounter: deps.failureCounter,
    });

    const onMessage = (payload: { roomId: number; message: unknown }) => {
      if (payload.roomId !== roomId || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ event: 'newMessage', data: payload.message }));
    };
    const onMemoryUpdate = (payload: { roomId: number; messageId: number }) => {
      if (payload.roomId !== roomId || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ event: 'memoryUpdate', data: { messageId: payload.messageId } }));
    };
    const onRoomStatus = (payload: { roomId: number }) => {
      if (payload.roomId !== roomId || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ event: 'roomStatus', data: {} }));
    };
    const onRoomDeleted = (payload: { roomId: number }) => {
      if (payload.roomId !== roomId) return;
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event: 'roomDeleted', data: {} }));
      ws.close();
    };

    deps.roomEvents.on('message', onMessage);
    deps.roomEvents.on('memoryUpdate', onMemoryUpdate);
    deps.roomEvents.on('roomStatus', onRoomStatus);
    deps.roomEvents.on('roomDeleted', onRoomDeleted);

    ws.on('message', async (raw) => {
      let envelope: { id: string; method: string; params?: unknown };
      try {
        envelope = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (
        typeof envelope !== 'object' ||
        envelope === null ||
        typeof envelope.method !== 'string'
      ) {
        return;
      }
      const handler = Object.prototype.hasOwnProperty.call(handlers, envelope.method)
        ? handlers[envelope.method]
        : undefined;
      if (!handler) {
        ws.send(JSON.stringify({ id: envelope.id, error: { message: `unknown method: ${envelope.method}` } }));
        return;
      }
      try {
        const result = await handler(envelope.params);
        ws.send(JSON.stringify({ id: envelope.id, result }));
      } catch (err) {
        const message = err instanceof Error ? err.message : 'internal error';
        ws.send(JSON.stringify({ id: envelope.id, error: { message } }));
      }
    });

    ws.on('close', () => {
      deps.roomEvents.off('message', onMessage);
      deps.roomEvents.off('memoryUpdate', onMemoryUpdate);
      deps.roomEvents.off('roomStatus', onRoomStatus);
      deps.roomEvents.off('roomDeleted', onRoomDeleted);
    });
  });

  logsWss.on('connection', (
    ws: WebSocket,
    _req: IncomingMessage,
    roomId: number,
    seq: number,
    mode: 'live' | 'replay',
  ) => {
    const session = getSession(deps.db, roomId, seq);
    if (!session) {
      ws.close();
      return;
    }

    const sockets = logSockets.get(roomId) ?? new Set<WebSocket>();
    sockets.add(ws);
    logSockets.set(roomId, sockets);
    ws.on('close', () => {
      sockets.delete(ws);
      if (sockets.size === 0) logSockets.delete(roomId);
    });

    const send = (frame: SessionLogFrame) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
    };

    // 客户端不发送 input/resize 或其他控制帧（06 §2.1 第 4 步）：忽略任何应用数据。
    ws.on('message', () => {});

    const replay = () => {
      send({ type: 'ready', source: 'snapshot', truncated: false });
      let raw = '';
      if (session.rawLogPath) {
        try {
          raw = readFileSync(session.rawLogPath, 'utf-8');
        } catch (err) {
          // 读取失败不伪装成正常结束（06 §2.1 第 3 步）：发 error 帧后关闭，不发 end。
          send({ type: 'error', message: err instanceof Error ? err.message : 'failed to read session log' });
          ws.close();
          return;
        }
      }
      const chunks = parseLogFile(raw);
      for (const chunk of chunks) {
        send({ type: 'data', offset: chunk.offset, stream: chunk.stream, text: chunk.text });
      }
      send({ type: 'end', reason: 'snapshot-complete', exitCode: session.exitCode });
      ws.close();
    };

    if (mode === 'replay') {
      replay();
      return;
    }

    const handle = deps.attachSessionLog(roomId, seq);
    if (!handle) {
      // live 但无内存句柄（已结束/服务重启）：退回磁盘快照，不能据此判定任务结束。
      replay();
      return;
    }

    // 先订阅增量、缓存期间事件，再截取快照，按 offset 去重拼接（04 §4、06 §2.1）。
    const buffered: LogChunk[] = [];
    let snapshotTaken = false;
    const offData = handle.onData((chunk) => {
      if (!snapshotTaken) buffered.push(chunk);
      else send({ type: 'data', offset: chunk.offset, stream: chunk.stream, text: chunk.text });
    });
    const snapshot = handle.snapshot();
    snapshotTaken = true;
    send({ type: 'ready', source: 'live', truncated: snapshot.truncated });
    let lastOffset = -1;
    for (const chunk of snapshot.chunks) {
      send({ type: 'data', offset: chunk.offset, stream: chunk.stream, text: chunk.text });
      lastOffset = chunk.offset;
    }
    for (const chunk of buffered) {
      if (chunk.offset <= lastOffset) continue;
      send({ type: 'data', offset: chunk.offset, stream: chunk.stream, text: chunk.text });
      lastOffset = chunk.offset;
    }

    const offExit = handle.onExit((event) => {
      send({ type: 'end', reason: 'process-exited', exitCode: event.exitCode });
      ws.close();
    });

    ws.on('close', () => {
      offData();
      offExit();
    });
  });

  return wss;
}
