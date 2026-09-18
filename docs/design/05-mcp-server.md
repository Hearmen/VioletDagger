# MCP Server 设计

暴露给外部 agent CLI 的唯一入口。实现 4.2/4.4 定义的四个工具：`post_message`、`complete_exploring`、`get_overview`、`get_detail`。单一固定端口，所有 room 共用一个连接地址（见 `00-overview.md`），不做按 room 拆分的多端点。

## 1. Transport

Streamable HTTP transport 使用单一固定端口。每次 session 启动前签发随机高熵凭据（至少 256 bit），服务端内存中固定映射到 {roomId, agentId, sessionSeq}。凭据通过 CLI 的 MCP 请求配置携带，不放入工具参数或 prompt。已有 MCP transport 会话也必须固定绑定同一身份；重连可使用同一有效凭据，不能更换身份。终态撤销，服务重启后旧凭据失效。

```typescript
type SessionIdentity = { roomId: number; agentId: string; sessionSeq: number };
function issueSessionCredential(identity: SessionIdentity): string;
function revokeSessionCredential(roomId: number, seq: number): void;
```

身份管理由组装根注入适配层和核心，避免模块循环依赖。仅存储凭据摘要用于查询，不记录明文日志。适配层负责独立配置与注入语法（04 第 2 节）。这用于 session 归属隔离，不引入多用户账户系统。

## 2. 通用校验（四个工具共用）

- `roomId` 必须存在（`getRoom(roomId)` 非空），否则返回 MCP 错误"room not found"。
- `post_message`/`complete_exploring` 额外要求 `authorId` 不是保留值 `"human"`/`"system"`——这两个值只能通过内部写入路径使用（编排器对外接口的 `postHumanMessage`、编排器核心直接写入的系统消息），MCP 对外接口一律拒绝。

**错误返回形式统一**：本节及后续各工具小节提到的"报错"/"拒绝"，统一通过 MCP 工具调用结果的 `isError: true`（`content` 里携带错误文案）返回，不是 transport/协议层面的错误——Streamable HTTP transport 下同一条连接要能继续处理该 agent 后续的其他工具调用，不能因为一次校验失败就影响连接本身。四个工具遇到校验失败时都遵循这个统一形状，各小节不再逐条重复这句话。

## 3. 固定 Session 绑定（所有写工具共用）

1. 从请求凭据/transport 上下文取得固定 SessionIdentity，缺失或无效时拒绝写入。
2. 按 (roomId, sessionSeq) 查 session，校验 agentId 一致，outcome 为 running。禁止改为查 agent 的“当前 session”。
3. post_message、complete_exploring 保留的 roomId/authorId 参数必须与绑定身份一致，只用于校验；sessionSeq 始终来自上下文。
4. stopping 和终态拒绝写入；人工终止立即撤销权限。校验与同步落库之间不插入 await，防止退出与写入竞态。旧凭据不能写到下一次 session。

## 4. `post_message`

```typescript
post_message(params: {
  roomId: number;
  authorId: string;
  content: string;
  type?: 'fact' | 'hypothesis' | 'boundary' | 'open_question' | 'chain'
       | 'exploring' | 'propose_completion' | 'endorse' | 'challenge' | 'verify';
  targetMessageId?: number;
  referencedMessageIds?: number[];
  summary?: string;
}): { messageId: number }
```

1. 通用校验 + Session 绑定（第 2、3 节）。
2. 字段校验：
   - `type` 是 `endorse`/`challenge`/`verify` 时，`targetMessageId` 必填，且必须以 `getMessageById(roomId, id)` 查到（消息 id 是 room 内编号，见 `01-storage.md`），否则报错。
   - `referencedMessageIds` 只允许 `type === 'chain'` 时提供；提供时逐个以 `getMessageById(roomId, id)` 校验存在。
   - `type === 'open_question'` 时 `targetMessageId` 可选，提供则同样校验存在性。
3. `const { message, supersededExploringId } = storage.insertMessage({ roomId, sessionSeq, authorId, content, type, targetMessageId, referencedMessageIds, summary })`。
4. `roomEvents.emit('message', { roomId, message })`（见 `00-overview.md`"推送事件总线"）；若 `supersededExploringId != null`，额外 `roomEvents.emit('memoryUpdate', { roomId, messageId: supersededExploringId })`（这次插入的 `exploring` 消息自动顶替了该 agent 之前 active 的那条，旧消息的 `exploringStatus` 变了，需要单独推送），并调用 `orchestratorCore.resetStuckCount(roomId, authorId)`（换了新方向，"卡住"计数清零，见 `03-orchestrator-core.md` 第 5 节）。
5. 若 `type != null`，调用 `orchestratorCore.onSubstantiveMessagePosted(roomId)`（对应触发源(1)，见 `03-orchestrator-core.md` 1.1）。
6. 返回 `{ messageId: message.id }`。

