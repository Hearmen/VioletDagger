import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import type { EventEmitter } from 'node:events';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createPostMessageHandler } from './postMessage';
import { createCompleteExploringHandler } from './completeExploring';
import { createGetOverviewHandler, createGetDetailHandler } from './readTools';
import { McpToolError } from './validation';

const MESSAGE_TYPES = [
  'fact', 'hypothesis', 'boundary', 'open_question', 'chain',
  'exploring', 'propose_completion', 'endorse', 'challenge', 'verify',
] as const;

export interface McpServerDeps {
  db: Database.Database;
  roomEvents: EventEmitter;
  onSubstantiveMessagePosted: (roomId: number) => void;
  resetStuckCount: (roomId: number, agentId: string) => void;
}

function toMcpError(err: unknown): { content: { type: 'text'; text: string }[]; isError: true } {
  const message = err instanceof McpToolError ? err.message : 'internal error';
  return { content: [{ type: 'text', text: message }], isError: true };
}

function toMcpResult(result: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}

export function createMcpServer(deps: McpServerDeps): McpServer {
  const postMessage = createPostMessageHandler(deps);
  const completeExploring = createCompleteExploringHandler(deps);
  const getOverview = createGetOverviewHandler(deps.db);
  const getDetail = createGetDetailHandler(deps.db);

  const server = new McpServer({ name: 'violetdagger-mcp', version: '0.0.1' });

  server.tool(
    'post_message',
    {
      roomId: z.number(),
      authorId: z.string(),
      content: z.string(),
      type: z.enum(MESSAGE_TYPES).optional(),
      targetMessageId: z.number().optional(),
      referencedMessageIds: z.array(z.number()).optional(),
      summary: z.string().optional(),
    },
    async (params: any) => {
      try {
        return toMcpResult(postMessage(params));
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.tool(
    'complete_exploring',
    { roomId: z.number(), authorId: z.string(), messageId: z.number() },
    async (params: any) => {
      try {
        return toMcpResult(completeExploring(params));
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.tool(
    'get_overview',
    { roomId: z.number() },
    async (params: any) => {
      try {
        return toMcpResult(getOverview(params));
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.tool(
    'get_detail',
    {
      roomId: z.number(),
      messageId: z.number().optional(),
      type: z.enum(MESSAGE_TYPES).optional(),
    },
    async (params: any) => {
      try {
        return toMcpResult(getDetail(params));
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  return server;
}

export function startMcpServer(server: McpServer, port: number): Promise<HttpServer> {
  // A single McpServer instance can only be connected to one transport at a
  // time (the SDK throws if connect() is called again before the previous
  // transport is closed). Multiple agents across multiple rooms share this
  // one HTTP port, so concurrent requests are expected, not an edge case.
  // Chain each request's connect -> handle -> close sequence onto the
  // previous one so they are always fully serialized.
  let chain: Promise<void> = Promise.resolve();

  return new Promise((resolve) => {
    const httpServer = createServer((req, res) => {
      // This module is stateless per spec (§1) and never pushes
      // server-initiated messages over a GET SSE stream — MCP tool calls are
      // POST-only here. A GET request with an SSE Accept header would make
      // transport.handleRequest(...) hang open indefinitely (closed only by
      // client disconnect), which would wedge the shared request chain for
      // every agent in every room. Reject non-POST before it ever queues.
      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.end();
        return;
      }
      chain = chain.then(() => handleMcpRequest(server, req, res)).catch(() => {});
    });
    // Bind loopback only: authorId is self-asserted per spec, with no auth
    // layer, so this must not be reachable from the network.
    httpServer.listen(port, '127.0.0.1', () => resolve(httpServer));
  });
}

export async function handleMcpRequest(
  server: McpServer,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end('internal error');
    }
  } finally {
    try {
      await transport.close();
    } catch {
      // Closing an already-broken transport should never wedge the request queue.
    }
  }
}
