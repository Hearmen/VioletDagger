import type { Server as HttpServer } from 'node:http';
import { createDb } from '../storage';
import { loadAgentRegistry, createAgentInvocation } from '../agent-invocation';
import type { AgentInvocation, OnSessionEnded, StartSession, KillSession } from '../agent-invocation';
import {
  createStuckCounter,
  onSessionEnded as orchestratorOnSessionEnded,
  onSubstantiveMessagePosted,
  resetStuckCount,
  roomEvents,
} from '../orchestrator-core';
import { createMcpServer, startMcpServer } from '../mcp-server';
import { createHttpServer } from './httpServer';
import { attachRoomWebSocket } from './wsServer';

export interface AppConfig {
  dbPath: string;
  agentsConfigPath: string;
  logsDir: string;
}

export interface App {
  db: ReturnType<typeof createDb>;
  registry: ReturnType<typeof loadAgentRegistry>;
  httpServer: HttpServer;
  mcpServer: ReturnType<typeof createMcpServer>;
  mcpHttpServer?: HttpServer;
}

export function composeApp(config: AppConfig): App {
  const db = createDb(config.dbPath);
  const registry = loadAgentRegistry(config.agentsConfigPath);
  const stuckCounter = createStuckCounter();

  // `startSession`/`killSession` 转发函数：先声明、后绑定真实实现，
  // 用于打破 createAgentInvocation ⇄ onSessionEnded 之间的双向依赖（见本计划 Architecture 一节）。
  let agentInvocation!: AgentInvocation;
  const startSession: StartSession = (params) => agentInvocation.startSession(params);
  const killSession: KillSession = (roomId, seq) => agentInvocation.killSession(roomId, seq);

  const onSessionEnded: OnSessionEnded = (event) => {
    orchestratorOnSessionEnded(db, event, startSession, stuckCounter);
  };

  agentInvocation = createAgentInvocation({ db, registry, onSessionEnded, logsDir: config.logsDir });

  const httpServer = createHttpServer({ db, registry });
  attachRoomWebSocket(httpServer, { db, roomEvents, startSession, killSession, stuckCounter });

  const mcpServer = createMcpServer({
    db,
    roomEvents,
    onSubstantiveMessagePosted: (roomId) => {
      onSubstantiveMessagePosted(db, roomId, startSession, stuckCounter);
    },
    resetStuckCount: (roomId, agentId) => {
      resetStuckCount(stuckCounter, roomId, agentId);
    },
  });

  return { db, registry, httpServer, mcpServer };
}

export async function startApp(app: App, ports: { httpPort: number; mcpPort: number }): Promise<void> {
  // Bind loopback only, matching mcp-server's convention: the REST/WS surface
  // this module adds (pauseRoom, terminateAgentSession which kills process
  // groups, postHumanMessage which injects goals agents then act on) is
  // strictly more dangerous than MCP's post_message, and there is no auth
  // layer, so it must not be reachable from the network.
  await new Promise<void>((resolve) => app.httpServer.listen(ports.httpPort, '127.0.0.1', resolve));
  app.mcpHttpServer = await startMcpServer(app.mcpServer, ports.mcpPort);
}
