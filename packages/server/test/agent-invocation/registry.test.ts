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

  function writeConfig(agents: unknown): string {
    dir = mkdtempSync(path.join(tmpdir(), 'violetdagger-registry-'));
    const configPath = path.join(dir, 'agents.config.json');
    writeFileSync(configPath, JSON.stringify({ agents }));
    return configPath;
  }

  it('loads a valid registry file', () => {
    const configPath = writeConfig({
      codex: { command: ['codex', 'exec', '--json', '{{promptFile}}'] },
    });

    const registry = loadAgentRegistry(configPath);
    expect(registry.agents.codex.command).toEqual(['codex', 'exec', '--json', '{{promptFile}}']);
  });

  it('throws when a command is empty', () => {
    const configPath = writeConfig({ codex: { command: [] } });
    expect(() => loadAgentRegistry(configPath)).toThrow(/non-empty "command"/);
  });

  it('throws when a command is a shell string instead of an argv array', () => {
    const configPath = writeConfig({ codex: { command: 'codex exec' } });
    expect(() => loadAgentRegistry(configPath)).toThrow(/non-empty "command"/);
  });

  it('throws when the command executable is empty', () => {
    const configPath = writeConfig({ codex: { command: ['  ', 'exec'] } });
    expect(() => loadAgentRegistry(configPath)).toThrow(/non-empty "command"/);
  });

  it('throws when a command entry is not a string', () => {
    const configPath = writeConfig({ codex: { command: ['codex', 42] } });
    expect(() => loadAgentRegistry(configPath)).toThrow(/non-string entry/);
  });

  it('accepts a valid env map', () => {
    const configPath = writeConfig({
      opencode: { command: ['opencode', '{{prompt}}'], env: { OPENCODE_CONFIG: '{{mcpFile}}' } },
    });

    const registry = loadAgentRegistry(configPath);
    expect(registry.agents.opencode.env).toEqual({ OPENCODE_CONFIG: '{{mcpFile}}' });
  });

  it('throws when an env value is not a string', () => {
    const configPath = writeConfig({ opencode: { command: ['opencode'], env: { PORT: 42 } } });
    expect(() => loadAgentRegistry(configPath)).toThrow(/non-string env value/);
  });

  it('throws when mcpFile has an empty template', () => {
    const configPath = writeConfig({ claude: { command: ['claude', '-p', 'x'], mcpFile: { template: '  ' } } });
    expect(() => loadAgentRegistry(configPath)).toThrow(/mcpFile/);
  });

  it('accepts a valid mcpFile template config', () => {
    const configPath = writeConfig({
      claude: { command: ['claude', '-p', 'x'], mcpFile: { template: '{"url":"{{mcpUrl}}"}' } },
    });

    const registry = loadAgentRegistry(configPath);
    expect(registry.agents.claude.mcpFile?.template).toBe('{"url":"{{mcpUrl}}"}');
  });

  it('accepts an mcpFile with path and merge (kimi user-level config)', () => {
    const configPath = writeConfig({
      kimi: {
        command: ['kimi', '-p', 'x'],
        mcpFile: { path: '~/.kimi-code/mcp.json', merge: true, template: '{"url":"{{mcpUrl}}"}' },
      },
    });

    const registry = loadAgentRegistry(configPath);
    expect(registry.agents.kimi.mcpFile).toMatchObject({ path: '~/.kimi-code/mcp.json', merge: true });
  });

  it('throws when mcpFile.path is not a string', () => {
    const configPath = writeConfig({ kimi: { command: ['kimi'], mcpFile: { template: '{}', path: 42 } } });
    expect(() => loadAgentRegistry(configPath)).toThrow(/mcpFile\.path/);
  });

  it('accepts valid stopGraceMs / stopConfirmMs', () => {
    const configPath = writeConfig({
      codex: { command: ['codex', 'exec'], stopGraceMs: 500, stopConfirmMs: 1000 },
    });

    const registry = loadAgentRegistry(configPath);
    expect(registry.agents.codex.stopGraceMs).toBe(500);
    expect(registry.agents.codex.stopConfirmMs).toBe(1000);
  });

  it('throws when stopGraceMs is not a non-negative number', () => {
    const configPath = writeConfig({ codex: { command: ['codex', 'exec'], stopGraceMs: -1 } });
    expect(() => loadAgentRegistry(configPath)).toThrow(/stopGraceMs/);
  });

  it('throws when stopConfirmMs is not a number', () => {
    const configPath = writeConfig({ codex: { command: ['codex', 'exec'], stopConfirmMs: 'soon' } });
    expect(() => loadAgentRegistry(configPath)).toThrow(/stopConfirmMs/);
  });

  it('loads the committed default agents.config.json without throwing', () => {
    const registry = loadAgentRegistry(path.join(__dirname, '../../agents.config.json'));
    expect(Object.keys(registry.agents).sort()).toEqual(['claude', 'codex', 'kimi', 'opencode']);
  });
});
