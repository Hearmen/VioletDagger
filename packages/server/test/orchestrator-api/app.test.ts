import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { composeApp, startApp, type App } from '../../src/orchestrator-api/app';
import { createRoom, setAgentState } from '../../src/storage/rooms';
import { createSession } from '../../src/storage/sessions';

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

function waitForMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString())));
  });
}

function portOf(server: { address(): unknown } | undefined): number {
  const address = server?.address();
  return typeof address === 'object' && address ? (address as { port: number }).port : 0;
}

describe('composeApp', () => {
  let dir: string;
  let app: App | undefined;
  let ws: WebSocket | undefined;
  let mcpClient: Client | undefined;

  afterEach(async () => {
    ws?.close();
    await mcpClient?.close().catch(() => {});
    app?.httpServer.close();
    app?.mcpHttpServer?.close();
    app = undefined;
    ws = undefined;
    mcpClient = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('wires all five modules into an App without throwing', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'violetdagger-app-'));
    const agentsConfigPath = path.join(dir, 'agents.config.json');
    writeFileSync(agentsConfigPath, JSON.stringify({ agents: { codex: { command: 'codex exec {{promptFile}}' } } }));

    const app = composeApp({
      dbPath: ':memory:',
      agentsConfigPath,
      logsDir: path.join(dir, 'logs'),
    });

    expect(app.registry.agents.codex).toBeDefined();
    expect(app.httpServer).toBeDefined();
    expect(app.mcpServer).toBeDefined();
  });

  it('startApp listens the REST/WS server and the MCP server on the given ports', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'violetdagger-app-'));
    const agentsConfigPath = path.join(dir, 'agents.config.json');
    writeFileSync(agentsConfigPath, JSON.stringify({ agents: { codex: { command: 'codex exec {{promptFile}}' } } }));

    const app = composeApp({
      dbPath: ':memory:',
      agentsConfigPath,
      logsDir: path.join(dir, 'logs'),
    });

    await startApp(app, { httpPort: 0, mcpPort: 0 });
    expect(app.httpServer.listening).toBe(true);

    app.httpServer.close();
    app.mcpHttpServer?.close();
  });

  it(
    'shares one roomEvents singleton across the MCP and WS layers: a real post_message MCP tool call arrives at a real WS client',
    async () => {
      // This is the regression this test exists to catch: if composeApp ever
      // constructed two separate EventEmitters (one handed to
      // attachRoomWebSocket, another to createMcpServer) instead of sharing
      // the one orchestrator-core `roomEvents` singleton, this test would
      // time out waiting for the WS push below, because the MCP-side emit
      // would land on an emitter nobody is listening on.
      dir = mkdtempSync(path.join(tmpdir(), 'violetdagger-app-'));
      const agentsConfigPath = path.join(dir, 'agents.config.json');
      writeFileSync(agentsConfigPath, JSON.stringify({ agents: { codex: { command: 'codex exec {{promptFile}}' } } }));

      app = composeApp({
        dbPath: ':memory:',
        agentsConfigPath,
        logsDir: path.join(dir, 'logs'),
      });

      await startApp(app, { httpPort: 0, mcpPort: 0 });

      // Real storage layer: create a room with an agent in a running session,
      // exactly what post_message requires to accept the call.
      const room = createRoom(app.db, 'wiring-check', ['codex'], 'sequential');
      const session = createSession(app.db, room.id, 'codex');
      setAgentState(app.db, room.id, 'codex', 'running', session.seq);

      const httpPort = portOf(app.httpServer);
      const mcpPort = portOf(app.mcpHttpServer);

      // Real WS client on the REST/WS server's room-scoped socket, exactly
      // like wsServer.test.ts.
      ws = new WebSocket(`ws://localhost:${httpPort}/api/rooms/${room.id}/ws`);
      await waitForOpen(ws);
      const pushPromise = waitForMessage(ws);

      // Real MCP client, talking real Streamable HTTP to app.mcpHttpServer
      // (the same port/server production agents call post_message against).
      mcpClient = new Client({ name: 'wiring-check-agent', version: '0.0.1' });
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/`));
      await mcpClient.connect(transport);

      const result = await mcpClient.callTool({
        name: 'post_message',
        arguments: { roomId: room.id, authorId: 'codex', content: 'hello from mcp' },
      });
      expect(result.isError).toBeFalsy();

      // The MCP tool handler emits on its `roomEvents` dep; this only
      // resolves if that is the SAME emitter attachRoomWebSocket subscribed
      // to for this room's WS connection.
      const push = await pushPromise;
      expect(push.event).toBe('newMessage');
      expect(push.data.content).toBe('hello from mcp');
    },
    15000,
  );
});
