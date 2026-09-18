# VioletDagger 设计总览

本目录下每个文件对应一个独立模块的详细设计；模块间的对外接口在各自文档的"对外接口"一节中定义。需求依据见 `docs/requirements.md`。

## 模块清单

| 文档 | 模块 | 说明 |
|---|---|---|
| `01-storage.md` | 存储层 | SQLite schema，room/session/message/exploring 的持久化 |
| `02-memory-management.md` | 记忆管理 | 把存储层的原始查询组装成 overview/detail/memoryView 的形状，供派发 prompt 预渲染、MCP Server、编排器对外接口共用 |
| `03-orchestrator-core.md` | 编排器核心 | 事件驱动派发、调度、session 生命周期 |
| `04-agent-invocation.md` | Agent 调用适配层 | 子进程 spawn/终止、agent 注册表 |
| `05-mcp-server.md` | MCP Server | 暴露给外部 agent CLI 的工具（post_message/get_overview/...） |
| `06-orchestrator-api.md` | 编排器对外接口 | REST + WebSocket，服务网页前端 |
| `07-frontend.md` | Web 前端 | 房间列表、消息流、记忆面板、事件树 |

存储层之上先是记忆管理（纯粹是存储层原始查询的组装层，谁都能调用，不依赖任何其他模块），再定义引擎部分（编排器核心 → Agent 调用适配层），最后是两层对外接口（MCP Server 给 agent、编排器对外接口给前端）和前端——MCP Server 本质上是包装编排器核心调度状态的一层薄接口（session 绑定依赖固定调用凭据及 session 的 `running` 状态，这是编排器核心模块定义的），所以放在核心调度之后设计更合理。

## 进程拓扑

编排器核心、存储层、记忆管理、MCP Server、Agent 调用适配层运行在**同一个 Node.js 进程**内，模块间直接函数调用，不经过 IPC。Web 前端是独立的浏览器应用，通过 REST + WebSocket 与该进程通信（见 `06-orchestrator-api.md`）；MCP Server 通过 HTTP（Streamable HTTP transport）暴露给外部 agent CLI 进程。

## 仓库结构

```
VioletDagger/
├── docs/
│   ├── requirements.md
│   └── design/                 # 本目录
├── packages/
│   ├── server/                 # 编排器核心 + 存储层 + 记忆管理 + MCP Server + agent 调用适配层
│   │   ├── agents.config.json  # agent 注册表（3.2）
│   │   └── src/
│   └── web/                    # React + Vite 前端
└── package.json                # npm workspaces 根
```

## 技术栈

- 后端：TypeScript / Node.js，HTTP + WebSocket 服务
- 存储：SQLite（WAL 模式），`better-sqlite3` 原生 SQL（不引入 ORM）。**版本需 `better-sqlite3` 13.x**：11.x 在 Node 24 上会出现原生崩溃（`Statement` 析构时环境已销毁，`node::RemoveEnvironmentCleanupHook` 断言失败、进程直接 abort），表现为后端不定时退出、前端 WS/代理 `ECONNREFUSED`
- 执行模式：普通子进程执行一次性非交互 CLI，stdout/stderr 提供实时只读日志，不使用 PTY。正式协作产出统一通过 MCP（见 `04-agent-invocation.md`）。交互式 PTY 模式属于下一版本，本版本不做设计。
- MCP：`@modelcontextprotocol/sdk`，Streamable HTTP transport，单一固定端口，所有 room 共用一个连接地址
- 前端：React + Vite，日志用纯文本 `SessionLogView` 显示，不依赖 xterm。

## 跨模块的公共约定

