import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { setSessionPgid } from '../storage';
import { buildOverview } from '../memory';
import { buildPromptText, writePromptFile } from './prompt';
import type { AgentRegistry, OnSessionEnded, StartSession, KillSession, AgentInvocation } from './types';

const KILL_GRACE_PERIOD_MS = 2000;

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

    void writePromptFile(promptText, promptFile)
      .then(() => {
        const command = config.command.replace('{{promptFile}}', promptFile);

        // 确保日志目录存在——首次向一个房间派发时，<logsDir>/<roomId>/ 尚未创建，
        // createWriteStream 若目标目录不存在会异步触发 'error'，必须在此之前建好目录。
        mkdirSync(path.dirname(rawLogPath), { recursive: true });
        const logStream = createWriteStream(rawLogPath);
        // 防御性兜底：即便目录已建好，写入过程仍可能因权限、磁盘满等原因触发 'error'；
        // 没有监听器的 'error' 事件会被 Node 当作未捕获异常，因此这里必须挂一个空监听器，
        // 实际的失败处理由 child 的 'error'/'exit' 监听器统一走 exited-nonzero 路径。
        logStream.on('error', () => {});

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
      })
      .catch(() => {
        // writePromptFile 失败（磁盘满、权限不足、目录缺失等）——此时会话还未加入 sessions map，
        // 无法走 resolveSession，直接上报 onSessionEnded，同样统一归为 exited-nonzero。
        onSessionEnded({ roomId, seq, agentId, result: 'exited-nonzero', rawLogPath });
      });
  };

  const killSession: KillSession = async (roomId, seq) => {
    const entry = sessions.get(sessionKey(roomId, seq));
    if (!entry) return { killed: false, rawLogPath: '' };

    entry.resolved = true;
    let killed = true;
    try {
      process.kill(-entry.pgid, 'SIGTERM');
    } catch {
      killed = false;
    }

    await new Promise((resolve) => setTimeout(resolve, KILL_GRACE_PERIOD_MS));

    if (entry.child.exitCode === null) {
      try {
        process.kill(-entry.pgid, 'SIGKILL');
      } catch {
        // best-effort cleanup per 04-agent-invocation.md §6 —— 进程可能已经不在了
      }
    }

    return { killed, rawLogPath: entry.rawLogPath };
  };

  return { startSession, killSession };
}
