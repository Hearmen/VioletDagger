# Agent 调用适配层设计

负责非交互式 CLI 的启动、实时只读日志、退出事实及人工终止。需求依据见 requirements.md 3.3；生命周期由 03 编排器核心结算。所有正式协作内容通过 MCP 写入，日志不解析成答案或 fact（**用量遥测是例外**：token/费用统计需要解析日志 JSON 才能拿到，但它只产出运营数字，不产出消息、不写入记忆、不参与 outcome 判定，跟"业务内容不从日志解析"防的是两件事，不冲突，见 §7）。交互式 PTY 模式属于下一版本，本版本不做设计。

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

结束说明：正式发现先通过 post_message 提交并等待成功；探索完成时调用 complete_exploring。**一次 session 不必只做一件事**——如果一项发现自然引出下一步具体可做的动作（例如发现问题后，修复方案明确且自己能实现验证），应在同一 session 内继续做完，用对应类型分别记录每一步，不要止步于第一条就结束、把本可以现在做完的事留给下一次派发。**但不得在同一 session 内对自己刚发出的消息做 endorse / verify**——这两类是声称"独立复核"的，自我复核没有价值，也会削弱多方独立复核的意义；`propose_completion` 不受此限，对自己刚完成的工作提议收尾是正常模式，真正的交叉核验仍然靠其他 agent 后续的 endorse/verify（或静默期无人反对，见 `03-orchestrator-core.md` §1.4）。确认没有更多增量时结束本次回答，由非交互式 CLI 自然退出；没有新增内容可以不发实质消息。不要等待终端输入。房间完成仍通过 propose_completion 提议，由人类决定。

### 2.1 Prompt 模板全文

`buildPromptText(roomId, agentId, overview)` 拼出的完整文本，只有六处随派发而变的动态插槽（`{{roomId}}`、`{{agentId}}`、`{{overview.goal}}`、`{{renderMemory(overview)}}`、`{{renderRecentRawMessages(...)}}`、`{{overview.guidance}}`），其余固定文本每次原样注入，不因 agent 或房间不同而改写一字——这是需求 3.3"每次 session 都从零开始，必须每次完整给出协议规则"的具体落地，代码（`packages/server/src/agent-invocation/prompt.ts`）必须和下面的模板逐字一致，改动先改这里。**@ 定向消息（需求 3.3.2）对 agent 完全不可见**：`dispatchScope` 是 `'broadcast'` 还是 `'directed'`（见 `03-orchestrator-core.md` §1.2）只用来决定这次 session 的产出要不要参与其他 agent 的派发判定，不会以任何形式注入 prompt——被 @ 的 agent 拿到的输入跟被广播派发时逐字节一致，它自己无法区分这次是不是"专门找我"。这条消息本身如果有 `targetAgentId`，仍然会像其它消息一样正常出现在 `renderMemory` 里（带 `@agentId` 标注，见 §2.2），只是不带任何"这是定向给你的"元提示。

