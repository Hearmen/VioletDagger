# Agent 调用适配层设计

负责非交互式 CLI 的启动、实时只读日志、退出事实及人工终止。需求依据见 requirements.md 3.3、3.3.1；生命周期由 03 编排器核心结算。所有正式协作内容通过 MCP 写入，日志不解析成答案或 fact，也不用于任何统计。token、费用、模型调用步数与工具调用统计只从 CLI 原生会话（副本或原数据库）解析（见 §7）；这些数字只用于展示，不产出消息、不写入记忆、不参与 outcome 判定。交互式 PTY 模式属于下一版本，本版本不做设计。

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

每次完整注入协作协议与 buildOverview(roomId) 快照，提供 post_message、complete_exploring、get_overview、get_detail 四个工具。agent 可以主动刷新房间状态，但系统不向忙碌调用推送新指令。人类补充消息不保证立即影响当前 session。组装出的完整 prompt 有大小上限（默认 128 KiB UTF-8，见 `02-memory-management.md` §3）；超限时这次派发直接以 `spawn-failed` 结算（见 §6），不会真正启动进程，不截断、不重试。

结束说明：正式发现先通过 post_message 提交并等待成功；探索完成时调用 complete_exploring。**一次 session 不必只做一件事**——如果一项发现自然引出下一步具体可做的动作（例如发现问题后，修复方案明确且自己能实现验证），应在同一 session 内继续做完，用对应类型分别记录每一步，不要止步于第一条就结束、把本可以现在做完的事留给下一次派发。**但不得在同一 session 内 verify 本 session 发出的消息**——verify 是独立复核，核心会拒绝这类写入（`03-orchestrator-core.md` §1.4）；同一 agent 在后续 session 中可以 verify 自己此前的产出。`propose_completion` 不受此限，对自己刚完成的工作提议收尾是正常模式，交叉核验仍然靠后续的 verify。确认没有更多增量时结束本次回答，由非交互式 CLI 自然退出；没有新增内容可以不发实质消息。不要等待终端输入。房间完成仍通过 propose_completion 提议，由人类决定。

### 2.1 Prompt 模板全文

`buildPromptText(roomId, agentId, goalContent, overview)` 拼出的完整文本，只有 3 处随派发而变的动态插槽（`{{roomId}}`、`{{agentId}}`、`{{renderOverviewText(goalContent, overview)}}`），其余固定文本每次原样注入，不因 agent 或房间不同而改写一字。这是需求 3.3"每次 session 都从零开始，必须每次完整给出协议规则"的具体落地，代码（`packages/server/src/agent-invocation/prompt.ts`）必须和下面的模板逐字一致，改动先改这里。

- `{{renderOverviewText(goalContent, overview)}}` 是记忆面板，由 `02-memory-management.md` §3.4 的 `renderOverviewText` 生成，内容依次为 goal 全文、摘要树（已关闭的子问题及其相关 exploring 按 02 §3.4 折叠，只影响这份文本，不影响存储）和固定引导语；`goalContent` 是房间首条消息（goal）的**完整正文**，由 `getFirstMessage(roomId).content` 取得——概览里的 goal 只有摘要，任务描述必须完整给出。MCP `get_overview` 返回的是同一个函数的输出，agent 中途刷新看到的格式与这里一致。
- **@ 定向消息（需求 3.3.2）对 agent 完全不可见**：`dispatchScope` 不会以任何形式注入 prompt，被 @ 的 agent 拿到的输入跟被广播派发时逐字节一致。`renderMemory` 也不渲染 `targetAgentId`（`MessageSummary` 不含该字段）。

