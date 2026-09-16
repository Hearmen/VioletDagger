import { createServer, type Server } from 'node:http';
import type Database from 'better-sqlite3';
import {
  ApiError, listRoomsHandler, getRoomHandler, createRoomHandler, listAgentsHandler,
} from './rest';
import type { AgentRegistry } from '../agent-invocation';

export interface HttpServerDeps {
  db: Database.Database;
  registry: AgentRegistry;
}

function sendJson(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: import('node:http').IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf-8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError('invalid JSON body', 400);
  }
}

export function createHttpServer(deps: HttpServerDeps): Server {
  const { db, registry } = deps;

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const roomIdMatch = url.pathname.match(/^\/api\/rooms\/(\d+)$/);

      if (req.method === 'GET' && url.pathname === '/api/rooms') {
        return sendJson(res, 200, listRoomsHandler(db));
      }
      if (req.method === 'GET' && roomIdMatch) {
        return sendJson(res, 200, getRoomHandler(db, Number(roomIdMatch[1])));
      }
      if (req.method === 'GET' && url.pathname === '/api/agents') {
        return sendJson(res, 200, listAgentsHandler(registry));
      }
      if (req.method === 'POST' && url.pathname === '/api/rooms') {
        const body = await readJsonBody(req);
        return sendJson(res, 201, createRoomHandler(db, registry, body));
      }

      return sendJson(res, 404, { error: { message: 'not found' } });
    } catch (err) {
      if (err instanceof ApiError) {
        return sendJson(res, err.status, { error: { message: err.message } });
      }
      return sendJson(res, 500, { error: { message: 'internal error' } });
    }
  });
}
