# 编排器核心设计

负责消息写入的业务规则（校验、知识状态转换）、事件驱动派发、session 生命周期状态机、房间生命周期控制。不直接 spawn 进程（那是 `04-agent-invocation.md` 的职责），核心只做"一条消息能不能写、写入后哪些消息的状态要变""该不该起一个新 session、该给哪个 agent"，以及"session 结束后状态该怎么迁移"。

## 1. 消息写入与事件驱动派发

### 1.1 触发型消息（需求 3.3）

一条消息是否"触发型"，按它**写入时刻**的 type 与状态判定：

| 写入时刻的 type / 状态 | 触发型 |
|---|---|
| `open_question` 且 `questionStatus === 'OPEN'` | 是 |
| `hypothesis` | 是 |
| `chain` 且 `chainStatus === 'CANDIDATE'` | 是 |
| `challenge` | 是（没有状态，写入即触发一次派发） |
| `fact`、`boundary`、`CLOSED` 的 `open_question`、`VERIFIED`/`CHALLENGED`/`REJECT` 的 `chain`、`verify`、`exploring`、`propose_completion`、无 type 消息、系统占位 | 否 |

另有两条规则，优先于上表：

- **定向 session 的产出**：归属 `dispatch_scope === 'directed'` 的 session 的消息不置位任何标记（需求 3.3.2），但照常进入消息流、记忆和事件树，其中的 verify/challenge 照常转换目标状态。
- **定向消息**：`targetAgentId` 非空的触发型人类消息只置位该 agent 的定向标记，不置位房间标记。

人类消息与 agent 消息使用同一套判定，没有特权。判定只在写入时做一次，结果体现为标记置位（§1.2），核心不在内存里维护触发集合。

判定只看写入时刻：一条消息写入后被 verify、被 challenge 等状态变化，都不会重新置位或清除标记。fact 被 challenge 转回 hypothesis 时，置位标记的是那条 challenge 自身，不是这条 hypothesis。

### 1.2 待分发标记与 `checkAndDispatch(roomId)`

**标记**（需求 3.3）：房间标记 `room.dispatchPending` 及标记作者 `room.pendingAuthorId`，每个 agent 的定向标记 `agent.directedPending`，都持久化在存储层（`01-storage.md` §1）。

**置位**：

1. `submitMessage`（§1.4）写入的消息在写入时刻属于触发型（§1.1），且不属于 `directed` session：`targetAgentId` 为空时 `setDispatchPending(roomId, true, authorId)`；非空时 `setDirectedPending(roomId, targetAgentId, true)`。与消息插入在同一事务内完成。
2. `onSessionEnded` 结算为 `error`（§2）：`dispatchScope === 'broadcast'` 时 `setDispatchPending(roomId, true, agentId)`；`'directed'` 时 `setDirectedPending(roomId, agentId, true)`。

**检查时机**：以下情况各调用一次 `checkAndDispatch`：

1. `submitMessage` 置位了标记（§1.4 第 7 步）。
2. 某个 session 结算完成、agent 变回空闲（§2、§3）。
3. `resumeRoom`（§4）。
4. `setAgentEnabled` 启用 agent（§6）。

`checkAndDispatch` 是一个**纯同步函数**（内部只有 SQLite 同步读写，没有 `await`）：

1. 读 room；若 `status !== 'active'`，直接返回。
2. 读 `getRoomAgents(roomId)`。若 `room.dispatchPending` 为 false，且没有 `dispatchEnabled && directedPending` 的 agent，直接返回：不扫描，不推送。
3. **定向阶段**：按 `joinOrder` 顺序，对每个 `dispatchEnabled`、`idle`、`directedPending` 的 agent，执行"派发"（见下），`scope = 'directed'`，并 `setDirectedPending(roomId, agentId, false)`。
4. **房间阶段**（仅当 `room.dispatchPending` 为 true）：按 `joinOrder` 顺序扫描：
   - `dispatchEnabled === false`：跳过（§6）。
   - 忙碌（`running`/`stopping`，包括第 3 步刚派发的）且当前带 active `exploring`：内存 `stuckCount + 1`（§5），继续。
   - 忙碌但没有 active `exploring`：跳过。
   - `idle` 但 `directedPending`（只可能在第 3 步因上限中断时出现）：跳过。
   - `idle` 且 `agentId === room.pendingAuthorId`：记为 `fallback`，继续。
   - 其他 `idle` agent：记为 `dispatchTarget`，停止扫描。

   没有 `dispatchTarget` 时取 `fallback`。选出后执行"派发"，`scope = 'broadcast'`，并 `setDispatchPending(roomId, false)`；选不出则保留标记。
