# 编排器核心设计

负责事件驱动派发、session 生命周期状态机、房间生命周期控制。不直接 spawn 进程（那是 `04-agent-invocation.md` 的职责），核心只做"决定该不该起一个新 session、该给哪个 agent"，以及"session 结束后状态该怎么迁移"。

## 1. 事件驱动派发

### 1.1 触发源（对应需求 3.3）

- **`onSubstantiveMessagePosted(roomId)`**：由 MCP Server 的 `post_message` handler（agent 消息，且 `type` 非空时才调用）和编排器对外接口的 `postHumanMessage` handler（人类消息一律调用）在消息成功写入存储后调用。
- **`onSessionEnded(event)`**：由 Agent 调用适配层在一次 session 的进程结果确定后调用（见 `04-agent-invocation.md`），结合进程事实、清理归因和终止意图结算（第 2 节），确认结束后触发一次 `checkAndDispatch`。

两者都只是"触发一次检查"，不携带需要特殊处理的语义差异——检查逻辑统一走 `checkAndDispatch`。

### 1.2 `checkAndDispatch(roomId)` 与并发正确性

这是一个**纯同步函数**（内部只有 SQLite 同步读写，没有 `await`）：

1. 读 room；若 `status !== 'active'`，直接返回。
2. 若 `countSessions(roomId) >= room.maxSessions`，把 room 置为 `paused_limit`，`roomEvents.emit('roomStatus', { roomId })`，返回（不派发）。`countSessions` 只计 `outcome != 'error'` 的 session（error 不占配额，见 `01-storage.md`）。
3. 按 `joinOrder` 顺序扫描 `getRoomAgents(roomId)`（每个元素是含 `agentId`/`registryKey` 的 `RoomAgentState`，见 `01-storage.md`）：
   - `dispatchEnabled === false` 的 agent：跳过（继续扫描后面的，见第 6 节）。
   - 遇到忙碌状态（`running` 或 `stopping`）且当前带 active `exploring`（用 `getActiveExploring(roomId)` 算出的 agentId 集合判断；agentId 是**实例标识**，见 `00-overview.md`）的 agent：该 agent 的内存 `stuckCount` + 1（见第 5 节"卡住提醒"计数）。
   - 遇到 `state === 'idle'` 的 agent：记为 `dispatchTarget`（一个 `RoomAgentState`），停止扫描（排在它后面的 agent 这一次不会被摸到，不计数）。
   若扫描完都没找到可派发的 `idle` agent：`roomEvents.emit('roomStatus', { roomId })`（这次扫描可能改了某些 agent 的 `stuckCount`），返回，不派发。
4. 调用 `createSession(roomId, dispatchTarget.agentId)` + `setAgentState(roomId, dispatchTarget.agentId, 'running', seq)`——这一步和上面的扫描、判断都在同一个同步调用栈内完成。
5. 同步返回后，再调用 `agentInvocation.startSession({ roomId, seq, agentId: dispatchTarget.agentId, registryKey: dispatchTarget.registryKey })`（这是 fire-and-forget，不等待其完成）。`registryKey` 是唯一用于查 `agents.config.json` 的字段，`agentId` 只作为实例标识透传。**必须同时用 try/catch 包住这次调用**：它返回 Promise 的那部分已用 `.catch` 兜住，但同步阶段也可能抛错（如建目录失败）；而 `checkAndDispatch` 会被进程退出等事件回调直接调用，同步抛出会变成未捕获异常、把整个 server 打挂——任何同步抛出都要降级为"记录日志、这次派发失败"，不能让进程死。
6. `roomEvents.emit('roomStatus', { roomId })`（见 `00-overview.md`"推送事件总线"）——同时覆盖第 4 步的状态迁移（新 session 出现、agent 变 `running`）和第 3 步扫描过程中可能产生的 `stuckCount`/`dispatchEnabled` 变化。

**不需要显式加锁/互斥**：`better-sqlite3` 是同步 API，Node.js 单线程执行模型保证"扫描 agent → 写 session/state"这段代码不会被另一次 `checkAndDispatch` 调用打断（只要这段代码本身不含 `await`）。两个触发事件即使"同时"发生，也会被 JS 事件循环序列化为先后两次独立调用，第二次调用执行时一定能看到第一次调用已经提交的状态。这比引入互斥锁更简单，也更准确地反映底层执行模型。

### 1.3 派发的 agent 拿到什么

`agentInvocation.startSession` 传 `roomId`/`seq`/`agentId`（实例标识）/`registryKey`（查注册表配置用，见 1.2 第 5 步）。按需求 3.3，被派发的 agent 拿到两部分输入：

