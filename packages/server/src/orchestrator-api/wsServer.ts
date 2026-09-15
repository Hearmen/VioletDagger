import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import { WebSocketServer, WebSocket } from 'ws';
import { getRoom } from '../storage';
import { createRpcHandlers } from './rpc';
import type { StartSession, StuckCounter } from '../orchestrator-core';
import type { KillSession } from '../agent-invocation';

export interface WsServerDeps {
  db: Database.Database;
  roomEvents: EventEmitter;
  startSession: StartSession;
  killSession: KillSession;
  stuckCounter: StuckCounter;
}

const ROOM_WS_PATH = /^\/api\/rooms\/(\d+)\/ws$/;

export function attachRoomWebSocket(httpServer: HttpServer, deps: WsServerDeps): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req: IncomingMessage, socket, head) => {
    const match = (req.url ?? '').match(ROOM_WS_PATH);
    if (!match) {
      socket.destroy();
      return;
    }
    const roomId = Number(match[1]);
    if (!getRoom(deps.db, roomId)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, roomId);
    });
  });

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage, roomId: number) => {
    const handlers = createRpcHandlers({
      db: deps.db,
      roomId,
      roomEvents: deps.roomEvents,
      startSession: deps.startSession,
      killSession: deps.killSession,
      stuckCounter: deps.stuckCounter,
    });

    const onMessage = (payload: { roomId: number; message: unknown }) => {
      if (payload.roomId !== roomId) return;
      ws.send(JSON.stringify({ event: 'newMessage', data: payload.message }));
    };
    const onMemoryUpdate = (payload: { roomId: number; messageId: number }) => {
      if (payload.roomId !== roomId) return;
      ws.send(JSON.stringify({ event: 'memoryUpdate', data: { messageId: payload.messageId } }));
    };
    const onRoomStatus = (payload: { roomId: number }) => {
      if (payload.roomId !== roomId) return;
      ws.send(JSON.stringify({ event: 'roomStatus', data: {} }));
    };

    deps.roomEvents.on('message', onMessage);
    deps.roomEvents.on('memoryUpdate', onMemoryUpdate);
    deps.roomEvents.on('roomStatus', onRoomStatus);

    ws.on('message', async (raw) => {
      let envelope: { id: string; method: string; params?: unknown };
      try {
        envelope = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const handler = handlers[envelope.method];
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
    });
  });

  return wss;
}
