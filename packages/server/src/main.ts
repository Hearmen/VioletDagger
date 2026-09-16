import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import { composeApp, startApp } from './orchestrator-api';

function readPort(envVar: string, fallback: number): number {
  const port = Number(process.env[envVar] ?? fallback);
  if (Number.isNaN(port)) {
    throw new Error(`${envVar} must be a valid port number, got: ${process.env[envVar]}`);
  }
  return port;
}

function addressPort(server: HttpServer | undefined): number | string | undefined {
  const address = server?.address();
  if (address == null) return undefined;
  return typeof address === 'object' ? (address as AddressInfo).port : address;
}

const HTTP_PORT = readPort('VIOLETDAGGER_HTTP_PORT', 4200);
const MCP_PORT = readPort('VIOLETDAGGER_MCP_PORT', 4201);

const app = composeApp({
  dbPath: process.env.VIOLETDAGGER_DB_PATH ?? path.join(process.cwd(), 'violetdagger.db'),
  agentsConfigPath: process.env.VIOLETDAGGER_AGENTS_CONFIG ?? path.join(process.cwd(), 'agents.config.json'),
  logsDir: process.env.VIOLETDAGGER_LOGS_DIR ?? path.join(process.cwd(), 'logs'),
});

startApp(app, { httpPort: HTTP_PORT, mcpPort: MCP_PORT })
  .then(() => {
    console.log(
      `REST/WS listening on :${addressPort(app.httpServer)}, MCP server listening on :${addressPort(app.mcpHttpServer)}`,
    );
  })
  .catch((err) => {
    console.error('Failed to start VioletDagger server:', err);
    process.exitCode = 1;
  });