1. **房间协议说明**——固定的规则性内容（消息类型含义、`exploring` 生命周期、人类消息权重更高、可用工具列表等），因为每次 session 都是从零开始，必须每次完整给出，不能假设 agent 记得上次的规则。这部分内容直接写死在 prompt 模板里（见 `04-agent-invocation.md` 第 2 节），不经过任何 API 调用。
2. **当前房间状态**——`agentInvocation.startSession` 内部调用记忆管理层的 `buildOverview(roomId)`（见 `02-memory-management.md`），把结果**预渲染进 prompt**，不要求 agent 自己第一步先调用 MCP 工具才能看到房间状态。这是派发那一刻的快照；房间状态之后如果变了（其他并发 session 产出新内容），agent 仍然可以随时主动调用 MCP 的 `get_overview` 工具刷新——`get_overview` 工具本身也是调用同一个 `buildOverview`，两处调用同一份组装逻辑，不是两套实现。

两者一起构成这次 session 的完整输入。

## 2. 自然结束与最终结算

非交互 CLI 完成一次工作后自行退出，不调用完成工具，也不等待 TUI 输入。`onSessionEnded(event: SessionExitEvent)` 接收 04 定义的进程事实；所有结算经过同一幂等入口。

| 情况 | session.outcome |
|---|---|
| 自然零退出，存在本 session.agentId 发出的 type 非空消息 | completed |
| 自然零退出，无上述实质消息 | passed |
| 异常退出、信号退出或启动失败，未进入人工终止流程 | error |
| stopIntent=terminate，已确认主进程退出或从未启动 | terminated |

没有自动运行时长/无输出超时；卡住时人类可暂停房间、查看日志并终止。MCP 消息可在调用期间持续产生，CLI stdout/stderr 不参与结果判定、不转为 fact。正常结束不自动完成 active exploring，不结束 room。

只处理 running/stopping。事务内写 outcome、endedAt、退出元数据及 process_exited，且仅在 currentSessionSeq 等于本 seq 时释放 agent。撤销凭据，emit roomStatus 并执行一次 `checkAndDispatch`。error 额外写无 type 的系统报错消息（并 emit `message`）。

## 3. `terminateAgentSession(roomId, seq)`

```typescript
function onSessionExitProgress(roomId: number, seq: number,
  kind: 'cleanup_started' | 'sigterm_sent' | 'sigkill_sent' | 'cleanup_failed',
  detail?: string, cleanupAttemptId?: string): void;
```

1. 不存在或已终态则幂等返回。同步事务将 stopIntent 设为 terminate，session/agent 置 stopping，记录 terminate_requested；不提前写 terminated。撤销 MCP 写权限并保留占位。
2. 调用 stopSessionProcess；并发请求共用同一清理任务。先 SIGTERM，默认宽限 2 秒；仍未退出则 SIGKILL，默认再等待 3 秒确认。
3. 确认主进程退出或从未启动后，在第 2 节统一结算 terminated；完成 active exploring，备注"人类强制终止"，清零 stuckCount 并 emit memoryUpdate。
4. 无法确认退出则保持 stopping 与占位，记录 cleanup_failed，RPC 返回明确错误。人类可显式重试，自动退出监听保留。
5. 最终释放后只检查派发一次；terminate 不暂停 room，需停止后续工作时先 pauseRoom。

stopping 只用于人工终止过程，不是正常完成的必经状态。所有清理事件由核心落盘并推送 roomStatus，不进入协作消息或记忆。终态不被迟到回调覆盖。

## 4. 房间生命周期控制

```typescript
function pauseRoom(roomId: number): void;
// setRoomStatus(roomId, 'paused_manual') + roomEvents.emit('roomStatus', { roomId })，不影响进行中的 session，只是不再新起

function resumeRoom(roomId: number, additionalSessions?: number): void;
// 若当前 status === 'paused_limit'：additionalSessions 必填（否则报错），
//   increaseMaxSessions(roomId, additionalSessions) 后 setRoomStatus(roomId, 'active')，
//   emit('roomStatus', { roomId })，再调用 checkAndDispatch(roomId)（恢复后可能有空闲 agent 等待派发，会再自己 emit 一次）
// 若当前 status === 'paused_manual'：additionalSessions 可省略，直接 setRoomStatus(roomId, 'active') + emit('roomStatus', { roomId }) + checkAndDispatch(roomId)

function confirmCompletion(roomId: number): void;
// setRoomStatus(roomId, 'completed') + roomEvents.emit('roomStatus', { roomId })。不终止仍在跑的 session（它们跑完后正常写入结果，
// 只是不会再触发新的派发——checkAndDispatch 第一步就会因 status !== 'active' 直接返回）

async function deleteRoom(roomId: number): Promise<void>;
// 只允许 status === 'completed'，否则抛错（错误由 06-orchestrator-api.md 的 DELETE /api/rooms/:id 转成 HTTP 4xx）。
// confirmCompletion 不终止仍 running 的 session，所以 completed room 可能还挂着 running/stopping session，删前必须收尾：
//   1. 对每个 state === 'running' || state === 'stopping' 的 agent，await terminateAgentSession(roomId, sessionSeq)（必须确认退出；任一清理失败则中止删除并返回错误，保留记录与占位供重试）；
//      terminateAgentSession 内部结尾的 checkAndDispatch 会因 status !== 'active' 立即返回，不会派发新 session。
//   2. await agentInvocation.deleteRoomArtifacts(roomId)（删 <logsDir>/<roomId>/ 与 prompts/violetdagger-<roomId>-*）。
//   3. storage.deleteRoom(roomId)（级联删 DB）。
//   4. roomEvents.emit('roomDeleted', { roomId })；不再 emit roomStatus（room 已不存在）。
```

