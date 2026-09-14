export interface AgentConfig {
  command: string;
  mcpConfigPath?: string;
}

export interface AgentRegistry {
  agents: Record<string, AgentConfig>;
}
