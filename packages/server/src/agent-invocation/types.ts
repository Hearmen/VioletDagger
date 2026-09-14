export interface AgentConfig {
  command: string;
  mcpConfigPath?: string;
}

export interface AgentRegistry {
  agents: Record<string, AgentConfig>;
}

export type OnSessionEnded = (event: {
  roomId: number;
  seq: number;
  agentId: string;
  result: 'exited-zero' | 'exited-nonzero';
  rawLogPath: string;
}) => void;

export type StartSession = (params: { roomId: number; seq: number; agentId: string }) => void;

export type KillSession = (
  roomId: number,
  seq: number,
) => Promise<{ killed: boolean; rawLogPath: string }>;

export interface AgentInvocation {
  startSession: StartSession;
  killSession: KillSession;
}