5. `emit('roomStatus')`：派发了 session、改了 `stuckCount` 或触及上限，都需要推送。

**派发**（第 3、4 步共用）：

1. 若 `countSessions(roomId) >= room.maxSessions`：把 room 置为 `paused_limit`，`emit('roomStatus')`，结束本次 `checkAndDispatch`，尚未处理的标记保持原样。
2. `createSession(roomId, agentId, scope)` + `setAgentState(roomId, agentId, 'running', seq)`，并清除对应标记，与扫描在同一个同步调用栈内完成。
3. 调用 `agentInvocation.startSession({ roomId, seq, agentId, registryKey })`（fire-and-forget）。`scope` **不传给** `startSession`（§1.5）。必须用 try/catch 包住这次调用：返回的 Promise 已用 `.catch` 兜住，但同步阶段也可能抛错（如建目录失败），而 `checkAndDispatch` 会被进程退出等回调直接调用，同步抛出会变成未捕获异常——任何同步抛出都降级为"记录日志、这次派发失败"。

**停止**：房间标记与所有启用 agent 的定向标记都为 false 时，`checkAndDispatch` 在第 2 步直接返回，派发自然停止。

**不需要显式加锁/互斥**：`better-sqlite3` 是同步 API，Node.js 单线程执行模型保证"读标记 → 扫描 agent → 写 session/state/标记"这段代码不会被另一次 `checkAndDispatch` 打断。两个触发事件即使"同时"发生，也会被事件循环序列化为先后两次独立调用，第二次调用一定能看到第一次已经提交的状态。

### 1.3 知识状态转换（需求 4.5）

新消息 M 写入后，在同一事务内按下表转换其目标 T 及相关问题 Q 的状态。每一步都通过存储层的 `setMessageType`/`setChainStatus`/`setQuestionStatus` 完成，自动追加 `state_transition_log`，`triggerMessageId` 为 M。Scheduler 不解析消息正文，不做语义判断。

| M | T 的当前状态 | T 的转换 | 问题 Q 的联动 |
|---|---|---|---|
| `verify(true)` | `hypothesis` | type → `fact` | 无 |
| `verify(false)` | `hypothesis` | type → `boundary` | 无 |
| `verify(true)` | `chain` `CANDIDATE`/`CHALLENGED` | → `VERIFIED` | 若 `T.closesQuestion` 且 Q（T 的目标问题）为 `OPEN`：Q → `CLOSED`，关闭原因为 `T.chainResolution`，`closedBy = T.id`。Q 已 `CLOSED` 时不变 |
| `verify(false)` | `chain` `CANDIDATE`/`CHALLENGED` | → `REJECT` | 无（Q 保持原状态） |
| `challenge` | `fact` / `boundary` | type → `hypothesis` | 若 T 带 `targetMessageId` 指向问题 Q，且 Q 为 `CLOSED`：Q → `OPEN`（清空关闭原因与 `closedBy`） |
| `challenge` | `chain` `CANDIDATE`/`VERIFIED`/`REJECT` | → `CHALLENGED` | 若 Q 为 `CLOSED` 且 `Q.questionClosedBy === T.id`：Q → `OPEN` |

说明：

- 只有 `VERIFIED` 的 chain 能关闭问题；`CANDIDATE`、`CHALLENGED`、`REJECT` 的 chain 都不影响问题状态。
- 一个问题被某条 chain 关闭后，另一条 `closesQuestion` 的 chain 再被验证通过时不重复关闭，也不覆盖关闭原因。
- chain 被 challenge 时只重开由它自己关闭的问题；fact/boundary 被 challenge 时，按需求 4.5，只要它回答的问题处于关闭状态就重开。
- 转换发生后，被转换的每条消息 id 都收集进 `changedMessageIds`，由 `submitMessage` 逐条 emit `memoryUpdate`。

### 1.4 `submitMessage`：统一写入入口

MCP Server 的 `post_message`（`05-mcp-server.md`）和编排器对外接口的 `postHumanMessage`（`06-orchestrator-api.md`）都只调用这一个函数，不直接调用 `storage.insertMessage`。核心自己写的系统占位消息（§2）不走这里，直接调用 `insertMessage`。

