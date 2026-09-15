import { existsSync, readFileSync } from 'node:fs';
import type { AgentRegistry } from './types';

export function loadAgentRegistry(configPath: string): AgentRegistry {
  const raw = readFileSync(configPath, 'utf-8');
  const parsed = JSON.parse(raw) as AgentRegistry;

  for (const [agentId, config] of Object.entries(parsed.agents)) {
    if (!config.command || config.command.trim() === '') {
      throw new Error(`Agent "${agentId}" is missing a non-empty "command"`);
    }
    if (config.mcpConfigPath && !existsSync(config.mcpConfigPath)) {
      throw new Error(`Agent "${agentId}" has mcpConfigPath "${config.mcpConfigPath}" which does not exist`);
    }
  }

  return parsed;
}
