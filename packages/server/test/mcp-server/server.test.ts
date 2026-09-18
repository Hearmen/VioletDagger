import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createTestDb } from '../../src/storage/db';
import { createMcpServer, startMcpServer, handleMcpRequest } from '../../src/mcp-server/server';

const httpMocks = vi.hoisted(() => ({
  listen: vi.fn(),
  error: undefined as Error | undefined,
  requestListener: undefined as undefined | ((req: unknown, res: unknown) => void),
}));

// Fake HTTP server with just enough EventEmitter behavior for startMcpServer's
// `once('error')` / `once('listening')` wiring: listen() fires 'listening' on a
// microtask (like a real server), and tests can grab the created instance.
vi.mock('node:http', () => ({
  createServer: vi.fn((listener: (req: unknown, res: unknown) => void) => {
    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    const server: any = {
      listen: vi.fn((port: number, host: string, cb?: () => void) => {
        httpMocks.listen(port, host, cb);
        queueMicrotask(() => {
          if (httpMocks.error) {
            const pendingErrors = listeners.error ?? [];
            listeners.error = [];
            pendingErrors.forEach((fn) => fn(httpMocks.error));
            return;
          }
          const pending = listeners.listening ?? [];
          listeners.listening = [];
          pending.forEach((fn) => fn());
        });
        return server;
      }),
      once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        (listeners[event] ??= []).push(cb);
        return server;
      }),
      removeListener: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        listeners[event] = (listeners[event] ?? []).filter((fn) => fn !== cb);
        return server;
      }),
      close: vi.fn(),
    };
    httpMocks.requestListener = listener;
    return server;
  }),
}));

const transportMocks = vi.hoisted(() => ({
  close: vi.fn().mockResolvedValue(undefined),
  handleRequest: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: vi.fn().mockImplementation(() => ({
    close: transportMocks.close,
    handleRequest: transportMocks.handleRequest,
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
  it('starts an HTTP server listening on loopback only, on the given port', async () => {
    const server = createMcpServer(buildDeps());
    const httpServer: any = await startMcpServer(server, 4319);
    expect(httpServer.listen).toHaveBeenCalledWith(4319, '127.0.0.1');
  });

  it('rejects (instead of crashing) when the port cannot be listened on', async () => {
    httpMocks.error = new Error('listen EADDRINUSE: address already in use 127.0.0.1:4321');
    try {
      await expect(startMcpServer(createMcpServer(buildDeps()), 4321)).rejects.toThrow(/EADDRINUSE/);
    } finally {
      httpMocks.error = undefined;
    }
  });

  it('rejects a non-POST request with 405 before it ever reaches the request chain', async () => {
    transportMocks.handleRequest.mockClear();
    const server = createMcpServer(buildDeps());
    await startMcpServer(server, 4320);

    const listener = httpMocks.requestListener!;
    const req = { method: 'GET' } as IncomingMessage;
    const res = { statusCode: 200, end: vi.fn(), headersSent: false } as unknown as ServerResponse;

    listener(req, res);

    expect((res as any).statusCode).toBe(405);
    expect((res as any).end).toHaveBeenCalled();

    // Give any (incorrectly) queued chain work a tick to run, then confirm
    // the request never reached handleMcpRequest / the transport.
    await Promise.resolve();
    await Promise.resolve();
    expect(transportMocks.handleRequest).not.toHaveBeenCalled();
  });
});

describe('handleMcpRequest', () => {
  beforeEach(() => {
    transportMocks.close.mockClear();
    transportMocks.handleRequest.mockClear();
  });

  function buildRes() {
    return { headersSent: false, statusCode: 200, end: vi.fn() } as unknown as ServerResponse;
  }

  it('converts a thrown error into an HTTP 500 response instead of throwing', async () => {
    const fakeServer = { connect: vi.fn().mockRejectedValue(new Error('boom')) } as unknown as McpServer;
    const req = {} as IncomingMessage;
    const res = buildRes();

    await expect(handleMcpRequest(fakeServer, req, res)).resolves.toBeUndefined();

    expect((res as any).statusCode).toBe(500);
    expect((res as any).end).toHaveBeenCalled();
  });

  it('always closes the transport, in both the success and thrown-error cases', async () => {
    const okServer = { connect: vi.fn().mockResolvedValue(undefined) } as unknown as McpServer;
    await handleMcpRequest(okServer, {} as IncomingMessage, buildRes());
    expect(transportMocks.close).toHaveBeenCalledTimes(1);

    const failingServer = { connect: vi.fn().mockRejectedValue(new Error('boom')) } as unknown as McpServer;
    await handleMcpRequest(failingServer, {} as IncomingMessage, buildRes());
    expect(transportMocks.close).toHaveBeenCalledTimes(2);
  });

  it('resolves even when transport.close() itself rejects', async () => {
    transportMocks.close.mockRejectedValueOnce(new Error('close boom'));
    const okServer = { connect: vi.fn().mockResolvedValue(undefined) } as unknown as McpServer;

    await expect(handleMcpRequest(okServer, {} as IncomingMessage, buildRes())).resolves.toBeUndefined();
  });
});
