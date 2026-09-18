import type { Server as HttpServer } from 'node:http';
import { createDb } from '../storage';
import { loadAgentRegistry, createAgentInvocation } from '../agent-invocation';
import type { AgentInvocation, OnSessionEnded, OnSessionExitProgress, StartSession } from '../agent-invocation';
import {
  createStuckCounter,
  createFailureCounter,
  onSessionEnded as orchestratorOnSessionEnded,
  onSessionExitProgress as orchestratorOnSessionExitProgress,
  onSubstantiveMessagePosted,
  resetStuckCount,
  deleteRoom as orchestratorDeleteRoom,
  roomEvents,
} from '../orchestrator-core';
import { createMcpServer, startMcpServer, verifyMcpServer } from '../mcp-server';
import { createHttpServer } from './httpServer';
import { attachRoomWebSocket } from './wsServer';

export interface AppConfig {
  dbPath: string;
  agentsConfigPath: string;
  logsDir: string;
  mcpUrl: string;
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
  const failureCounter = createFailureCounter();

  // `startSession`/`stopSessionProcess` 转发函数：先声明、后绑定真实实现，
  // 用于打破 createAgentInvocation ⇄ orchestrator-core 之间的双向依赖。
  let agentInvocation!: AgentInvocation;
  const startSession: StartSession = (params) => agentInvocation.startSession(params);
  const stopSessionProcess = (roomId: number, seq: number) => agentInvocation.stopSessionProcess(roomId, seq);

  const onSessionEnded: OnSessionEnded = (event) => {
    orchestratorOnSessionEnded(db, event, startSession, stuckCounter, failureCounter);
  };
  const onSessionExitProgress: OnSessionExitProgress = (roomId, seq, kind, detail, attemptId) => {
    orchestratorOnSessionExitProgress(db, roomId, seq, kind, detail, attemptId);
  };

  agentInvocation = createAgentInvocation({
    db,
    registry,
    onSessionEnded,
    onSessionExitProgress,
    logsDir: config.logsDir,
    mcpUrl: config.mcpUrl,
  });

  const deleteRoom = (roomId: number) =>
    orchestratorDeleteRoom(db, roomId, {
      stopSessionProcess,
      startSession,
      stuckCounter,
      failureCounter,
      deleteRoomArtifacts: (id) => agentInvocation.deleteRoomArtifacts(id),
    });

  const httpServer = createHttpServer({ db, registry, deleteRoom });
  attachRoomWebSocket(httpServer, {
    db,
    roomEvents,
    startSession,
    stopSessionProcess,
    stuckCounter,
    failureCounter,
    attachSessionLog: (roomId, seq) => agentInvocation.attachSessionLog(roomId, seq),
  });

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

// 监听失败（最常见的是 EADDRINUSE）会以 'error' 事件发出：不接住它就是未捕获异常，进程直接崩。
// 这里把它转成 Promise reject，让上层（main.ts）能打印清晰的错误并优雅退出。
function listen(server: HttpServer, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    // Bind loopback only, matching mcp-server's convention: the REST/WS surface
    // this module adds (pauseRoom, terminateAgentSession which kills process
    // groups, postHumanMessage which injects goals agents then act on) is
    // strictly more dangerous than MCP's post_message, and there is no auth
    // layer, so it must not be reachable from the network.
    server.listen(port, '127.0.0.1');
  });
}

export async function startApp(app: App, ports: { httpPort: number; mcpPort: number }): Promise<void> {
  await listen(app.httpServer, ports.httpPort);
  try {
    app.mcpHttpServer = await startMcpServer(app.mcpServer, ports.mcpPort);
  } catch (err) {
    // MCP 端口起不来时，别把已经监听的 REST/WS 端口留着，否则用户重试会看到更迷惑的错误。
    app.httpServer.close();
    throw err;
  }

  // 启动自检（见 05-mcp-server.md 第 9 节）：确认 MCP transport 可用且四个工具已注册。
  // 失败就整体收尾退出，避免"进程起来了但 agent 调 post_message 才发现 MCP 不通"。
  const address = app.mcpHttpServer.address();
  const mcpPort = typeof address === 'object' && address ? address.port : ports.mcpPort;
  try {
    await verifyMcpServer(`http://127.0.0.1:${mcpPort}`);
  } catch (err) {
    app.httpServer.close();
    app.mcpHttpServer.close();
    throw err;
  }
}
