# Agent 调用适配层设计

负责非交互式 CLI 的启动、实时只读日志、退出事实及人工终止。需求依据见 requirements.md 3.3；生命周期由 03 编排器核心结算。所有正式协作内容通过 MCP 写入，日志不解析成答案或 fact。交互式 PTY 模式属于下一版本，本版本不做设计。

## 1. Agent 注册表与接入条件

```typescript
interface AgentRegistry { agents: Record<string, AgentConfig> }
interface AgentConfig {
  command: string[]; // 一次性非交互调用 argv，直接 exec，不经 shell
  promptVia?: 'arg' | 'stdin'; // 默认 arg
  env?: Record<string, string>;
  mcpFile?: { template: string; path?: string; merge?: boolean }; // 每次 session 独立配置（kimi 例外，见 §2）
  stopGraceMs?: number; // 人工终止 SIGTERM 宽限期，默认 2000
  stopConfirmMs?: number; // SIGKILL 后退出确认期限，默认 3000
}
```

不提供交互式模式、PTY、TUI 就绪检测或退出命令配置。`command` 可包含各家 CLI 的"过程流"输出 flag（codex `--json`、claude `--output-format stream-json`、opencode `--format json`、kimi `--output-format stream-json`），让只读日志实时反映工具调用/思考过程；日志仍按本节"原样记录、不解析"。Codex、Claude、opencode、Kimi 的具体非交互参数、MCP 注入方式、权限策略和进程退出行为须逐家验证；不能仅凭命令名称假定支持。接入条件是：可传入初始任务、可调用 MCP、单次工作完成后自然退出、支持固定 session 身份隔离。未通过适配的 CLI 标为 unavailable，并在建房时拒绝。

非交互式可持续调用工具、发送多条 MCP 消息和流式日志，不要求只输出一个最终答案。禁止需要人类终端应答才能推进的默认启动配置；不得为了绕过提示而统一关闭所有权限限制。

## 2. Prompt 与独立 MCP 配置

每次完整注入协作协议与 buildOverview(roomId) 快照，提供 post_message、complete_exploring、get_overview、get_detail 四个工具。agent 可以主动刷新房间状态，但系统不向忙碌调用推送新指令。人类补充消息不保证立即影响当前 session。

结束说明：正式发现先通过 post_message 提交并等待成功；探索完成时调用 complete_exploring；完成本次工作后结束本次回答，由非交互式 CLI 自然退出。没有新增内容可以不发实质消息。不要等待终端输入。房间完成仍通过 propose_completion 提议，由人类决定。

prompt 副本位于 <logsDir>/prompts/violetdagger-<roomId>-<seq>.prompt.txt；日志根锚定 server 包 logs/，可用 VIOLETDAGGER_LOGS_DIR 覆盖。占位符保留 {{prompt}}、{{promptFile}}、{{mcpUrl}}、{{mcpFile}}。

每次启动签发随机凭据，固定绑定 roomId/agentId/sessionSeq。MCP 配置默认写到 <logsDir>/mcp/<roomId>/<seq>.json，仅当前用户可读写，不修改用户/项目共享 MCP 文件；**kimi 是例外**：它没有 per-invocation 的 MCP 配置 flag，只认 user 级 `~/.kimi-code/mcp.json`（或 `$KIMI_CODE_HOME/mcp.json`），因此它的 `mcpFile` 配置 `path` 指向该文件并 `merge: true`，编排器读取已有 JSON 后深合并（保留其它 server，不整文件覆盖）。CLI 具体凭据注入语法须实测；不能按 agent 当前 session 猜测归属。进程收尾撤销凭据、删除临时配置；重启后旧凭据失效。

## 3. startSession

