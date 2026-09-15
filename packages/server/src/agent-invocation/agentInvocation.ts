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
  // child 在 startSession 同步阶段先占位为 null——此时 prompt 文件还没写完、进程也还没 spawn；
  // 这样 killSession 在这段异步窗口内也能找到条目并把它标记为 resolved，避免孤儿进程。
  child: ChildProcess | null;
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

    // 同步占位：调用方（orchestrator-core）是同步把会话标记为 running 的，
    // 若在 writePromptFile 这段异步窗口内有人调用 killSession，条目必须已经存在，
    // 否则 kill 找不到会话直接返回，而随后 .then() 仍会 spawn 出一个无人能再杀掉的孤儿进程。
    const entry: RunningSession = { child: null, pgid: 0, resolved: false, rawLogPath };
    sessions.set(sessionKey(roomId, seq), entry);

    void writePromptFile(promptText, promptFile)
      .then(() => {
        // 写 prompt 期间已经被 killSession 标记为 resolved——不再 spawn，避免孤儿进程；
        // 此分支不上报 onSessionEnded：DB 侧已由调用方标记为 terminated，且本会话从未真正启动。
        if (entry.resolved) return;

        const command = config.command.replace('{{promptFile}}', promptFile);

        // 确保日志目录存在——首次向一个房间派发时，<logsDir>/<roomId>/ 尚未创建，
        // createWriteStream 若目标目录不存在会异步触发 'error'，必须在此之前建好目录。
        mkdirSync(path.dirname(rawLogPath), { recursive: true });
        const logStream = createWriteStream(rawLogPath);
        // 防御性兜底：即便目录已建好，写入过程仍可能因权限、磁盘满等原因触发 'error'；
        // 没有监听器的 'error' 事件会被 Node 当作未捕获异常，因此这里必须挂一个空监听器，
        // 实际的失败处理由 child 的 'error'/'exit' 监听器统一走 exited-nonzero 路径。
        logStream.on('error', () => {});
        const endLogStream = () => {
          if (!logStream.writableEnded) logStream.end();
        };

        const child = spawn(command, { shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });

        // 监听器必须在触碰 child.pid / setSessionPgid 之前挂好：spawn 同步失败时（EAGAIN、EMFILE 等）
        // child.pid 为 undefined，后续任何抛错都会让 Node 在无监听器的情况下发出 'error'，
        // 那是会直接打挂进程的未捕获异常。
        child.on('error', () => {
          // spawn 本身失败（命令不存在、ENOENT、无执行权限等）——和 'exit' 互斥，不会同时触发；
          // 按 04-agent-invocation.md §3 步骤 6，统一当作 exited-nonzero 处理，不做进程级/业务级错误区分。
          // 这里也兜底关闭日志流：进程从未真正起来时 'close' 未必会到。
          endLogStream();
          resolveSession(roomId, seq, agentId, 'exited-nonzero');
        });

        child.on('exit', (code) => {
          resolveSession(roomId, seq, agentId, code === 0 ? 'exited-zero' : 'exited-nonzero');
        });

        // 'exit' 可能早于 stdout/stderr 管道排空触发，此时结束日志流会截断 agent 的最后一段输出；
        // 'close' 保证在全部 stdio 关闭后才触发，日志收尾放在这里。
        child.on('close', () => {
          endLogStream();
        });

        child.stdout?.pipe(logStream, { end: false });
        child.stderr?.pipe(logStream, { end: false });

        if (typeof child.pid !== 'number') {
          // spawn 同步失败——不能把 undefined 写进 DB（better-sqlite3 会抛），统一归为 exited-nonzero。
          resolveSession(roomId, seq, agentId, 'exited-nonzero');
          return;
        }

        // 原地更新同一个对象：killSession 可能正持有这个条目的引用。
        entry.child = child;
        entry.pgid = child.pid;
        setSessionPgid(db, roomId, seq, child.pid);
      })
      .catch(() => {
        // writePromptFile 失败（磁盘满、权限不足、目录缺失等），或 .then() 内部抛错——
        // 条目此时已在 sessions map 中，统一走 resolveSession 归为 exited-nonzero（幂等，不会重复上报）。
        resolveSession(roomId, seq, agentId, 'exited-nonzero');
      });
  };

  const killSession: KillSession = async (roomId, seq) => {
    const entry = sessions.get(sessionKey(roomId, seq));
    if (!entry) return { killed: false, rawLogPath: '' };

    // 先置 resolved 再发信号（04-agent-invocation.md §6 步骤 2）：
    // 进程被杀后自然触发的 'exit' 会因此成为 no-op，不会重复上报 onSessionEnded。
    entry.resolved = true;

    // 进程还没 spawn（prompt 还在写）——上面的 resolved 会让 startSession 的 .then() 直接跳过 spawn，
    // 这里没有 pgid 也没有 child 可操作，直接返回 killed:false（但带上真实的 rawLogPath）。
    if (!entry.child) return { killed: false, rawLogPath: entry.rawLogPath };

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