- **保留 `authorId` 值**：`"human"`（3.5 已定义）、`"system"`（新增，用于报错等系统生成的消息，见 `03-orchestrator-core.md` 和 `04-agent-invocation.md` 的错误处理）。
- **agent 实例标识**：一个 room 里同一个注册表 agent 可以被加入多次。`room_agents.agent_id`、`sessions.agent_id`、`messages.author_id` 存的都是**实例标识**（该 agent 只被加入一次时等于注册表 key，如 `"codex"`；加入多次时按加入顺序为 `"codex-1"`/`"codex-2"`……，见 `01-storage.md`）。实例标识到注册表配置的映射单独存 `room_agents.registry_key`，任何需要查 `agents.config.json` 的地方（目前只有 `04-agent-invocation.md` 的 `startSession`）都用 `registry_key`，不要从实例标识反解后缀。
- **`sessionId` 的范围**：是**单个 room 内**的自增计数器，由该 room 里所有 agent 共享（不是每个 agent 各自计数，也不是跨 room 的系统级全局值）。需求文档 3.3 用词"全局自增"在这里特指"room 内全局"，为避免歧义，各模块文档统一使用"room 内自增"的表述。
- **`messageId` 的范围**：与 `sessionId` 同理，是**单个 room 内**的自增编号，不是全库唯一。`targetMessageId`/`referencedMessageIds` 引用的是**同一 room 内**的消息 id，跨 room 引用不存在（见 `01-storage.md`）。前端展示的 `#N` 也是 room 内消息编号。
- **`sessionId` 的盖章时机**：MCP Server 从每次启动签发的固定会话凭据取得 roomId/agentId/sessionSeq，校验调用参数与身份一致，并将该 seq 写入消息。仅 running 可写，stopping 与终态撤销凭据；禁止通过 agent 当前 session 推断归属（见 `05-mcp-server.md`）。
- **没有自动超时机制**：编排器不会主动判断"session 跑太久了"，不会自动把某次 session 标记为超时/出错——session 会一直运行到自己正常退出或报错退出为止，不设执行时长上限（对应需求 3.3 的最新修订，`benched` 状态和 `timeout` outcome 已从整套设计里移除）。人类通过 `getRoomStatus` 的"已运行 X 秒"或"卡住提醒"（见 `03-orchestrator-core.md` 第 5 节）自行判断是否需要主动 `terminateAgentSession`。
- **自然结束**：非交互 CLI 自然退出后按退出结果与 MCP 实质消息结算 completed/passed/error，无完成工具。人工终止经 stopping 确认退出后结算 terminated；清理失败保留占位。日志、生命周期事件不进入共享记忆。
- **推送事件总线**：进程内的一个 `EventEmitter`（命名 `roomEvents`），供 `03-orchestrator-core.md`、`05-mcp-server.md`、`06-orchestrator-api.md` 共用，用来解耦"状态变更发生在哪个模块"和"WS 推送逻辑在哪个模块"——避免编排器对外接口反过来被核心/MCP Server 依赖形成循环依赖。四个事件（前三个是转发给房间 WS 的推送源；`roomDeleted` 是终态信号，见下）：

  ```typescript
  roomEvents.emit('message', { roomId: number; message: Message });      // 有新消息写入（任何来源）
  roomEvents.emit('memoryUpdate', { roomId: number; messageId: number }); // 某条已有消息的 exploringStatus 变了（不是新消息）
  roomEvents.emit('roomStatus', { roomId: number });                      // room/agent/session 状态变了
  roomEvents.emit('roomDeleted', { roomId: number });                     // 一个 room 被删除，其数据已不存在
  ```

  谁在什么时候 emit：
  - `05-mcp-server.md`：`post_message` 成功写入后 emit `message`；若这次插入顶替了该 agent 之前 active 的 `exploring`（`insertMessage` 返回的 `supersededExploringId != null`），额外 emit `memoryUpdate`，并调用 `orchestratorCore.resetStuckCount(roomId, authorId)`（内部也会 emit `roomStatus`，见下）；`complete_exploring` 成功后 emit `memoryUpdate`，同样调用 `resetStuckCount`。
  - `03-orchestrator-core.md`：任何 session/agent/room 状态迁移之后（`checkAndDispatch` 派发出新 session、`checkAndDispatch` 触及 `max_sessions` 把 room 置为 `paused_limit`、`checkAndDispatch` 扫描沿途改了某些 agent 的 `stuckCount`（即便这次没有实际派发）、`onSessionEnded` 状态迁移、人工清理进度事件、`terminateAgentSession`、`pauseRoom`/`resumeRoom`/`confirmCompletion`、`resetStuckCount`、agent `dispatch_enabled` 变化）emit `roomStatus`；`onSessionEnded` 插入系统消息后 emit `message`；`terminateAgentSession` 里 `completeExploring` 成功后 emit `memoryUpdate`；`deleteRoom` 在级联删除完成、发 `roomDeleted` 之后不再 emit `roomStatus`（room 已不存在；删除前为收尾遗留 running session 而调用的 `terminateAgentSession` 仍会照常 emit 它自己的 `roomStatus`）。
  - `06-orchestrator-api.md`：`postHumanMessage` 成功写入后 emit `message`；同样地，若 `insertMessage` 返回的 `supersededExploringId != null`，额外 emit `memoryUpdate`。

  `06-orchestrator-api.md` 订阅这四个事件：前三个按 `roomId` 过滤后转发给对应房间已连接的 WebSocket 客户端；`roomDeleted` 则向该房间所有已连接的 WebSocket 客户端发一条终态推送后主动关闭它们（之后该房间不再存在，不会有新的推送）。
