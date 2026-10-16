import { createNullAdapter, type NativeSessionAdapter } from './adapter';
import { claudeAdapter } from './claude';
import { codexAdapter } from './codex';
import { kimiAdapter } from './kimi';
import { opencodeAdapter } from './opencode';

export * from './adapter';

// 适配器注册表（04-agent-invocation.md §7.1）：每个 registryKey 一个实现，编排器只经由本函数取用。
const ADAPTERS: Record<string, NativeSessionAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  opencode: opencodeAdapter,
  kimi: kimiAdapter,
};

export function getNativeSessionAdapter(registryKey: string): NativeSessionAdapter {
  return ADAPTERS[registryKey] ?? createNullAdapter(registryKey);
}
