import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadAgentRegistry } from '../../src/agent-invocation/registry';

describe('loadAgentRegistry', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('loads a valid registry file', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'violetdagger-registry-'));
    const configPath = path.join(dir, 'agents.config.json');
    writeFileSync(configPath, JSON.stringify({
      agents: { codex: { command: 'codex exec --json {{promptFile}}' } },
    }));

    const registry = loadAgentRegistry(configPath);
    expect(registry.agents.codex.command).toBe('codex exec --json {{promptFile}}');
  });

  it('throws when a command is empty', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'violetdagger-registry-'));
    const configPath = path.join(dir, 'agents.config.json');
    writeFileSync(configPath, JSON.stringify({ agents: { codex: { command: '' } } }));

    expect(() => loadAgentRegistry(configPath)).toThrow(/non-empty "command"/);
  });

  it('throws when mcpConfigPath does not point to an existing file', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'violetdagger-registry-'));
    const configPath = path.join(dir, 'agents.config.json');
    writeFileSync(configPath, JSON.stringify({
      agents: { codex: { command: 'codex exec', mcpConfigPath: path.join(dir, 'missing.json') } },
    }));

    expect(() => loadAgentRegistry(configPath)).toThrow(/mcpConfigPath/);
  });

  it('accepts a valid mcpConfigPath that exists', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'violetdagger-registry-'));
    const configPath = path.join(dir, 'agents.config.json');
    const mcpConfigPath = path.join(dir, 'mcp.json');
    writeFileSync(mcpConfigPath, '{}');
    writeFileSync(configPath, JSON.stringify({
      agents: { codex: { command: 'codex exec', mcpConfigPath } },
    }));

    expect(() => loadAgentRegistry(configPath)).not.toThrow();
  });

  it('loads the committed default agents.config.json without throwing', () => {
    const registry = loadAgentRegistry(path.join(__dirname, '../../agents.config.json'));
    expect(Object.keys(registry.agents).sort()).toEqual(['claude', 'codex', 'kimi', 'opencode']);
  });
});