```
你正在参与一个多 Agent 协同研究任务。
roomId：{{roomId}}
你的 authorId：{{agentId}}

多个 Agent 同时在这个房间里工作。你的职责是推进任务目标：先处理等待独立验证的工作，把尚未拆开的目标拆成可以并行的子问题，再认领一个尚未被覆盖的方向，在本次 Session 内尽可能深入地研究。

## 并行协作

- 其他 Agent 只会被触发型消息拉起：OPEN 的 open_question、hypothesis、CANDIDATE 的 chain、challenge。写入触发型消息后，系统会在有空闲 Agent 时尽快派发一个去处理；短时间内的多条可能合并由一个 Agent 处理。fact、boundary、verify、exploring、propose_completion 和无类型聊天不会触发派发。人类消息遵循同一规则。你发出的触发型消息，就是其他 Agent 的工作来源。
- **产出一条就立即提交一条**，不要攒到 Session 结束时一起发。hypothesis、chain、challenge 越早提交，其他 Agent 就越早能并行验证，你则继续做下一步。
- **先拆分，再研究**：goal 或某个 open_question 包含多个可以独立研究的部分（不同组件、不同子问题、不同约束），而记忆面板里还没有对应的子问题时，先把它们各发成一条 open_question（每条一个具体、可独立回答的问题，正文开头注明所属的父问题，例如"（#1 的子问题）"），然后只认领其中一个。其余子问题会由其他 Agent 并行领取。不要把所有研究都挂在 goal 下。
- **子问题各自收尾**：每个子问题由自己的 chain 关闭。goal 的收尾 chain 以引用各子问题已 VERIFIED 的 chain 为主，只写组合方式和整体验收结果，不要在一条 chain 里重新整合所有组件的细节——任何一处缺陷都会让整条 chain 被 REJECT。
- 已有 active exploring 或 CANDIDATE chain 覆盖的工作（包括整合），不要另起一份平行的。

## 协作规则

**可用工具**：
- post_message(roomId, authorId, content, type?, targetMessageId?, referencedMessageIds?, verifyVerdict?, closesQuestion?, chainResolution?, summary?)：写入一条消息。type 留空就是纯聊天，不进入记忆，也不能带任何关联字段。
- complete_exploring(roomId, authorId, messageId, resultSummary, resultMessageIds?)：把你自己当前 active 的 exploring 标记为完成，resultSummary 必填，无结论也如实写明。
- get_overview(roomId)：获取当前房间状态摘要——下面已经给你一份派发时刻的快照，需要最新数据时可以随时重新调用。
- get_detail(roomId, messageId | { type } | { list: true, type?, targetMessageId?, beforeId?, limit? })：查看某条或某类消息的完整内容，list:true 时分页浏览全部历史（含普通聊天）。下面的记忆面板只是摘要，需要完整内容时调用它。

**记忆类型**：fact、boundary、hypothesis 都必须能脱离任何具体方案独立成立；方案、修复和设计取舍一律写成 chain。
| type | 含义 | 发送要求 |
|---|---|---|
| open_question | 需要继续研究的问题；只有 OPEN、CLOSED 两种状态 | 不带 targetMessageId；应描述一个具体、可继续探索的问题 |
| hypothesis | 待验证的独立判断 | 必须用 targetMessageId 指向它涉及的 open_question；写成一个可以被验证的肯定陈述 |
| fact | 已确认的事实 | 关于问题本身、需求、运行环境、依赖库或外部系统，任何方案都能直接引用；必须有明确证据；一条消息只写一个事实；直接回答某个 open_question 时必须用 targetMessageId 指向它 |
| boundary | 已确认的约束或死胡同 | 必须说明为什么不可行、成立的条件和范围；单次尝试失败或某个方案被否定都不能写成 boundary；直接回答某个 open_question 时必须用 targetMessageId 指向它 |
| chain | 某个 open_question 的一个完整候选方案或答案（包括修复版）；状态为 CANDIDATE / VERIFIED / CHALLENGED / REJECT | 必须用 targetMessageId 指向它回答的 open_question，用 referencedMessageIds 标注依据；认为它足以关闭该问题时设 closesQuestion=true，并用 chainResolution 给出 RESOLVED（已解决）或 UNRESOLVED（确认无法解决）；只有新路径或实质变化才发新 chain |
| challenge | 对已有结论的质疑 | 必须用 targetMessageId 指向 fact、boundary，或 CANDIDATE / VERIFIED / REJECT 状态的 chain，并写明质疑点和依据 |
| verify | 对 hypothesis 或 chain 的独立验证 | 必须用 targetMessageId 指向 hypothesis，或 CANDIDATE / CHALLENGED 状态的 chain，并设 verifyVerdict=true/false；不能 verify 本次 Session 发出的消息（此前 Session 的都可以，包括你自己的）；必须采用独立且有实质差异的方法 |
| exploring | 你正在占用的研究方向，不代表知识 | 开始实际探索前发送；必须用 targetMessageId 指向一个 open_question 或 hypothesis；内容写明要解决什么、从什么方向、用什么方法、范围是什么；不得与当前 active exploring 明显重复 |
| propose_completion | 你认为任务可以结束的一次性信号 | 只有 goal 已得到充分回答、且 goal 没有明显其他方向时发送；不带 targetMessageId；不参与状态转换，不直接关闭问题 |

**状态转换（由 Scheduler 自动完成，你不需要也不能手动修改）**：
- hypothesis 被 verify：true 表示判断成立，转为 fact；false 表示判断不成立、对应的路径走不通，转为 boundary。
- fact / boundary 被 challenge → 转回 hypothesis；如果它回答的问题已关闭，该问题重新变为 OPEN。
- chain 被 verify：true → VERIFIED，false → REJECT；被 challenge → CHALLENGED，之后只能通过 verify 转为 VERIFIED 或 REJECT。
- closesQuestion=true 的 chain 变为 VERIFIED 时，目标问题按 chainResolution 关闭；chain 处于其他状态时问题保持 OPEN；已 VERIFIED 的 chain 被 challenge 后，它关闭的问题重新变为 OPEN。
- 所有转换都会记录在转换历史中，消息正文永不修改。

**缺陷与修复**：发现已有 fact、boundary 或 chain 存在缺陷（结论错误、遗漏关键条件、在某些输入下不成立）时，必须发 challenge 指向它并写明缺陷和依据，不要另发一条 fact 或 hypothesis 描述这个缺陷——那样不会触发调度，原结论也不会转回待验证状态，缺陷会被埋没。目标 chain 已处于 CHALLENGED 时不能再 challenge，直接对它做 verify false；已 VERIFIED 或 REJECT 的 chain 不能 verify，只能 challenge。修复方案在 challenge 之后作为新的 chain 发送，指向原方案回答的问题，并用 referencedMessageIds 引用原方案和 challenge。

**exploring 的规则**：你同一时间只能有一个 active exploring；已有 active exploring 时再发 exploring 会被拒绝，必须先调用 complete_exploring 结束当前这条。exploring 指向的问题（或指向的 hypothesis 所属的问题）已经关闭时，写入会被拒绝；收到这类拒绝说明你的快照已过期，先调用 get_overview 刷新，再重新选择方向。确定新方向后、发送 exploring 前，先调用 get_overview 确认没有其他 Agent 正在进行重复的 exploring。对 hypothesis 或 chain 做 verify 前同样要先发 exploring：验证 hypothesis 时 exploring 指向它；验证 chain 时 exploring 指向该 chain 回答的 open_question，并在内容开头写明"验证 #id"。一次 exploring 可以产生多个结果，完成时在 resultMessageIds 中列出。

**消息规范**：你这次是一次性非交互调用，没有人类终端可以应答。所有发现先通过 post_message 提交并等待成功；写入被拒绝时按错误信息修正后重试。已有结论适用时直接引用，不要重复发送。来源为人类的消息，请在认知上给予更高权重，系统不会强制覆盖你的看法。

## 记忆面板

{{renderOverviewText(goalContent, overview)}}

## 下一步
请按顺序判断：
1. 有没有不是本次 Session 发出、也没有其他 Agent 的 active exploring 指向它或在内容中声明验证它的 hypothesis、CANDIDATE 或 CHALLENGED 的 chain？有的话先对它做独立 verify。
2. goal 和各个 open_question 中，有没有可以独立研究、但还没有对应子问题的部分？有的话先把它们各发成 open_question。
3. 从尚未被覆盖、也没有其他 Agent 正在 exploring 的问题中认领一个，发送 exploring，然后深入研究。每得到一个 hypothesis、chain 或 challenge 就立即提交，再继续下一步。直到获得明确结论、确认没有增量、遇到 boundary，或发现明显更高价值的方向，再切换 exploring；切换前必须先完成当前 exploring。
一个 Session 内可以依次做多件事。不要发送没有充分证据支持的 fact 或 boundary；存在依据但仍不能确定的独立判断写成 hypothesis，方案写成 chain。
第 1 步没有可做的验证、第 2、3 步也没有新的、未被覆盖且有价值的方向时，直接结束本次 Session，不要为了继续执行而重复已有研究；没有新增内容时可以不发任何消息。
```