```
你是这次协作聊天室会话的参与者。
roomId: {{roomId}}
authorId: {{agentId}}

## 协作规则

**可用工具**：
- post_message(roomId, authorId, content, type?, targetMessageId?, referencedMessageIds?, summary?)：像聊天室写入一条消息，可以是你的当前进展，也可以是其他任何你觉得对任务有帮助的内容。type 留空就是纯聊天，不进入任何记忆层。
- complete_exploring(roomId, authorId, messageId, resultSummary, resultMessageIds?)：把你自己当前 active 的 exploring 记录标记为完成。
- get_overview(roomId)：获取当前房间状态摘要——下面已经给你一份派发时刻的快照，如果你觉得需要更新的数据（比如怀疑其他 agent 在你这次会话开始后又有新动作），可以随时重新调用它刷新。
- get_detail(roomId, messageId | { type } | { list: true, type?, targetMessageId?, beforeId?, limit? })：按需深挖某条或某类记忆的完整内容，list:true 时分页浏览全部历史（含普通聊天）。

**记忆类型**：fact（已确认事实）/ hypothesis（针对某个 open_question 的候选答案）/ boundary（已确认走不通的死胡同）/ open_question（提出的开放问题，可选 targetMessageId 表示追问某条消息）/ chain（一条候选端到端方案，可多条并存，没有系统裁定的"最优"）/ exploring（你正在探索的方向广播，见下）/ propose_completion（你认为任务可以结束了）/ endorse、challenge、verify（对某条消息的赞同/质疑/验证，targetMessageId 必填）。所有类型一旦发出，type 和 content 永不改写——只追加，不覆盖。

**exploring 的规则**：你同时只能有一条 active 的 exploring；发新的 exploring 会自动把你自己之前那条 active 的标记为 completed；探索完一个方向但还没想好下一步时，调用 complete_exploring 显式标记完成。

**人类消息权重**：房间里 authorId 为 "human" 的消息，请更重视其判断——但不代表系统会强制覆盖你的看法，只是提醒你认知上多加权重。

**结束本次会话**：你这次是一次性非交互调用，没有人类终端可以应答。所有的发现先通过 post_message 提交并等待成功；探索完成时调用 complete_exploring；不要等待终端输入。**一次 session 不限于只做一件事**：如果一项发现自然引出了下一步具体可做的动作，应该在本次会话内继续做下去，用合适的类型分别记录每一步，而不是止步于第一条就结束。**但不要在本次会话里对自己刚发出的消息做 endorse/verify**——这两类是声称"独立复核"的，自己给自己复核没有价值；如果你刚完成的工作已经足够，可以照常发 propose_completion 提议收尾，这不算自我背书。确认没有更多可做的增量后再结束，由系统在进程自然退出后记录本次 session；什么都不调用直接结束是允许的，不会被视为异常，只是这次没有新内容。

**接续历史**：hypothesis 必须用 targetMessageId 指向 open_question；fact 可选回答问题。所有有类型消息都可以 referencedMessageIds 引用依据。先读取已有回答及注解；再次验证或质疑说明新增条件、证据或疑点。已有方案适用时直接引用，只有新路径或实质变化才发 chain，并说明变化。无增量可以结束。探索结束须记录结果摘要，无结论也如实记录。get_detail({roomId, list:true, type?, targetMessageId?, beforeId?, limit?}) 可分页浏览全部历史，包括普通聊天。人类约束优先查看原始消息，记忆摘要省略作者不改变其权重。

## 当前房间状态（派发时刻的快照，来自 buildOverview(roomId)）

任务目标：{{overview.goal}}

{{renderMemory(overview)}}

最近的原始消息：
{{renderRecentRawMessages(overview.recentRawMessages)}}

{{overview.guidance}}

## 下一步

请基于以上信息决定接下来可以做的事，做完一件、发现有新的具体动作时继续做下一件，直到确认没有更多增量再停下；任何你觉得对达成任务有帮助的信息都可以通过 post_message 分别记录；需要最新的记忆数据可以重新调用 get_overview(roomId)。
```

### 2.2 `renderMemory(overview)` 渲染格式

把 `OverviewPayload`（`02-memory-management.md` §3）十个分组按固定顺序、固定标题渲染成文本（分组本身的取数规则见 02，这里只定义"渲染成什么文字"）：

`已确认事实`（facts）→ `死胡同`（boundaries）→ `待解决问题`（openQuestions）→ `候选假设`（hypotheses）→ `候选方案`（chains）→ `正在探索的方向`（activeExploring）→ `已结束探索`（completedExploring）→ `完成提议`（completionProposals）→ `关联上下文`（contextMessages）→ `其余反应记录`（reactions）。每组标题后跟一个冒号和换行，组内为空显示"（无）"。

组内每条消息渲染成一行：

```
- [#id] {type ?? '上下文'}{ → #targetMessageId}{ @targetAgentId}{ [exploringStatus]}{ 占用：agentId}：{summary}{ 依据：#ref1 #ref2 …}
```

`{ @targetAgentId}` 段：`targetAgentId` 非空时渲染为形如 `@codex-1` 的标注（只有人类消息可能非空，见需求 3.3.2），让其他 agent 在读 `renderMemory` 时也能看出某条消息是定向发给谁的。

`exploringStatus === 'completed'` 时额外追加一行"结束：{exploringEndReason ?? '结束原因未记录'}；{exploringResultSummary ?? '未记录结果'}{；exploringNote}；结果引用：#id …"；`relations[id].answerIds`/`referencedByIds` 非空时各追加一行"已有回答：#id …"/"被引用：#id …"。

该消息下 `relations[id].annotationIds` 里，`type` 属于 `endorse`/`challenge`/`verify` 的，缩进展开成子行"- [#id] {type} → #{targetId}：{summary}；依据：#ref …"，并再展开这条注解自身的 `annotationIds`/`referencedByIds`（只展开这一层，不递归）；不属于这三种类型的注解只显示"注解索引：#id"。**每条消息全局只渲染一次**（跨分组用同一个 `rendered` 集合去重，比如一条消息既是某个问题的 `hypothesis` 又被列进 `contextMessages` 时，只在先出现的分组里展开一次，后面只留索引意义上的引用，不重复贴全文）。

### 2.3 `renderRecentRawMessages` 渲染格式

`overview.recentRawMessages` 为空显示"（无）"；否则逐条渲染成 `- [{authorId}] {content}`，按 `OverviewPayload.recentRawMessages` 原有顺序（`02-memory-management.md` §3：最近 4 条，`VIOLETDAGGER_RECENT_RAW_MESSAGES` 可配置），不重新排序。

### 2.4 Prompt 落盘

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
  usage?: SessionUsage; // 见 §7；spawn-failed/not-started 没有日志可读，不带这个字段
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

