# 编排器对外接口设计

服务网页前端，不经过 MCP（见需求 3.5）。REST 处理房间的浏览/创建/删除；进房间后的消息流、记忆视图、房间状态、控制操作都通过一条房间 WebSocket（第 2 节）；"查看 session 实时日志"另走一条独立的日志 WebSocket（第 2.1 节），因为它是持续高频的原始数据流，不适合塞进带 `{id, method}` 信封的房间 WS。

## 1. REST（房间浏览/创建）

```
GET    /api/rooms       → RoomSummary[]
GET    /api/rooms/:id   → Room
POST   /api/rooms       { name: string; agentIds: string[]; schedulingMode: 'sequential'; maxSessions?: number; workdir?: string } → Room
DELETE /api/rooms/:id   → { ok: true }        // 仅 completed 房间可删；级联删除，见 03-orchestrator-core.md 第 4 节
GET    /api/agents      → { agentId: string; available: boolean; unavailableReason?: string }[]
```

`GET /api/rooms/:id` 返回完整的 `Room`（含 `name`/`schedulingMode`/`maxSessions`/`workdir`）——直接刷新或直接打开某个房间的 URL 时，前端需要这个接口拿房间头部信息；`getRoomStatus`（第 4 节）只有运行时状态，不带这些创建时字段。

`GET /api/agents` 返回 agent 注册表（`04-agent-invocation.md` 的 `AgentRegistry`，服务启动时从 `agents.config.json` 加载进内存）里所有的 key，供建房间表单渲染可勾选的 agent 列表（见 `07-frontend.md` 第 11 节）。**这里的 `agentId` 指的是注册表 key（如 `"codex"`），不是房间内的 agent 实例标识**——它是建房间表单这一处的输入，跟 `getRoomStatus` 里 `agentId`（实例标识，见 `00-overview.md`）分属两个层次，不要混用。

`POST /api/rooms` 校验：`agentIds` 非空，且每个都存在于 agent 注册表、已通过 session 身份隔离适配校验（available=true）（见 `04-agent-invocation.md` 第 1 节）；**允许重复**——同一个 agent 出现多次表示要加入多个实例（需求 3.2，数组里是注册表 key；实例标识由 `storage.createRoom` 按 `01-storage.md` 的规则生成）；`schedulingMode` v1 只接受 `'sequential'`；`maxSessions` **可选**，给了就必须是正整数（否则报错），不传则用服务端默认值 20（见 `01-storage.md` §5.1）。`workdir` **可选**（该 room 所有 agent CLI 的 spawn cwd，见 `01-storage.md` §5.4）：给了就做 `~` 展开 + 绝对化，并校验**存在且是目录**（否则报错）；不传则默认取服务端配置 `VIOLETDAGGER_WORKDIR`，再退回 server 进程 cwd。解析后的绝对路径写入 `rooms.workdir`。校验通过后 `storage.createRoom(name, agentIds, schedulingMode, { maxSessions, workdir })`（`room_agents` 的 `join_order` 按传入数组顺序写入，在 `createRoom` 内部完成；实例标识撞名时 `createRoom` 抛错，转为表单错误返回）。创建时不触发任何派发——房间里还没有消息，第一次派发要等人类发第一条消息（见需求 3.1）。

`DELETE /api/rooms/:id`：调用 `orchestratorCore.deleteRoom(roomId)`（见 `03-orchestrator-core.md` 第 4 节）——会先确认遗留 running/stopping session 已退出，再删除磁盘日志和级联删除 DB；清理未确认则返回错误并保留数据，最后 emit `roomDeleted`。非 `completed` 状态会收到 RPC 错误/HTTP 4xx，前端应提示"只有已结束的房间才能删除"。

## 2. WebSocket：`/api/rooms/:roomId/ws`

连接时校验 `roomId` 存在，否则拒绝连接。**拒绝一次 WS 升级时要回一个普通 HTTP 响应（如 404）再优雅关闭，不能直接 `socket.destroy()`**——destroy 会发 RST，反向代理（Vite dev server 的 ws proxy 等）会把一次正常的"房间不存在"误报成 `ECONNRESET`/`socket hang up`。日志 WS（第 2.1 节）同理。之后是一条双向连接，同时承载 RPC 请求/响应和服务端推送：

- 客户端 → 服务端：`{ id: string; method: string; params?: object }`
- 服务端 → 客户端（响应）：`{ id: string; result?: any; error?: { message: string } }`
- 服务端 → 客户端（推送）：`{ event: 'newMessage' | 'memoryUpdate' | 'roomStatus' | 'roomDeleted'; data: any }`

四种推送的 `data` 都不重复携带 `roomId`（连接本身已经按房间绑定）：`newMessage` 的 `data` 是完整的 `Message`；`memoryUpdate` 的 `data` 是 `{ messageId: number }`；`roomStatus` 的 `data` 是 `{}`（纯信号，无字段）；`roomDeleted` 的 `data` 是 `{}`——这是终态推送，发出后服务端立即关闭该房间的全部 WS 连接（见第 3 节）。

