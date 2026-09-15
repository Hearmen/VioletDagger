import { createServer, type Server as HttpServer } from 'node:http';
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
  return new Promise((resolve) => {
    const httpServer = createServer(async (req, res) => {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => transport.close());
      await server.connect(transport);
      await transport.handleRequest(req, res);
    });
    httpServer.listen(port, () => resolve(httpServer));
  });
}