1. 同步占位，异步准备每个阶段检查是否已取消，防止终止后启动孤儿进程。
2. 构造 prompt、凭据和独立配置。设置 cwd 为 room.workdir，历史空值回退服务端配置及 server cwd。
3. 创建日志目录，立即 setSessionRawLogPath，再用普通子进程直接执行 argv；stdout/stderr 使用管道，绝不创建 PTY。
4. arg 模式通过参数提交任务并关闭不使用的 stdin；stdin 模式只写入初始 prompt 后关闭。浏览器没有写 stdin 的入口。
5. stdout/stderr 按服务器观察顺序统一记录为带 stream 标记的日志事件；保留原文，不提取答案。两个独立流之间不承诺来源进程的全局顺序。
6. 实际进程 close（退出且输出管道收尾）后报告 SessionExitEvent；启动失败也报告。日志写入失败明确记录，不能伪装成正常产出。
7. 凭据撤销与最终业务结算由核心协调；清理临时配置、监听器及缓冲。

日志文件为 JSONL，每行 {offset, stream:'stdout'|'stderr', text}；offset 为 session 内递增事件编号。回放逐条解析，原始 text 不作为控制协议。内存保留最近 256 KiB 的完整事件；单条超限时分块，UI 明确显示历史截断。日志不保证包含完整历史，磁盘复盘提供完整已有记录。

## 4. 只读日志接入

```typescript
type LogChunk = { offset: number; stream: 'stdout' | 'stderr'; text: string };
interface SessionLogHandle {
  snapshot(): { chunks: LogChunk[]; truncated: boolean };
  onData(cb: (chunk: LogChunk) => void): () => void;
  onExit(cb: (event: SessionExitEvent) => void): () => void;
}
function attachSessionLog(roomId: number, seq: number): SessionLogHandle | null;
```

running/stopping 可查看。先订阅增量、缓存期间事件，再截取快照，按 offset 去重拼接，防止快照和订阅之间漏日志。没有 write/resize/interactive 能力。结束或重启后无句柄则读取文件快照。关闭浏览器日志连接不终止进程。

## 5. 人工进程清理

```typescript
type StopResult =
  | { confirmed: true; exit: SessionExitEvent }
  | { confirmed: false; error: string; rawLogPath: string };
function stopSessionProcess(roomId: number, seq: number): Promise<StopResult>;
```

仅人类 terminate（含删除房间前的明确清理）调用；自然完成无需此函数。同一 session 并发请求共用 Promise。

- 已退出返回保存事实；确认从未启动则取消启动并返回 not-started；缺失句柄不等于从未启动。
- 先订阅退出事件，按平台验证的进程组机制发 SIGTERM，默认等待最多 2 秒（可用 `stopGraceMs` 覆盖）；退出则立即收尾。
- 尚未退出则发 SIGKILL，再等待最多 3 秒确认（可用 `stopConfirmMs` 覆盖）；信号发送成功或 ESRCH 本身不算退出确认。
- 确认主进程退出后返回事实；无法确认返回失败，保留订阅供迟到退出事件结算，保持 stopping 与占位。可由人类重试，不自动无限重试。
- 确认范围是主进程；逃离进程组的后代可能残留。重启失联时不凭旧 PID 盲目发信号。
- 日志尽力刷盘；已确认主进程退出但后代仍持有管道时可关闭日志订阅并注明截断，不无限等管道。

## 6. 回调与清理

```typescript
type SessionExitEvent = {
  roomId: number; seq: number; agentId: string;
  exitCode: number | null; signal: string | null;
  exitCause: 'natural' | 'unexpected' | 'spawn-failed' | 'not-started' | 'managed-stop';
  rawLogPath: string;
  cleanupAttemptId?: string;
};
function startSession(params: {
  roomId: number; seq: number; agentId: string; registryKey: string;
}): void;
function deleteRoomArtifacts(roomId: number): Promise<void>;
// 核心注入 onSessionEnded(event: SessionExitEvent)
// 核心注入 onSessionExitProgress(roomId, seq, kind, detail?, cleanupAttemptId?)
// kind: cleanup_started / sigterm_sent / sigkill_sent / cleanup_failed
```

退出监听和清理 Promise 共用同一退出事实，由核心幂等结算。正常零退出为 natural，独立异常为 unexpected，启动失败为 spawn-failed；人工清理的结果由 terminate 意图判定，不把它误算成自然完成。运行记录不含答案提取缓冲。

deleteRoomArtifacts 清理房间日志、prompt 和独立 MCP 配置，不触碰共享用户配置。历史 PTY 文本日志可由只读回放按旧格式显示，不追溯生成消息。
