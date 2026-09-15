import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { composeApp, startApp } from '../../src/orchestrator-api/app';

describe('composeApp', () => {
  let dir: string;

  afterEach(() => {
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
});