## 7. 用量统计（token / 费用）解析

确认进程退出、日志文件已完整落盘之后（第 6 节报告 `SessionExitEvent` 之前），按这次 session 的 `registryKey` 读取完整 `rawLogPath` 文件，分发到对应的提取函数，得到 `SessionUsage`（见 `01-storage.md`）：

| registryKey | 提取方式 | 拿到什么 |
|---|---|---|
| `claude` | 找 `type == "result"` 事件（`-p` 单次调用只有一条，防御性地对多条求和） | `usage.input_tokens` / `usage.output_tokens` / `usage.cache_creation_input_tokens` / `usage.cache_read_input_tokens`，`total_cost_usd` |
| `opencode` | 累加所有 `type == "step_finish"` 事件 | 各自 `part.tokens.{input,output,cache.read,cache.write}` 和 `part.cost` 求和 |
| `codex` | 找 `type == "turn.completed"` 事件（同样对多条求和） | `usage.{input_tokens,output_tokens,cached_input_tokens,cache_write_input_tokens}`；**没有费用字段，`costUsd` 恒为 null** |
| `kimi` | 无对应事件 | 全部字段恒为 null |
| 其他/未来新增的 registryKey | 无对应提取器 | 全部字段恒为 null，不报错 |

提取失败（JSON 解析异常、字段缺失）按该字段取 null 处理，不抛错、不影响 outcome 结算——用量数据从来不是"结果判定"的一部分，解析器内部的 try/catch 只降级为 null，绝不让这一步的异常波及 `SessionExitEvent` 的其余部分。**不做任何费用估算**：codex 只有 token 数据、没有美元费用字段，`costUsd` 就是 null，不用硬编码定价表去猜——定价会变，猜错比没有更误导人。

新增 registryKey 时默认没有提取器（全 null），要支持用量统计需要显式给它加一条上表的规则，不会因为漏配置而报错或显示假数据。

## 记忆连续性修订（2026-09-19）

按 02 §3 完整渲染摘要、关系、反应、历史探索与完成提议，不展示摘要作者（active 占用 agentId 例外）。默认 128 KiB UTF-8 prompt 上限，VIOLETDAGGER_MAX_PROMPT_BYTES 配置；超限明确报错、暂停房间并结算未启动 session，不 spawn、不截断。协作协议要求先查看已有回答与注解，再次验证/质疑说明新增条件或证据；chain 引用旧方案并说明实质变化，局部发现用对应类型，不要求每轮综合；没有增量可结束。人类原始消息仍按既有协议加权。

## 单 session 多步骤修订（2026-09-21）

实测发现（room 7）：绝大多数 session（54 次里 21 次零消息、21 次仅 1 条消息，只有 12 次发了 2~3 条）在做完一件事后就主动结束，即便调查过程本身已经自然引出了下一步具体动作（例如发现文件冲突的 challenge 之后，没有在同一 session 内顺手把修复也做掉），导致本可一次性做完的"发现→修复"链条被拆成多次独立派发，每次都要重新起进程、重新全量重放 overview。原因是旧版结束说明只给了"完成即可停"的许可，没有对称地鼓励"有后续具体动作就继续做"。上面这版结束说明改为：鼓励在同一 session 内把自然引出的后续动作做完，但明确禁止在同一 session 内对自己刚发的消息做 endorse/verify（避免把"继续做"异化成自我背书、削弱多方独立复核的价值）；`propose_completion` 不受此限。`prompt.ts` 对应文案同步修改，不改变工具集或消息类型定义。

## 用量统计修订（2026-09-21）

新增 §7：确认进程退出、日志文件完整落盘之后解析 token/费用用量，按 registryKey 分发到不同的提取规则（claude/opencode 有费用，codex 只有 token，kimi 什么遥测都不提供），`SessionExitEvent` 新增可选 `usage` 字段。这是"日志不解析成答案或 fact"这条既有原则下的一个明确例外——解析的是运营遥测，不产出消息、不参与 outcome 判定；解析失败或某个 agent 不提供某个字段一律取 null，不猜、不用硬编码定价表估算缺失的费用。

## @ 定向消息修订（2026-09-22）

`startSession`/`buildPromptText` 签名不变——`dispatchScope`（`'broadcast'` | `'directed'`，见 `03-orchestrator-core.md` §1.2）只在核心内部用于 `createSession` 落盘和后续的派发排除判定，不透传给 agent 调用层，agent 拿到的 prompt 在定向和广播两种派发下逐字节一致（需求 3.3.2 明确要求"对 agent 来说定向和群发没有任何区别"）。`renderMemory` 的行内格式新增 `{ @targetAgentId}` 标注（见 §2.2）——这只是把消息自身携带的 `targetAgentId` 数据照常渲染出来，跟 `targetMessageId`/`referencedMessageIds` 一样是消息内容的一部分，不是"这次 session 是定向派发"的元提示。