## 5. "卡住提醒"计数（需求 4.6 / 3.1）

计数发生在 `checkAndDispatch` 每次顺序扫描 agent 列表的过程中（见第 1.2 节第 3 步）：扫描沿途每遇到一个 `running`/`stopping` 且当前带 active `exploring` 的 agent，就给它的内存计数 `stuckCount` + 1，直到遇到第一个 `idle` 的 agent 为止（派给它，扫描停止，排在它后面的 agent 这一次不会被摸到、不会被计数）。计数器不落盘（不需要持久化，room 重启/进程重启后归零即可，属于 UI 提示性质）。

**清零时机**：这个 agent 的 active `exploring` 状态发生变化时，`stuckCount` 归零。三处触发点都调用本节新增的 `resetStuckCount(roomId, agentId)`：
- `insertMessage` 返回 `supersededExploringId != null` 时（自动顶替成新的一条），由调用方（`05-mcp-server.md` 的 `post_message`）调用。
- `complete_exploring` 工具成功后（显式完成），由 `05-mcp-server.md` 调用。
- `terminateAgentSession` 强制完成 exploring 时（见第 3 节第 3 步），核心自己直接调用。

**展示**：`stuckCount >= N` 且该 agent 当前有 active `exploring` 时，`getRoomStatus` 里对应 agent 标记"疑似卡住"，前端展示提醒，不自动处理；没有 active `exploring` 时不展示（无论计数是多少）。默认 `N = 3`（需求第 9 节列为待细化项，可通过服务端配置调整）。

这套机制不再依赖 session 是否会结束——只要一次 session 还在跑、还是同一条 exploring，房间里每有一次新的派发扫描经过它，就计一次；跑得越久、房间里其他 agent 越活跃，累积得越快，不需要等它自己"被重新派发"。

**已知限制**：房间里只有一个 agent 时，`checkAndDispatch` 扫描到它发现 `running`/`stopping` 就直接结束扫描（后面没有别的 agent），不会有新的触发反复扫到它、计数很难自然累积——单 agent 房间下这套机制基本不起作用，人类只能靠 `getRoomStatus` 的"已运行 X 秒"自己判断。这是接受的限制，不额外设计备用机制。

## 6. 连续失败与派发停用（agent enable/disable）

每个 agent 一个**内存** `failureCount`（roomId+agentId，重启归零，与 `stuckCount` 同类，不落盘）：

- **结算更新**：`onSessionEnded` 结算为 `error` 时 `failureCount + 1`；结算为其他终态（`completed`/`passed`/`terminated`）时清零。`terminateAgentSession` 结算后同样清零。
- **自动停用**：`failureCount` 达到阈值（默认 3）时，调用 `storage.setAgentEnabled(roomId, agentId, false)`，清零计数，`emit('roomStatus')`。停用状态**持久化**在 `room_agents.dispatch_enabled`，重启后仍生效。
- **派发跳过**：`checkAndDispatch` 扫描时跳过 `dispatchEnabled === false` 的 agent（见 1.2 第 3 步），继续看后面的；停用不终止正在运行的 session。
- **人工启停**：`setAgentEnabled(roomId, agentId, enabled)` 是人类显式操作。启用时清零 `failureCount`、`emit('roomStatus')` 并调用一次 `checkAndDispatch`（重新入队，可能立刻被派发）；停用只 `emit('roomStatus')`。系统**不自动恢复**，需人类显式启用。
- **展示**：`getRoomStatus` 暴露每个 agent 的 `enabled` 与 `failureCount`，前端展示"连续失败，已停用派发"并提供启用/停用控件（见 `07-frontend.md` §5）。

阈值默认 3，可通过服务端配置调整。这条机制是为了避免"配额/凭据失效等持续失败"时把 `maxSessions` 配额在短时间内烧完（`error` 本身也不占配额，见 `01-storage.md`）。

## 7. 对外接口（供 MCP Server / 编排器对外接口调用）

```typescript
function onSubstantiveMessagePosted(roomId: number): void;
function onSessionEnded(event: SessionExitEvent): void; // 结构见 04-agent-invocation.md
// onSessionExitProgress 见第 3 节
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
```