**断线与重连**：本模块不做服务端侧的断线补发缓存——连接断开后，服务端不保留任何"待补发"的推送队列。前端重连后必须主动重新拉取一次全量状态（`getRoomStatus()` / `getMemoryView()` / 不带 cursor 的 `listMessages()`），而不是假设服务端会补发断线期间错过的事件（前端侧的具体处理见 `07-frontend.md` 新增的"错误与连接状态"一节）。这个选择是为了让服务端保持无状态、实现简单，符合"本地单机工具"的定位（需求 1）。

**格式错误的请求**：收到无法解析出 `{ id, method, params? }` 的消息——若能解出 `id`（比如 `method` 缺失或不认识），返回 `{ id, error: { message: '...' } }`；若连 `id` 都解不出来（比如整条都不是合法 JSON），直接丢弃，不断开连接。`method` 不在第 4 节 RPC 方法列表里时，同样返回 `{ id, error: { message: 'unknown method: <method>' } }`。

### 2.1 日志 WebSocket：`/api/rooms/:roomId/sessions/:seq/logs?mode=live|replay`

独立只读日志连接，校验 room 与固定 session 存在。live 为最近日志加持续增量；replay 为磁盘已有日志快照，读完关闭。具体 UI 见 `08-live-session-modal.md`。

全部使用带类型的 JSON 帧，防止日志正文与控制信息混淆：

```typescript
type SessionLogFrame =
  | { type: 'ready'; source: 'live' | 'snapshot'; truncated: boolean }
  | { type: 'data'; offset: number; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'end'; reason: 'process-exited' | 'snapshot-complete'; exitCode: number | null }
  | { type: 'error'; message: string };
```

1. live 且 attachSessionLog 返回句柄：先订阅缓存增量，再截取快照；发送 ready(source=live)、快照、按 offset 去重后的缓存，然后实时转发。进程结束发送 end(process-exited) 后关闭。
2. replay 或 live 无句柄：ready(source=snapshot)，流式读取文件并转换为 data，完成后发 end(snapshot-complete) 并关闭。运行中无句柄只能显示快照，不能据此判定任务结束。
3. 历史原始文本日志按 stdout 分块映射，只用于回放；新 JSONL 日志保留 offset/stream。读取错误发送 error，不伪造正常结束。
4. 客户端不发送 input/resize 或其他控制帧；服务端拒绝客户端应用数据。多个观察者独立订阅，关闭连接不影响进程。
5. 断线不自动重连，用户重开窗口；后台写出采用有界队列，慢消费者超限明确断开而不静默丢日志，不能阻塞 agent 执行。上限由实现配置，默认 1 MiB。
6. end 只说明日志流结束，最终 session outcome 从房间 RPC 读取。

## 3. 推送事件总线（跨模块，定义在 `00-overview.md`）

进程内的一个 `EventEmitter`（不是 WS 本身，是 WS 推送逻辑的输入源），供 `03`/`05`/`06` 共用，完整的 emit 时机说明见 `00-overview.md`。本模块订阅这四个事件：`message`/`memoryUpdate`/`roomStatus` 按 `roomId` 过滤后转发给对应房间已连接的 WS 客户端，转成第 2 节的推送格式；`roomDeleted` 则向该房间所有连接发送 `{ event: 'roomDeleted', data: {} }` 后主动关闭它们（终态——该房间不再存在；对应房间的日志 WS 连接也一并关闭）。

## 4. RPC 方法

