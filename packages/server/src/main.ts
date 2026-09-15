import path from 'node:path';
import { composeApp, startApp } from './orchestrator-api';

const HTTP_PORT = Number(process.env.VIOLETDAGGER_HTTP_PORT ?? 4200);
const MCP_PORT = Number(process.env.VIOLETDAGGER_MCP_PORT ?? 4201);

const app = composeApp({
  dbPath: process.env.VIOLETDAGGER_DB_PATH ?? path.join(process.cwd(), 'violetdagger.db'),
  agentsConfigPath: process.env.VIOLETDAGGER_AGENTS_CONFIG ?? path.join(process.cwd(), 'agents.config.json'),
  logsDir: process.env.VIOLETDAGGER_LOGS_DIR ?? path.join(process.cwd(), 'logs'),
});

startApp(app, { httpPort: HTTP_PORT, mcpPort: MCP_PORT }).then(() => {
  console.log(`REST/WS listening on :${HTTP_PORT}, MCP server listening on :${MCP_PORT}`);
});