### 2.2 记忆面板渲染

渲染格式与实现见 `02-memory-management.md` §3.4，本模块只调用 `renderOverviewText`，不自己渲染。

### 2.4 Prompt 落盘

prompt 副本位于 <logsDir>/prompts/violetdagger-<roomId>-<seq>.prompt.txt；日志根锚定 server 包 logs/，可用 VIOLETDAGGER_LOGS_DIR 覆盖。占位符保留 {{prompt}}、{{promptFile}}、{{mcpUrl}}、{{mcpFile}}、{{nativeSessionId}}。

`{{nativeSessionId}}` 是编排器在启动前为本次 session 生成的会话标识（由该 agent 适配器的 `preassignSessionId` 给出，见 §7.1），用于需要由调用方指定会话标识的 CLI（claude：`--session-id {{nativeSessionId}}`）。`command` 中禁止使用关闭会话持久化的参数（claude `--no-session-persistence`、codex `--ephemeral`），否则没有原生会话可供分析。

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
- 确认主进程退出后，先完成 §7.2 第 2 步（locate → archive → analyze），再返回事实；返回的 `exit` 已带 `usage` 与 `native`。无法确认返回失败，保留订阅供迟到退出事件结算，保持 stopping 与占位。可由人类重试，不自动无限重试。
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
  usage?: SessionUsage; // 见 §7.2；spawn-failed/not-started 不带这个字段
  native?: SessionNativeRef; // 见 01-storage.md；数据库型 originalPath 为数据库文件、copyPath 恒为 null；spawn-failed/not-started 不带
};
function startSession(params: {
  roomId: number; seq: number; agentId: string; registryKey: string;
}): void;
function deleteRoomArtifacts(roomId: number): Promise<NativeDeleteFailure[]>;
// NativeDeleteFailure 见 §7.1
// 核心注入 onSessionEnded(event: SessionExitEvent)
// 核心注入 onSessionExitProgress(roomId, seq, kind, detail?, cleanupAttemptId?)
// kind: cleanup_started / sigterm_sent / sigkill_sent / cleanup_failed / native_session_failed
```

退出监听和清理 Promise 共用同一退出事实，由核心幂等结算。正常零退出为 natural，独立异常为 unexpected，启动失败为 spawn-failed；人工清理的结果由 terminate 意图判定，不把它误算成自然完成。运行记录不含答案提取缓冲。

deleteRoomArtifacts 清理房间日志（含原生会话副本）、prompt 和独立 MCP 配置，并对每个记录了原生会话标识的 session 调用适配器的 `deleteOriginal` 删除原件（§7.2），不触碰共享用户配置中与本房间无关的内容。历史 PTY 文本日志可由只读回放按旧格式显示，不追溯生成消息。

## 7. 原生会话分析适配器

每种 agent 的原生会话格式、位置和删除方式各不相同，统一抽象为一个适配器接口，每个 registryKey 一个实现，彼此独立。编排器只通过接口调用，不出现按 registryKey 分支的逻辑。

### 7.1 接口

```typescript
interface LocatedNativeSession {
  sessionId: string;
  storage: 'file' | 'database';
  originalPath: string; // 文件型为会话文件或目录；数据库型为数据库文件
}
type NativeSessionSource =
  | { storage: 'file'; copyPath: string }
  | { storage: 'database'; originalPath: string; sessionId: string };