## 5. `complete_exploring`

```typescript
complete_exploring(params: { roomId: number; authorId: string; messageId: number }): { ok: true }
```

1. 通用校验 + Session 绑定（第 2、3 节）——理由同 `post_message`：只有固定绑定的 `running` session 才能调用，防止 session 已经结束后台进程还在迟到调用。
2. `getMessageById(roomId, messageId)`（消息 id 是 room 内编号）：必须存在、`authorId` 与调用者一致、`type === 'exploring'`、`exploringStatus === 'active'`，否则报错。
3. `storage.completeExploring(roomId, messageId)`（不带 note——note 是人类强制终止专用，见 `03-orchestrator-core.md` 第 3 节）。
4. `roomEvents.emit('memoryUpdate', { roomId, messageId })`（见 `00-overview.md`"推送事件总线"），并调用 `orchestratorCore.resetStuckCount(roomId, authorId)`（显式完成探索，"卡住"计数清零，见 `03-orchestrator-core.md` 第 5 节）。
5. **不**触发 `onSubstantiveMessagePosted`（这是状态变更不是新消息，见 4.5 的"只追加"原则和 `03-orchestrator-core.md` 1.1 对触发源的定义）。
6. 返回 `{ ok: true }`。

## 6. `get_overview`

```typescript
get_overview(params: { roomId: number }): OverviewPayload
```

**无需 session 绑定**——按需求 4.4 的签名，`get_overview` 只接受 `roomId`，是纯读操作，不校验调用者身份。

实现：直接 `return memoryManagement.buildOverview(roomId)`（见 `02-memory-management.md` 第 4 节，`OverviewPayload` 的字段定义、组装逻辑都在那边）。这是 agent 主动调用这个工具时的用法；同一份 `buildOverview` 也被 `04-agent-invocation.md` 在派发时调用，预渲染进 prompt——两处共用一份实现，不重复。

## 7. `get_detail`

```typescript
get_detail(params: { roomId: number; messageId?: number; type?: MessageType }): MessageWithAnnotations | MessageWithAnnotations[]
// messageId 和 type 二选一，都不传或都传视为参数错误
```

**同样无需 session 绑定**（按需求 4.4 签名，纯读操作）。

实现：直接 `return memoryManagement.buildDetail(roomId, messageId != null ? { messageId } : { type })`（见 `02-memory-management.md` 第 5 节）。

## 8. 对外依赖

```typescript
// 存储层（见 01-storage.md）——get_overview/get_detail 用到的查询函数已经挪到记忆管理层，这里只保留 post_message/complete_exploring 自己需要的
getRoom, getSession, getMessageById(roomId, id), insertMessage, completeExploring(roomId, messageId, note?)

// 记忆管理层（见 02-memory-management.md）
buildOverview(roomId: number): OverviewPayload
buildDetail(roomId: number, params: { messageId: number } | { type: MessageType }): MessageWithAnnotations | MessageWithAnnotations[]

// 编排器核心（见 03-orchestrator-core.md）
onSubstantiveMessagePosted(roomId: number): void
resetStuckCount(roomId: number, agentId: string): void

// 共享事件总线（见 00-overview.md"推送事件总线"）
roomEvents.emit('message' | 'memoryUpdate', payload)
```

工具 handler 由 MCP transport 调用；身份签发/撤销接口供组装根注入适配层与核心。

## 9. 启动自检（健康检查）

服务启动时（`startApp` 起完 REST/WS 与 MCP server 之后）**先对 MCP server 做一次自检**，避免"进程起来了、但 MCP 不健康，等第一次派发 agent 调 `post_message` 才失败"这种迟到的暴露。

- 实现：用 `@modelcontextprotocol/sdk` 的 `Client` + `StreamableHTTPClientTransport` 连本进程的 MCP 地址（`http://127.0.0.1:<实际 MCP 端口>`，从已监听的 server 地址读取，端口为 0 时也能拿到真实值），执行 `listTools()` 并断言四个工具（`post_message` / `complete_exploring` / `get_overview` / `get_detail`）都在。
- 只做一次、**只读**：不建 room、不写消息。
- 失败即 fail-fast：连接失败、超时、或工具缺失，都抛错；`startApp` 会关掉已经监听的 REST/WS 与 MCP server 后退出，`main.ts` 打印清晰的失败原因。
- 不校验单个 agent CLI 侧是否接好 MCP（那要真的拉起 agent、消耗额度），只校验"编排器自身的 MCP 端点健康"。

对外接口：`verifyMcpServer(url: string, timeoutMs?: number): Promise<void>`，供 `startApp` 调用。
