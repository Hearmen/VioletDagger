import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createTestDb } from '../../src/storage/db';
import { createMcpServer, startMcpServer } from '../../src/mcp-server/server';

vi.mock('node:http', () => ({
  createServer: vi.fn(() => ({
    listen: vi.fn((port: number, cb: () => void) => cb()),
  })),
}));

function buildDeps() {
  return {
    db: createTestDb(),
    roomEvents: new EventEmitter(),
    onSubstantiveMessagePosted: vi.fn(),
    resetStuckCount: vi.fn(),
  };
}

describe('createMcpServer', () => {
  it('builds an McpServer instance wired with the four tools', () => {
    const server = createMcpServer(buildDeps());
    expect(server).toBeInstanceOf(McpServer);
  });
});

describe('startMcpServer', () => {
  it('starts an HTTP server listening on the given port', async () => {
    const server = createMcpServer(buildDeps());
    const httpServer: any = await startMcpServer(server, 4319);
    expect(httpServer.listen).toHaveBeenCalledWith(4319, expect.any(Function));
  });
});