```typescript
type MessageAuthor =
  | { kind: 'agent'; agentId: string; sessionSeq: number } // sessionSeq 由 MCP Server 从固定凭据取得
  | { kind: 'human' };

interface SubmitMessageInput {
  roomId: number;
  author: MessageAuthor;
  content: string;
  type?: MessageType;
  targetMessageId?: number;
  referencedMessageIds?: number[];
  verifyVerdict?: boolean;
  closesQuestion?: boolean;
  chainResolution?: 'RESOLVED' | 'UNRESOLVED';
  summary?: string;
  targetAgentId?: string; // 只有 author.kind === 'human' 时可提供
}

class SubmitMessageError extends Error {} // 校验失败；调用方把 message 原样作为业务错误返回

function submitMessage(input: SubmitMessageInput): { message: Message; changedMessageIds: number[] };
```

执行步骤（1–4 在 `storage.runInTransaction` 内，任一步抛错整体回滚）：

1. **首条消息规则**：`author.kind === 'human'` 且 `countMessages(roomId) === 0` 时，把 `type` 强制设为 `open_question`（不论传入什么，需求 3.1）；此时若提供了 `targetAgentId` 则拒绝（首条消息定向会让房间只剩一个 agent 被派发，而它的产出又全部不触发调度，房间无法推进）。
2. **校验**（下文"写入校验"），失败抛 `SubmitMessageError`。
3. `storage.insertMessage(...)`：`authorId` 为 `'human'` 或 `author.agentId`，`sessionSeq` 为 `null` 或 `author.sessionSeq`。
4. 按 §1.3 执行状态转换，得到 `changedMessageIds`。
4a. 按 §1.2"置位"第 1 条置位标记。
5. 事务提交后：`emit('message', { roomId, message })`；对每个 `changedMessageIds` emit `memoryUpdate`。
6. 若新消息是 `exploring`：`resetStuckCount(roomId, authorId)`（该 agent 的 active exploring 发生了变化，§5）。
7. 若第 4a 步置位了标记：`checkAndDispatch(roomId)`。
8. 返回 `{ message, changedMessageIds }`。

**写入校验**（需求 4.2/4.3；`T` 指 `getMessageById(roomId, targetMessageId)`，不存在即拒绝）：

| type | targetMessageId | 其他字段 |
|---|---|---|
| 无 type | 不允许 | 不允许任何关系/状态字段 |
| `open_question` | 不允许 | — |
| `hypothesis` | 必填，T 为 `open_question` | — |
| `fact` / `boundary` | 可选，提供时 T 为 `open_question` | — |
| `chain` | 必填，T 为 `open_question` | `closesQuestion` 可选；为 true 时 `chainResolution` 必填，否则不允许 `chainResolution` |
| `exploring` | 必填，T 的当前 type 为 `open_question` 或 `hypothesis` | 只允许 agent 作者，`author.kind === 'human'` 时拒绝（需求 3.5）；同一作者已有 active exploring 时拒绝（`getActiveExploringByAuthor`，需求 4.6） |
| `propose_completion` | 不允许 | — |
| `challenge` | 必填，T 为 `fact`/`boundary`，或状态为 `CANDIDATE`/`VERIFIED`/`REJECT` 的 `chain` | — |
| `verify` | 必填，T 为 `hypothesis`，或状态为 `CANDIDATE`/`CHALLENGED` 的 `chain` | `verifyVerdict` 必填；agent 作者时 `T.sessionSeq !== author.sessionSeq`（同一 session 不能 verify 本 session 的产出；同一 agent 的后续 session 可以；人类不受限） |

通用规则：

- `verifyVerdict` 只允许 `verify` 提供；`closesQuestion`/`chainResolution` 只允许 `chain` 提供。
- `referencedMessageIds` 只允许有 type 的消息提供；每个 id 必须为正整数且 `getMessageById` 能查到，去重后写入。
- `targetAgentId` 只允许人类提供，且必须是 `getRoomAgents(roomId)` 中存在的实例标识。
- 状态约束按目标的**当前**状态校验。两次写入即使"同时"到达也会被事件循环序列化，后到的那次在事务内读到的已是新状态，按新状态重新校验，因此同一状态上不会出现两个相互矛盾的 verify（需求 4.5）。
- 未知 type、字段类型错误一律拒绝。
- 人类与 agent 使用同一张校验表，没有放宽或收紧，唯一差异是两处按作者区分的规则：exploring 仅限 agent；同 session 不能 verify 仅约束 agent（需求 3.5）。

### 1.5 派发的 agent 拿到什么

