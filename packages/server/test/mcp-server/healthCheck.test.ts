import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'node:http';
import { EventEmitter } from 'node:events';
import { createTestDb } from '../../src/storage/db';
import { createMcpServer, startMcpServer } from '../../src/mcp-server/server';
import { verifyMcpServer } from '../../src/mcp-server/healthCheck';

function deps() {
  return {
    db: createTestDb(),
    roomEvents: new EventEmitter(),
    onSubstantiveMessagePosted: () => {},
    resetStuckCount: () => {},
  };
}

describe('verifyMcpServer', () => {
  let server: Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it('resolves when the MCP server is healthy and the four tools are registered', async () => {
    server = await startMcpServer(createMcpServer(deps()), 0);
    const port = (server.address() as { port: number }).port;

    await expect(verifyMcpServer(`http://127.0.0.1:${port}`)).resolves.toBeUndefined();
  });

  it('rejects when nothing is listening on the given port', async () => {
    await expect(verifyMcpServer('http://127.0.0.1:59987', 1000)).rejects.toThrow();
  });
});