```typescript
// 消息（targetMessageId/referencedMessageIds 都是本 room 内的消息 id，见 01-storage.md）
listMessages(params: { cursor?: number; limit?: number }): { messages: Message[]; nextCursor: number | null };
postHumanMessage(params: { content: string; type?: MessageType; targetMessageId?: number; referencedMessageIds?: number[] }): { messageId: number };
// authorId 固定为 "human"，不从客户端传入；storage.insertMessage(...) 返回 { message, supersededExploringId }，
// emit('message', { roomId, message })，若 supersededExploringId != null 额外 emit('memoryUpdate', { roomId, messageId: supersededExploringId })（同 05-mcp-server.md post_message 的处理，见 00-overview.md），
// 并无条件调用 orchestratorCore.onSubstantiveMessagePosted(roomId)（人类消息一律算实质消息，见需求 3.3）

// 记忆视图（全文，不是摘要）
getMemoryView(): MemoryViewPayload;
// 直接 return memoryManagement.buildMemoryView(roomId)（见 02-memory-management.md 第 6 节）；
// exploring 分组是 getMessagesByType(roomId, 'exploring') 全量，不筛 active/completed，前端按 exploringStatus 自己分组/标灰

// 房间状态
getRoomStatus(): {
  currentSessionCount: number; // countSessions(roomId)：只计 outcome != 'error' 的 session（见 01-storage.md）
  status: RoomStatus;
  agents: {
    agentId: string;               // agent 实例标识（见 00-overview.md），非注册表 key
    state: 'idle' | 'running' | 'stopping';
    sessionId?: number;            // 仅 running/stopping 时给出，取自 RoomAgentState.currentSessionSeq
    sessionStartedAt?: string;     // 仅 running/stopping 时给出，取自 Session.startedAt
    stopIntent?: 'terminate';
    exitWarning?: string;          // 从 cleanup_failed 事件派生
    enabled: boolean;              // room_agents.dispatch_enabled
    failureCount: number;          // 连续失败计数（内存，见 03 §6）
    activeExploringSummary?: string; // 该 agent 当前 active 的 exploring 消息 summary（如果有）
    stuck?: boolean;               // 来自 orchestratorCore.getStuckAgents(roomId)
  }[];
};

// 事件树
getEventTree(): {
  sessions: {
    seq: number; agentId: string; outcome: SessionOutcome;
    startedAt: string; endedAt: string | null;
    lifecycleEvents: SessionEvent[]; // listSessionEvents
    messages: Message[]; // getMessagesBySession(roomId, seq)
  }[];
  // 人类消息（sessionSeq === null）不在这里返回，前端结合 listMessages 按 createdAt 穿插进时间线
};
// 依赖 01-storage.md 的 listSessions(roomId): Session[]

// 单 session 详情（事件树复盘视图 SessionDetailModal 用：头部元数据 + 消息列表 + 只读日志）
getSessionDetail(params: { sessionId: number }): {
  agentId: string; startedAt: string; endedAt: string | null; outcome: SessionOutcome;
  messages: Message[];   // getMessagesBySession(roomId, sessionId)，供事件树详情视图（07 §10.2）渲染该 session 的消息列表
  lifecycleEvents: SessionEvent[];
  exitCode: number | null; exitSignal: string | null;
  stopIntent: 'terminate' | null;
  cleanupStartedAt: string | null; exitCause: Session['exitCause'];
  rawLog: string;        // 读取 session.rawLogPath 文件内容（日志展示已改走第 2.1 节的日志 WS，这里保留供下载/兜底）
  wroteMessages: boolean; // messages.length > 0
};

// 控制操作
terminateAgentSession(params: { sessionId: number }): { ok: true }; // 仅确认退出或已终态时成功；清理未确认返回 RPC error  // orchestratorCore.terminateAgentSession(roomId, sessionId)
setAgentEnabled(params: { agentId: string; enabled: boolean }): { ok: true }; // 人类启停某个 agent 的派发（见 03 §6）
pauseRoom(): { ok: true };                                            // orchestratorCore.pauseRoom(roomId)
resumeRoom(params: { additionalSessions?: number }): { ok: true };    // orchestratorCore.resumeRoom(roomId, additionalSessions)
confirmCompletion(): { ok: true };                                    // orchestratorCore.confirmCompletion(roomId)
```

## 5. 事件树依赖的存储函数

`getEventTree`（第 4 节）依赖 `01-storage.md` 的 `listSessions(roomId): Session[]`（按 seq 升序列出一个 room 的全部 session，供事件树渲染完整时间线）。

## 6. 对外依赖

```typescript
// 存储层
listMessages, insertMessage, countSessions, listSessions,
getMessagesBySession, listSessionEvents, getSession, getRoom, getRoomAgents

// 记忆管理层（见 02-memory-management.md）
buildMemoryView(roomId: number): MemoryViewPayload

// 编排器核心
onSubstantiveMessagePosted, pauseRoom, resumeRoom, confirmCompletion, deleteRoom,
terminateAgentSession, getStuckAgents, setAgentEnabled

// Agent 调用适配层（见 04-agent-invocation.md）
AgentRegistry（GET /api/agents 直接读取启动时加载好的注册表，不经过编排器核心）
attachSessionLog(roomId, seq): SessionLogHandle | null（第 2.1 节日志 WS 用）

// 共享事件总线（见第 3 节、00-overview.md）
roomEvents.on('message' | 'memoryUpdate' | 'roomStatus' | 'roomDeleted', handler)
```

## 7. 生命周期展示约定

session_events 与消息分开返回，事件树详情展示人工终止请求、清理意图、SIGTERM/SIGKILL 发送、退出归因与清理失败与最终结果。生命周期变化沿用 roomStatus 通知，客户端重拉状态、事件树与当前打开的 session 详情；不发 newMessage 或 memoryUpdate。stopping 不代表进程退出；两种非终态均允许人工终止，日志始终只读。room 已 completed 但仍有非终态 session 时也保留其查看和终止入口。

人工终止请求期间也显示 stopping，不能把 RPC 已发出当作 terminated。RPC 清理失败须展示错误并保留终止重试入口；成功需刷新服务端 outcome。stopIntent=terminate 表示人工终止中；自然完成不设置 stopIntent。