`agentInvocation.startSession` 传 `roomId`/`seq`/`agentId`（实例标识）/`registryKey`（查注册表配置用）。按需求 3.3，被派发的 agent 拿到两部分输入：

1. **房间协议说明**——固定的规则性内容（消息类型含义、写入约束、知识状态转换、`exploring` 规则、调度触发条件、人类消息权重、可用工具等），每次完整给出，直接写死在 prompt 模板里（`04-agent-invocation.md` §2）。
2. **当前房间状态**——`startSession` 内部调用记忆管理层的 `buildOverview(roomId)`（`02-memory-management.md` §3），预渲染进 prompt。这是派发那一刻的快照；之后 agent 可以随时调用 MCP 的 `get_overview` 刷新，两处共用同一个 `buildOverview`。

两者一起构成这次 session 的完整输入，**跟 `dispatchScope` 无关**——广播和定向派发拿到的 prompt 逐字节一致（需求 3.3.2）。`dispatchScope` 只是记在 session 上的元数据，用于 §1.1 排除定向 session 的产出，以及 §2 失败时恢复对应的标记，不会以任何形式传给 `startSession`/`buildPromptText`。

### 1.6 派发空闲判定 `isDispatchIdle(roomId)`

供 `getRoomStatus` 计算无任务派发提醒（需求 3.1）。只读，不改变任何状态。以下条件全部满足时返回 true：

1. `room.status === 'active'`；
2. `countMessages(roomId) > 0`，空房间由 Composer 的首条消息提示负责；
3. 没有 agent 处于 `running`/`stopping`；
4. 没有 `dispatchEnabled && directedPending` 的 agent，并且 `room.dispatchPending` 为 false 或没有任何 `dispatchEnabled` 的 agent。停用的 agent 不参与判定。

这个值的变化总是伴随着已有的 `roomStatus` 推送（session 结算、`checkAndDispatch` 找不到派发目标、`setAgentEnabled`、房间状态变更），不需要新增事件。

## 2. 自然结束与最终结算

非交互 CLI 完成一次工作后自行退出，不调用完成工具，也不等待终端输入。`onSessionEnded(event: SessionExitEvent)` 接收 04 定义的进程事实；所有结算经过同一幂等入口。

| 情况 | session.outcome | 补写系统占位消息？ |
|---|---|---|
| 自然零退出，本 session 发出过至少一条带 type 的消息（包括只发了 `verify`） | completed | 否——已有消息自然留痕 |
| 自然零退出，本 session 没有发出带 type 的消息（没发消息，或只发了无 type 聊天） | passed | 是 |
| 异常退出、信号退出或启动失败，未进入人工终止流程 | error | 是 |
| stopIntent=terminate，已确认主进程退出或从未启动 | terminated | 是 |

"本 session 的消息"用 `getMessagesBySession(roomId, seq)` 判定。

没有自动运行时长/无输出超时；卡住时人类可暂停房间、查看日志并终止。MCP 消息可在调用期间持续产生，CLI stdout/stderr 不参与结果判定、不转为 fact——用量统计是唯一从日志内容提取并落盘的数据（`04-agent-invocation.md` §7），它不影响这张结算表，只随 `finishSession` 多写几列数字。正常结束不自动完成 active exploring，不结束 room。

只处理 running/stopping。事务内写 outcome、endedAt、退出元数据、用量统计（`event.usage`）及 process_exited，且仅在 currentSessionSeq 等于本 seq 时释放 agent。撤销凭据；outcome 为 error 时按 §1.2"置位"第 2 条恢复标记（与结算同一事务）；更新连续失败计数（§6）；emit `roomStatus` 并执行一次 `checkAndDispatch`。outcome 为 completed 之外的结果时（passed/error/terminated），额外用 `storage.insertMessage` 写一条无 type 的系统占位消息（`authorId` 为该 session 的 agentId、`sessionSeq` 为本次 seq），并 emit `message`——内容按结果分别说明"未发出任何带类型的消息"（passed）、报错原因（error）、"人工终止"（terminated）。事件树（`07-frontend.md` §9）靠这条消息本身留痕，不需要单独的 session 节点。

## 3. `terminateAgentSession(roomId, seq)`

```typescript
function onSessionExitProgress(roomId: number, seq: number,
  kind: 'cleanup_started' | 'sigterm_sent' | 'sigkill_sent' | 'cleanup_failed',
  detail?: string, cleanupAttemptId?: string): void;
```

