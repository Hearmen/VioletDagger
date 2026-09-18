import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// post_message/complete_exploring/get_overview/get_detail（见 05-mcp-server.md）
const EXPECTED_TOOLS = ['post_message', 'complete_exploring', 'get_overview', 'get_detail'] as const;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, url: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`MCP server at ${url} did not respond within ${timeoutMs}ms`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// 启动自检：连本进程的 MCP server，确认 transport 可用且四个工具都已注册。
// 只读、一次性；失败抛错，由 startApp 收尾（关掉已监听的 server）后退出。
export async function verifyMcpServer(url: string, timeoutMs = 5000): Promise<void> {
  const client = new Client({ name: 'violetdagger-startup-check', version: '0.0.1' });
  try {
    await withTimeout(
      client.connect(new StreamableHTTPClientTransport(new URL(url))),
      timeoutMs,
      url,
    );
    const { tools } = await withTimeout(client.listTools(), timeoutMs, url);
    const names = new Set(tools.map((tool) => tool.name));
    const missing = EXPECTED_TOOLS.filter((name) => !names.has(name));
    if (missing.length > 0) {
      throw new Error(`MCP server at ${url} is missing tools: ${missing.join(', ')}`);
    }
  } finally {
    await client.close().catch(() => {});
  }
}
