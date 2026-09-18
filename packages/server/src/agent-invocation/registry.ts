import { readFileSync } from 'node:fs';
import type { AgentRegistry } from './types';

export function loadAgentRegistry(configPath: string): AgentRegistry {
  const raw = readFileSync(configPath, 'utf-8');
  const parsed = JSON.parse(raw) as AgentRegistry;

  for (const [agentId, config] of Object.entries(parsed.agents)) {
    if (!Array.isArray(config.command) || config.command.length === 0 || typeof config.command[0] !== 'string' || config.command[0].trim() === '') {
      throw new Error(`Agent "${agentId}" is missing a non-empty "command" array (first element must be the executable)`);
    }
    if (config.command.some((part) => typeof part !== 'string')) {
      throw new Error(`Agent "${agentId}" has a non-string entry in its "command" array`);
    }
    if (config.promptVia !== undefined && config.promptVia !== 'arg' && config.promptVia !== 'stdin') {
      throw new Error(`Agent "${agentId}" has promptVia "${config.promptVia}" (expected "arg" or "stdin")`);
    }
    if (config.env) {
      for (const [key, value] of Object.entries(config.env)) {
        if (typeof value !== 'string') {
          throw new Error(`Agent "${agentId}" has a non-string env value for "${key}"`);
        }
      }
    }
    if (config.mcpFile) {
      if (!config.mcpFile.template || config.mcpFile.template.trim() === '') {
        throw new Error(`Agent "${agentId}" has an mcpFile with an empty "template"`);
      }
      if (config.mcpFile.path !== undefined && typeof config.mcpFile.path !== 'string') {
        throw new Error(`Agent "${agentId}" has a non-string mcpFile.path`);
      }
      if (config.mcpFile.merge !== undefined && typeof config.mcpFile.merge !== 'boolean') {
        throw new Error(`Agent "${agentId}" has a non-boolean mcpFile.merge`);
      }
    }
    for (const field of ['stopGraceMs', 'stopConfirmMs'] as const) {
      const value = config[field];
      if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
        throw new Error(`Agent "${agentId}" has an invalid "${field}" (expected a non-negative number)`);
      }
    }
  }

  return parsed;
}