1. 不存在或已终态则幂等返回。同步事务将 stopIntent 设为 terminate，session/agent 置 `stopping`，记录 terminate_requested；不提前写 terminated。撤销 MCP 写权限并保留 agent 占位。
2. 调用 `stopSessionProcess`；并发请求共用同一清理任务。先 SIGTERM，默认宽限 2 秒；仍未退出则 SIGKILL，默认再等待 3 秒确认。
3. 确认主进程退出或从未启动后，在第 2 节统一结算 terminated、把 agent 设回 `idle` 并释放占位；同时对该 agent 的 active exploring 调用 `storage.completeExploring(roomId, id, { reason: 'human_terminated', note: '人类强制终止' })`，`resetStuckCount` 并 emit `memoryUpdate`。
4. 无法确认退出则保持 `stopping` 与占位，记录 cleanup_failed，RPC 返回明确错误。人类可显式重试，自动退出监听保留。
5. 最终释放后只检查派发一次；terminate 不暂停 room，需停止后续工作时先 `pauseRoom`。

stopping 只用于人工终止过程，不是正常完成的必经状态。所有清理事件由核心落盘并推送 roomStatus，不进入协作消息或记忆。终态不被迟到回调覆盖。

## 4. 房间生命周期控制

```typescript
function pauseRoom(roomId: number): void;
// setRoomStatus(roomId, 'paused_manual') + emit('roomStatus')，不影响进行中的 session，只是不再新起

function resumeRoom(roomId: number, additionalSessions?: number): void;
// 若当前 status === 'paused_limit'：additionalSessions 必填（否则报错），
//   increaseMaxSessions(roomId, additionalSessions) 后 setRoomStatus(roomId, 'active')，
//   emit('roomStatus')，再调用 checkAndDispatch(roomId)
// 若当前 status === 'paused_manual'：additionalSessions 可省略，直接 setRoomStatus(roomId, 'active') + emit('roomStatus') + checkAndDispatch(roomId)

function confirmCompletion(roomId: number): void;
// setRoomStatus(roomId, 'completed') + emit('roomStatus')。不终止仍在跑的 session（它们跑完后正常写入结果，
// 只是不会再触发新的派发——checkAndDispatch 第一步就会因 status !== 'active' 直接返回）。
// 房间只能由人类通过本函数结束，系统不自动结束房间（需求 3.3.1）

async function deleteRoom(roomId: number): Promise<void>;
// 只允许 status === 'completed'，否则抛错（错误由 06-orchestrator-api.md 的 DELETE /api/rooms/:id 转成 HTTP 4xx）。
// confirmCompletion 不终止仍 running 的 session，所以 completed room 可能还挂着 running/stopping session，删前必须收尾：
//   1. 对每个 state === 'running' || state === 'stopping' 的 agent，await terminateAgentSession(roomId, sessionSeq)（必须确认退出；任一清理失败则中止删除并返回错误，保留记录与占位供重试）；
//      terminateAgentSession 内部结尾的 checkAndDispatch 会因 status !== 'active' 立即返回，不会派发新 session。
//   2. await agentInvocation.deleteRoomArtifacts(roomId)（删 <logsDir>/<roomId>/ 与 prompts/violetdagger-<roomId>-*）。
//   3. storage.deleteRoom(roomId)（级联删 DB）。
//   4. emit('roomDeleted')；不再 emit roomStatus（room 已不存在）。
```

## 5. "卡住提醒"计数（需求 4.6 / 3.1）

计数只发生在 `checkAndDispatch` 的房间阶段扫描中（§1.2 第 4 步），也就是只在房间标记为 true 的检查里：扫描沿途每遇到一个 `running`/`stopping` 且当前带 active `exploring` 的 agent，就给它的内存计数 `stuckCount + 1`，直到选出 `dispatchTarget` 为止（派给它，扫描停止，排在它后面的 agent 这一次不会被计数）。标记为 false 的检查不扫描，不计数。计数器不落盘，进程重启后归零，属于 UI 提示性质。

**清零时机**：该 agent 的 active `exploring` 状态发生变化时归零，统一调用 `resetStuckCount(roomId, agentId)`：

- `submitMessage` 写入一条新的 `exploring`（§1.4 第 6 步）。
- `complete_exploring` 成功（`05-mcp-server.md` §5 调用）。
- `terminateAgentSession` 强制完成 exploring（§3 第 3 步）。