interface LocateContext {
  roomId: number; seq: number; agentId: string; cwd: string;
  startedAt: string; endedAt: string;
  preassignedId: string | null; // preassignSessionId 的返回值
  rawLogPath: string;           // 只用于读取会话标识，不用于统计
}
interface NativeToolCall {
  name: string;            // isRoomMcp 为 true 时为去掉 server 前缀的工具名（如 post_message）；否则为该 CLI 自己的工具名
  isRoomMcp: boolean;
  failed: boolean | null;  // null 表示成败未知
}
interface NativeSessionStats {
  usage: SessionUsage;            // inputTokens 为非缓存输入；outputTokens 含推理/思考 token
  steps: number | null;           // 模型调用次数
  firstResponseAt: string | null; // 第一次模型调用完成时间（ISO）
  toolCalls: NativeToolCall[] | null;
}
interface NativeSessionAdapter {
  readonly registryKey: string;
  preassignSessionId(): string | null;          // 启动前；非 null 时注入 {{nativeSessionId}}
  locate(ctx: LocateContext): Promise<LocatedNativeSession | null>;
  archive(ref: LocatedNativeSession, copyDir: string): Promise<NativeSessionSource | null>;
  analyze(source: NativeSessionSource, signal?: AbortSignal): Promise<NativeSessionStats>;
  deleteOriginal(ref: LocatedNativeSession): Promise<void>;
}
interface NativeDeleteFailure { seq: number; agentId: string; target: string; error: string }
function getNativeSessionAdapter(registryKey: string): NativeSessionAdapter;
```

**接口约定**：
- **未注册的 registryKey** 返回空适配器：`locate` 返回 null，`analyze` 返回全 null，`deleteOriginal` 不做任何事。新增 agent 要支持统计，就新增一个适配器实现，不改编排器。
- **`archive`**：文件型复制到 `copyDir`（`<logsDir>/<roomId>/native/<seq>/`），返回 `{storage:'file', copyPath}`；数据库型不复制，直接返回指向原库的 source。复制失败时删除不完整的副本，返回 null。
- **`analyze`**：只读。文件型读副本；数据库型以只读模式打开原库，读完即关闭。字段解析失败时取 null，不抛错，不做费用估算。`signal` 被 abort 时立即停止读取、关闭已打开的文件或数据库句柄，并以 abort 错误结束。
- **`isRoomMcp`**：本系统 MCP server `violetdagger` 的工具为 true，此时 `name` 去掉各 CLI 的 server 前缀（`mcp__violetdagger__`、`violetdagger_`），只保留工具名，使不同 CLI 的同一工具在报告中合并为一行。
- **子 agent**：各适配器都不统计子 agent 的记录。

代码位于 `packages/server/src/agent-invocation/native-session/`：
- `adapter.ts`：接口与空适配器
- `claude.ts`、`codex.ts`、`opencode.ts`、`kimi.ts`：各 agent 的实现
- `index.ts`：注册表

### 7.2 调用时机

1. **启动前**：调用 `preassignSessionId`，返回值注入 `{{nativeSessionId}}`。
2. **结束后**：确认主进程退出后、报告 `SessionExitEvent` 前，依次调用 `locate` → `archive` → `analyze`。
   - `analyze(...).usage` 随 `SessionExitEvent.usage` 上报入库，其余统计不入库；没有可读的原生会话时用量全为 null。
   - natural、unexpected、managed-stop 都执行；spawn-failed、not-started 跳过。
   - 任一步失败只写入生命周期记录：经 `onSessionExitProgress(roomId, seq, 'native_session_failed', <错误信息>, <步骤名 locate/archive/analyze>)` 追加一条事件；后续字段记 null，不改变 outcome。locate 未找到会话（返回 null）不算失败，不记录。
   - 外部命令超时默认 10 秒。
3. **生成分析报告时**：按 session 记录重建 `NativeSessionSource`，再调用 `analyze`。
4. **删除房间时**：对每个记录了会话标识的 session 调用 `deleteOriginal`。
   - 原件不存在时视为成功。
   - 失败收集为 `{ seq, agentId, target, error }[]` 返回，由 06 接口提示人类。
   - 副本随房间日志目录一起删除。

### 7.3 claude 适配器（文件型）

- **preassignSessionId**：生成 UUID，command 中以 `--session-id {{nativeSessionId}}` 传入。
- **locate**：查找 `<claudeHome>/projects/*/<id>.jsonl`；`claudeHome` 为 `$CLAUDE_CONFIG_DIR`，未设置时为 `~/.claude`。
- **archive**：复制 `<id>.jsonl` 与同名目录 `<id>/`。
- **analyze**：
  - 取 `type=assistant`、`isSidechain=false` 的条目，按 `message.id` 去重：同一响应按内容块拆成多条，取最后一条。
  - **token**：`usage` 的 `input_tokens` / `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens` 求和。
  - **费用**：取最后一条 `type=cost-state` 条目的 `totalCostUSD`（累计值，不求和）。没有该条目，或 `hasUnknownModelCost=true` 时，`costUsd` 为 null。
  - **步数**：去重后的 `message.id` 数。
  - **首次响应**：第一条 assistant 的 `timestamp`。
  - **工具调用**：content 中的 `tool_use` 块，前缀 `mcp__violetdagger__` 的是本系统工具；对应 `tool_result.is_error=true` 为失败。
- **deleteOriginal**：删除 `<id>.jsonl` 与 `<id>/`。

### 7.4 codex 适配器（文件型）

- **preassignSessionId**：null。
- **locate**：从 rawLog 的 stdout 中第一个 `thread.started` 事件取 `thread_id`，再查找 `<codexHome>/sessions/*/*/*/rollout-*-<id>.jsonl`；`codexHome` 为 `$CODEX_HOME`，未设置时为 `~/.codex`。
- **archive**：复制 rollout 文件。
- **analyze**：
  - **token**：`token_usage_record.usage` 求和：input = `input_tokens − cached_input_tokens`，cacheRead = `cached_input_tokens`，cacheWrite = `cache_write_input_tokens`，output = `output_tokens`。
  - **费用**：rollout 中没有费用字段，`costUsd` 为 null。
  - **步数**：`token_usage_record` 条数。
  - **首次响应**：第一条 `token_usage_record` 的 `timestamp`。
  - **工具调用**：`item_completed` 中带 `status` 字段、且 `item.type` 不是 UserMessage / AgentMessage / Reasoning 的条目；没有 `status` 字段的条目（如 SubAgentActivity、ContextCompaction）不是工具调用。
    - McpToolCall 取 `tool` 为名称，`server=violetdagger` 为本系统工具；其余类型以 `item.type` 为名称。
    - 不统计 `custom_tool_call`：它是 code mode 的 `exec` 外壳，统计它会重复计数。
    - `status = "failed"` 为失败，`status = "completed"` 为成功，其他取值为成败未知。
- **deleteOriginal**：执行 `codex delete --force <id>`（不带 `--force` 会交互式询问确认），codex 会同时清理自己的线程索引。

### 7.5 opencode 适配器（数据库型）

- **preassignSessionId**：null。
- **locate**：从 rawLog 的 stdout 中第一个带 `sessionID` 的事件取标识；原始位置为 `<opencodeData>/opencode.db`（`opencodeData` 为 `$XDG_DATA_HOME/opencode`，未设置时为 `~/.local/share/opencode`），并确认 `session` 表中有该 id。
- **archive**：不复制，返回数据库 source。
- **analyze**：只读打开数据库，读取 `part` 表中 `session_id=<id>` 的行，解析 `data` JSON。
  - **token 与费用**：`type=step-finish` 的 `tokens.input`、`tokens.output + tokens.reasoning`、`tokens.cache.read`、`tokens.cache.write`、`cost` 求和。
  - **步数**：`step-finish` 的条数。
  - **首次响应**：`message` 表中该会话第一条 `role=assistant` 消息的 `time.completed`。
  - **工具调用**：`type=tool` 的部件，名称取 `tool`，前缀 `violetdagger_` 的是本系统工具；`state.status=error` 为失败。
  - **表结构不符**（opencode 升级后变化）：全部字段取 null。
- **deleteOriginal**：执行 `opencode session delete <id>`。

### 7.6 kimi 适配器（文件型）

- **preassignSessionId**：null。
- **locate**：
  1. **优先读 stdout**：从 rawLog 的 stdout 中取最后一个 `role=meta`、`type=session.resume_hint` 事件的 `session_id`（kimi 在 prompt 模式结束时输出）。在 `<kimiHome>/session_index.jsonl` 中查找 `sessionId` 等于它的条目，取其 `sessionDir`，并确认目录存在；`kimiHome` 为 `$KIMI_CODE_HOME`，未设置时为 `~/.kimi-code`。
  2. **回退匹配**：stdout 里没有该事件（如 CLI 中途崩溃），或索引中查不到该标识时，在索引中查找满足以下全部条件的条目：
     - `workDir` 与本 session 的 cwd 指向同一目录：两者都先经 `realpath` 解析后再比较（kimi 记录的是解析后的路径，如 macOS 上 `/tmp/x` 记为 `/private/tmp/x`）；路径本身已不存在时（如房间的工作目录后来被删除），解析其最近一个仍存在的上级目录，再拼回剩余部分（`/tmp/memos` 不存在时解析 `/tmp` 得 `/private/tmp`，结果为 `/private/tmp/memos`）；根目录都无法解析时退回原字符串比较；
     - 该会话 `state.json` 的 `createdAt` 落在本 session 启动与结束之间；
     - `agents/main/wire.jsonl` 中 `turn.prompt` 的文本同时包含本 session 的 `roomId` 与 `agentId`。

     恰好一条匹配才算成功。
- **archive**：复制整个会话目录。
- **analyze**（读 `agents/main/wire.jsonl`）：
  - **token**：`usage.record` 的 `inputOther` / `output` / `inputCacheRead` / `inputCacheCreation` 求和。
  - **费用**：没有费用字段，`costUsd` 为 null。
  - **步数**：`usage.record` 条数。
  - **首次响应**：第一条 `usage.record` 的 `time`。
  - **工具调用**：`context.append_loop_event` 中 `event.type=tool.call` 的事件，名称取 `name`，前缀 `mcp__violetdagger__` 的是本系统工具。
  - **失败**：按 `toolCallId` 找到对应的 `tool.result`，`result.isError === true` 为失败，否则为成功；找不到对应 `tool.result` 时成败未知。
- **deleteOriginal**：
  - 删除会话目录。
  - 从 `session_index.jsonl` 中移除 `sessionId` 等于该会话的行，其他行原样保留：读取后写入同目录临时文件，再原子 rename 覆盖。
  - 已知限制：kimi 恰好在读取与 rename 之间追加的新行会丢失。删除只针对已结束的房间，此时这些 session 都已不在运行，但同一台机器上其他 kimi 进程的写入无法排除。

### 7.7 历史 session 补录

原生会话分析上线之前结束的 session 没有原生会话记录。一次性补录脚本为它们补做 locate → archive → analyze，用法：`npx tsx scripts/backfill-native-sessions.ts [--room <roomId>] [--dry-run]`（在 `packages/server` 下运行）。

- **对象**：`outcome` 不是 `running`/`stopping`、`native_session_id` 为空、且其 agent 的 registryKey 有适配器的 session；`--room` 只处理指定房间。已有原生会话记录的 session 跳过，所以脚本可以重复运行。
- **流程**：与 §7.2 结束后的流程相同，使用同一套适配器与同一副本目录 `<logsDir>/<roomId>/native/<seq>`。`preassignedId` 传 null，因此依赖预分配标识的适配器（claude）定位不到历史 session，会被跳过。
- **写入**：locate 成功时，经 `01-storage.md` 的 `setSessionNative` 写入原生会话标识、存储类型、原始位置、副本路径，以及 analyze 得到的用量。用量**整体覆盖**旧值（包括旧版从 stdout 提取的数值），使所有 session 的用量都来自原生会话、口径一致。locate 未找到，或 archive/analyze 失败时，不改动该 session，原有用量保留。
- **不做**：不改 outcome、时间、生命周期记录，不 emit 任何事件。运行中的服务端不受影响：前端下次拉取用量或报告时即可看到新值。
- **`--dry-run`**：照常 locate；文件型复制到系统临时目录下的一次性目录再 analyze，分析完立即删除（各适配器的 analyze 都按副本目录读取，不能直接读原件）；数据库型直接只读原库。不写入日志目录、不写库，打印将写入的数值。
- **输出**：每个 session 一行（房间、seq、agent、结果：已写入 / 未定位 / 失败及原因），最后打印汇总计数。
