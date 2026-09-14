import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { setSessionPgid } from '../storage';
import { buildOverview } from '../memory';
import { buildPromptText, writePromptFile } from './prompt';
import type { AgentRegistry, OnSessionEnded, StartSession, AgentInvocation } from './types';

interface RunningSession {
  child: ChildProcess;
  pgid: number;
  resolved: boolean;
  rawLogPath: string;
}

export function createAgentInvocation(deps: {
  db: Database.Database;
  registry: AgentRegistry;
  onSessionEnded: OnSessionEnded;
  logsDir: string;
  promptDir?: string;
}): AgentInvocation {
  const { db, registry, onSessionEnded, logsDir } = deps;
  const promptDir = deps.promptDir ?? tmpdir();
  const sessions = new Map<string, RunningSession>();
  const sessionKey = (roomId: number, seq: number) => `${roomId}:${seq}`;

  function resolveSession(
    roomId: number,
    seq: number,
    agentId: string,
    result: 'exited-zero' | 'exited-nonzero',
  ): void {
    const entry = sessions.get(sessionKey(roomId, seq));
    if (!entry || entry.resolved) return;
    entry.resolved = true;
    onSessionEnded({ roomId, seq, agentId, result, rawLogPath: entry.rawLogPath });
  }

  const startSession: StartSession = ({ roomId, seq, agentId }) => {
    const config = registry.agents[agentId];
    if (!config) {
      onSessionEnded({ roomId, seq, agentId, result: 'exited-nonzero', rawLogPath: '' });
      return;
    }

    const overview = buildOverview(db, roomId);
    const promptText = buildPromptText({ roomId, agentId, overview });
    const promptFile = path.join(promptDir, `violetdagger-${roomId}-${seq}.prompt.txt`);
    const rawLogPath = path.join(logsDir, String(roomId), `${seq}.log`);

    void writePromptFile(promptText, promptFile).then(() => {
      const command = config.command.replace('{{promptFile}}', promptFile);
      const logStream = createWriteStream(rawLogPath);
      const child = spawn(command, { shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });

      child.stdout?.pipe(logStream, { end: false });
      child.stderr?.pipe(logStream, { end: false });

      const pgid = child.pid!;
      sessions.set(sessionKey(roomId, seq), { child, pgid, resolved: false, rawLogPath });
      setSessionPgid(db, roomId, seq, pgid);

      child.on('error', () => {
        // spawn 本身失败（命令不存在、ENOENT、无执行权限等）——和 'exit' 互斥，不会同时触发；
        // 按 04-agent-invocation.md §3 步骤 6，统一当作 exited-nonzero 处理，不做进程级/业务级错误区分
        logStream.end();
        resolveSession(roomId, seq, agentId, 'exited-nonzero');
      });

      child.on('exit', (code) => {
        logStream.end();
        resolveSession(roomId, seq, agentId, code === 0 ? 'exited-zero' : 'exited-nonzero');
      });
    });
  };

  return { startSession };
}