**展示**：`stuckCount >= N` 且该 agent 当前有 active `exploring` 时，`getRoomStatus` 里对应 agent 标记"疑似卡住"，前端展示提醒，不自动处理；没有 active `exploring` 时不展示（无论计数是多少）。默认 `N = 3`，可通过服务端配置调整（需求第 9 节）。

只要一次 session 还在跑、还是同一条 exploring，房间里每有一次房间阶段扫描经过它就计一次；跑得越久、房间里其他 agent 越活跃，累积得越快。

**已知限制**：房间里只有一个 agent 时，扫描不会反复经过它，计数很难累积，这套机制基本不起作用，人类靠 `getRoomStatus` 的"已运行 X 秒"自己判断（需求 4.6）。不额外设计备用机制。

## 6. 连续失败与派发停用（需求 3.4）

每个 agent 一个**内存** `failureCount`（roomId+agentId，重启归零，与 `stuckCount` 同类，不落盘）：

- **结算更新**：`onSessionEnded` 结算为 `error` 时 `failureCount + 1`；结算为其他终态（`completed`/`passed`/`terminated`）时清零。
- **自动停用**：`failureCount` 达到阈值（默认 3，服务端配置可调）时，调用 `storage.setAgentEnabled(roomId, agentId, false)`，清零计数，`emit('roomStatus')`。停用状态持久化在 `room_agents.dispatch_enabled`，重启后仍生效。停用发生在 §2 恢复标记之后：被停用 agent 的 broadcast session 失败所恢复的房间标记，会在紧接着的 `checkAndDispatch` 里派给其他 agent。
- **派发跳过**：`checkAndDispatch` 扫描时跳过 `dispatchEnabled === false` 的 agent（§1.2 第 3、4 步），继续看后面的；停用不终止正在运行的 session。它的定向标记保留，要等人类重新启用后才会被派发。
- **人工启停**：`setAgentEnabled(roomId, agentId, enabled)` 是人类显式操作。启用时清零 `failureCount`、`emit('roomStatus')` 并调用一次 `checkAndDispatch`；停用只 `emit('roomStatus')`。系统不自动恢复。
- **展示**：`getRoomStatus` 暴露每个 agent 的 `enabled` 与 `failureCount`，前端展示"连续失败，已停用派发"并提供启用/停用控件（`07-frontend.md` §5）。

这条机制避免"配额/凭据失效等持续失败"时在短时间内烧完 `maxSessions` 配额。

## 7. 对外接口（供 MCP Server / 编排器对外接口调用）

```typescript
function submitMessage(input: SubmitMessageInput): { message: Message; changedMessageIds: number[] }; // §1.4
function onSessionEnded(event: SessionExitEvent): void; // 结构见 04-agent-invocation.md
function onSessionExitProgress(roomId: number, seq: number, kind: ..., detail?: string, cleanupAttemptId?: string): void; // §3
// 所有接口里的 agentId 都是 agent 实例标识（见 00-overview.md），不是注册表 key
function pauseRoom(roomId: number): void;
function resumeRoom(roomId: number, additionalSessions?: number): void;
function confirmCompletion(roomId: number): void;
function deleteRoom(roomId: number): Promise<void>;
function terminateAgentSession(roomId: number, seq: number): Promise<void>;
function getStuckAgents(roomId: number): { agentId: string; stuckCount: number }[];
function resetStuckCount(roomId: number, agentId: string): void;
function getAgentFailures(roomId: number): { agentId: string; failureCount: number }[];
function setAgentEnabled(roomId: number, agentId: string, enabled: boolean): void;
function isDispatchIdle(roomId: number): boolean; // §1.6
```

## 8. 对外依赖

```typescript
// 存储层（见 01-storage.md）
getRoom, setRoomStatus, increaseMaxSessions, deleteRoom,
getRoomAgents, setAgentState, setAgentEnabled, setDispatchPending, setDirectedPending,
createSession, finishSession, markSessionTerminating, appendSessionEvent, getSession,
countSessions,
runInTransaction, insertMessage, getMessageById, countMessages, getMessagesBySession,
getActiveExploring, getActiveExploringByAuthor, completeExploring,
setMessageType, setQuestionStatus, setChainStatus

// Agent 调用适配层（见 04-agent-invocation.md）
startSession, stopSessionProcess, deleteRoomArtifacts

// MCP Server 身份管理（见 05-mcp-server.md §1，由组装根注入）
revokeSessionCredential

// 共享事件总线（见 00-overview.md）
roomEvents.emit('message' | 'memoryUpdate' | 'roomStatus' | 'roomDeleted', payload)
```
