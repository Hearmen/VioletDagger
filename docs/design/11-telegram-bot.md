# Telegram 远程控制设计

需求依据：`docs/requirements.md` 3.6。本模块是独立进程，只是编排器对外接口（`06-orchestrator-api.md`）的又一个客户端，与网页前端同层：不读写存储、不调用编排器核心、不经过 MCP，编排器进程对它的存在无感知，不需要任何服务端改动。

## 1. 进程与依赖

- 包：`packages/telegram-bot`（npm workspace `@violetdagger/telegram-bot`），TypeScript / Node.js，`tsx src/main.ts` 启动。根 `package.json` 的 `dev` 脚本用 `concurrently` 同时启动 server、web 与本模块，Ctrl-C 一起停止；另保留 `"bot": "npm start -w @violetdagger/telegram-bot"` 单独启动。未配置 token 时本模块按 §2 报错退出，`concurrently` 不因此停止 server 与 web，不用 Telegram 时可忽略这一行报错。本模块与编排器的启动顺序无关：编排器尚未就绪时，房间集合同步失败按 §5.2 每 60 秒重试，命令回复"编排器不可达"。
- 依赖：`ws`（房间 WS 客户端）；Telegram Bot API 与 REST 均用 Node 内置 `fetch`，不引入 Telegram SDK。
- 与 Telegram：`getUpdates` 长轮询（`timeout=50`），只有出站 HTTPS；不使用 webhook，不需要公网入口。
- 与编排器：`VIOLETDAGGER_API_URL`（默认 `http://127.0.0.1:4200`）下的 REST 与 `/api/rooms/:roomId/ws`。不使用日志 WS（`06` 第 2.1 节）。

## 2. 配置

| 环境变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | 是 | — | BotFather 签发的 token |
| `VIOLETDAGGER_TG_ALLOWED_USER_IDS` | 是 | — | 逗号分隔的 Telegram 数字用户 id；解析后为空或含非整数时拒绝启动 |
| `VIOLETDAGGER_API_URL` | 否 | `http://127.0.0.1:4200` | 编排器 REST/WS 地址 |
| `VIOLETDAGGER_TG_STATE_PATH` | 否 | 包根目录下 `state.json` | 私聊状态持久化文件 |
| `VIOLETDAGGER_TG_IDLE_NOTIFY_DELAY_MS` | 否 | `10000` | "无任务可派发"提醒的稳定等待时间（§6.2） |

环境变量也可以写在配置文件 `~/.config/violetdagger/telegram.env`（`KEY=value` 每行一个）：启动时若该文件存在则加载（Node `--env-file-if-exists`），进程环境中已有的同名变量优先。该文件在仓库之外，建议权限 600。

启动时校验必填项，失败打印原因并以非 0 退出。`state.json` 加入 `.gitignore`；token 不写入任何文件。

## 3. 访问控制

每个 update（消息与 callback query）在处理前检查：`chat.type === 'private'` 且 `from.id` 在白名单内。不满足的一律不回复、不 `answerCallbackQuery`（不暴露机器人可用），只在本地打印一行 `rejected update from <from.id> in <chat.type>`。主动推送（§6）只发往 `state.json` 中已登记的私聊，登记只发生在白名单用户发送 `/start` 时。

## 4. 私聊状态

```typescript
interface BotState {
  chats: Record<string, { currentRoomId: number | null }>; // key 为 chat id
}
```

- `/start` 登记私聊（已登记则保留原 `currentRoomId`）。`/use`、新建房间成功后更新 `currentRoomId`。每次修改后整体写回文件（先写临时文件再 rename）。文件不存在视为空状态；无法解析时打印错误并按空状态启动，不覆盖原文件直到第一次修改。
- 当前房间被删除（收到 `roomDeleted` 或 REST/WS 返回房间不存在）时，把指向它的 `currentRoomId` 置为 `null`。
- 需要当前房间的命令在 `currentRoomId` 为 `null` 时回复"未选择房间，用 /rooms 或 /use <id> 选择"。

## 5. 编排器客户端

### 5.1 REST

`GET /api/rooms`、`GET /api/rooms/:id`、`POST /api/rooms`、`DELETE /api/rooms/:id`、`GET /api/agents`。非 2xx 时取响应体 `error.message` 作为错误文案，取不到用 `HTTP <status>`；网络失败统一为"编排器不可达"。

### 5.2 房间连接 `RoomConnection`

每个房间至多一条 WS，承载 RPC 与推送：

- RPC：`call(method, params)` 生成唯一 `id`，发送 `{ id, method, params }`，按 `id` 匹配响应；15 秒无响应以超时错误结束；`error.message` 原样作为错误文案。连接断开时所有未完成调用以"连接断开"失败。
- **监视连接**：status 不为 `completed` 的房间常驻连接，用于提醒（§6）。断线后按 1s、2s、4s…上限 30s 退避重连；重连成功后重新建立提醒基线（§6.1），不补发断线期间的提醒（与 `06` §2 的无补发约定一致）。
- **临时连接**：对 `completed` 房间的命令按需建立连接，最后一次调用后 60 秒空闲关闭。
- **房间集合同步**：启动时、每 60 秒、以及新建/删除/确认完成成功后调用 `GET /api/rooms`：为新出现的未结束房间建立监视连接，对变为 `completed` 的房间转为临时连接（触发空闲关闭），对已不存在的房间关闭连接。
- **连接失败的区分**：WS 升级被拒绝时服务端回 HTTP 404（`06` §2），用 `ws` 的 `unexpected-response` 事件识别状态码 404：房间不存在，不再重连并从集合移除，按 §4 清空相关 `currentRoomId`。其余失败（`ECONNREFUSED` 等）按退避重连。
- 收到 `roomDeleted` 推送：关闭连接、从集合移除、按 §4 清空相关 `currentRoomId`，不发提醒。只有 `completed` 房间可删，它们没有监视连接，所以在网页上删除的房间通常在下一次房间集合同步时才被发现，同样静默移除。通过 `/deleteroom` 删除的房间由命令回复本身告知结果。
- 在网页上新建的房间要到下一次房间集合同步（至多 60 秒）才建立监视连接，期间的状态变化不产生提醒。

## 6. 主动提醒

### 6.1 基线与边沿触发

提醒只在状态**变化的边沿**发送，不对建立连接时已经存在的状态发送。每条监视连接维护上一次的状态快照：

```typescript
interface AlertSnapshot {
  status: RoomStatus;
  dispatchIdle: boolean;
  agents: Record<string, {
    stuck: boolean;                     // getRoomStatus 缺省（sequential 房间）记为 false
    exitWarningSessionId: number | null; // 有 exitWarning 时记其 sessionId，否则 null
  }>;
}
```

连接（含重连）成功后立即 `getRoomStatus()` 作为基线，不产生提醒。之后每次收到 `roomStatus` 推送，合并 300ms 内的连续推送后调用一次 `getRoomStatus()`，与快照比较、产生提醒、更新快照。

### 6.2 提醒规则

| 来源 | 条件 | 提醒内容 |
|---|---|---|
| `roomStatus` | `status` 变为 `paused_limit` | 已达 session 上限并暂停（附 `/resume <n>` 用法） |
| `roomStatus` | 某 agent `stuck` false→true | agent 可能卡住，附其 `sessionId`、`activeExploringSummary`、`/terminate <sessionId>` |
| `roomStatus` | 某 agent 有 `exitWarning`，且其 `sessionId` 与快照中的 `exitWarningSessionId` 不同 | session #`sessionId` 清理未确认，附 `/terminate <sessionId>` 重试 |
| `roomStatus` | `dispatchIdle` false→true | 见下方稳定等待；附停用 agent 数 `disabledAgentCount` |
| `newMessage` | session 以 error 结束（见下方识别方式） | agent 的 session #seq 异常退出，附占位消息全文；若该 agent 此时已停用派发，追加"已因连续失败被停用派发，/enable <agentId>" |
| `newMessage` | `authorId === 'system'` | 系统消息全文（如记忆输入超预算导致房间暂停） |
| `newMessage` | `type === 'propose_completion'` | 提议完成，附消息全文与"确认完成"按钮（§8） |

- **session 报错的识别**：session 以 passed/error/terminated 结束时，核心写一条无 type 的占位消息，作者是该 agent 实例标识（`03-orchestrator-core.md` §2）。收到 `type === null`、`sessionSeq !== null` 且 `authorId` 不是 `human`/`system` 的 `newMessage` 时，调用 `getEventTree()` 查该 `sessionSeq` 的 `outcome`：为 `error` 才提醒，`passed`/`terminated`/`running`/`stopping`（agent 运行中发出的无 type 消息）都不提醒。随后调用一次 `getRoomStatus()` 读取该 agent 的 `enabled`，决定是否追加停用说明。自动停用由核心在结算时与计数清零同时完成（`03` §6），因此不从 `roomStatus` 的 `enabled` 变化推断，人类手动停用也就不会被误报。
- **无任务可派发的稳定等待**：边沿出现后等待 `VIOLETDAGGER_TG_IDLE_NOTIFY_DELAY_MS`，到期再调用一次 `getRoomStatus()`，仍为 true 才发送；等待期间状态回到 false 则取消。避免 session 交接间隙的短暂空闲误报。`dispatchIdle` 本身只在房间 `active` 时为 true（`03` §1.6），不另判房间状态。
- 人类通过本机器人或网页执行的操作同样会引起状态变化，规则不区分操作来源。
- 每条提醒以 `[#<roomId> <name>]` 开头，发往所有登记私聊，不限当前房间。房间名从房间集合同步得到的 `RoomSummary` 读取。

## 7. 命令

参数用空格分隔；`<>` 为必填，`[]` 为可选。启动时调用 `setMyCommands` 注册命令列表。错误（参数不合法、REST/RPC 错误、编排器不可达）一律回复一行错误文案，不中断机器人。

| 命令 | 作用 | 对应接口 |
|---|---|---|
| `/start` | 登记私聊，回复帮助 | — |
| `/help` | 命令说明 | — |
| `/rooms` | 列出房间：`#id name status`，未结束的在前；每个房间一个内联按钮"使用" | `GET /api/rooms` |
| `/use <roomId>` | 设为当前房间，回复房间头部信息 | `GET /api/rooms/:id` |
| `/agents` | 注册表 agent 及可用性（不可用附原因） | `GET /api/agents` |
| `/status` | 当前房间状态：房间状态、session 数 `currentSessionCount/maxSessions`、调度模式、下一轮 agent（sequential）、无任务可派发、每个 agent 的状态/session/已运行时长/启用/失败计数/卡住/探索摘要/清理警告 | `GET /api/rooms/:id` + `getRoomStatus` |
| `/messages [n]` | 最近 n 条消息（默认 10，上限 50），按 id 升序，每条一行：`#id 作者 [标签] 摘要`；标签见 §7.3，`summary` 为空时取 `content` 前 200 字符 | `listMessages({ limit: n })` |
| `/show <messageId>` | 单条消息全文及其 type、状态、target、引用、定向 agent | `getEventTree().messages` 中查找 |
| `/memory [category]` | 不带参数：各类别计数；带参数：该类条目 `#id [标签] 摘要` 列表。类别映射见 §7.3 | `getMemoryView` |
| 普通文本 | 作为人类消息发进当前房间（§7.1） | `postHumanMessage` |
| `/post <参数…> <正文>` | 带 type 等字段发消息（§7.1） | `postHumanMessage` |
| `/pause` | 暂停当前房间 | `pauseRoom` |
| `/resume [n]` | 先 `GET /api/rooms/:id` 校验：只有 `paused_limit`/`paused_manual` 可恢复，否则回复"房间未暂停"；`paused_limit` 未给 n 时回复"已达上限暂停的房间需要指定追加的 session 数：/resume <n>"；n 须为正整数 | `resumeRoom({ additionalSessions })` |
| `/confirm` | 确认完成当前房间（需二次确认） | `confirmCompletion` |
| `/terminate <sessionId>` | 终止当前房间某个 session（需二次确认） | `terminateAgentSession` |
| `/enable <agentId>`、`/disable <agentId>` | 启停 agent 派发（实例标识） | `setAgentEnabled` |
| `/newroom <参数…>` | 新建房间（§7.2），成功后设为当前房间 | `POST /api/rooms` |
| `/deleteroom <roomId>` | 删除已结束房间（需二次确认）；结果列出 `nativeDeleteFailures` | `DELETE /api/rooms/:id` |
| `/usage` | 每个 agent 与房间合计的 token（输入/输出/缓存读/缓存写）、费用、session 数；`costUsd` 为 null 显示"无费用数据"，并显示缺数据的 session 数 | `getUsageSummary` |
| `/report` | 任务分析报告的精简文本：房间行与每个 agent 行的 session 结果分布、完成率/错误率、总执行时长、token 合计与缓存命中率、步数、工具调用数与成功率；为 null 的指标显示"—" | `getRoomReport` |

未知命令回复"未知命令，见 /help"。

### 7.1 发消息

- **普通文本**：若以 `@<agentId>` 开头（后接空白），该 token 解析为 `targetAgentId`，其余为 `content`；否则全文为 `content`。不做 agentId 存在性的本地校验，由核心校验并返回错误。
- **`/post`**：正文前连续的 `key=value` token 为参数，第一个不符合该形式的 token 起为 `content`。值含空格时用双引号包住，`\"` 转义引号。

  | key | 映射 | 取值 |
  |---|---|---|
  | `type` | `type` | `MessageType` 之一 |
  | `target` | `targetMessageId` | 正整数，可带 `#` |
  | `refs` | `referencedMessageIds` | 逗号分隔正整数 |
  | `verdict` | `verifyVerdict` | `true` / `false` |
  | `closes` | `closesQuestion` | `true` / `false` |
  | `resolution` | `chainResolution` | `RESOLVED` / `UNRESOLVED` |
  | `summary` | `summary` | 字符串 |
  | `to` | `targetAgentId` | agent 实例标识 |

  未知 key、重复 key、取值格式不对时本地报错不发送；字段组合的语义校验全部交给核心（`06` §4 `postHumanMessage`），错误文案原样回复。`content` 为空时本地报错。
- 成功回复"已发送 #<messageId>"。

### 7.2 新建房间

`/newroom name=<名称> agents=<key,key,…> mode=<parallel|sequential> [max=<n>] [workdir=<路径>]`，参数语法同 `/post`。`name`、`agents`、`mode` 必填；`agents` 允许重复 key。机器人只做语法校验，其余校验与 workdir 解析由 `POST /api/rooms` 完成，错误文案原样回复。成功后回复房间信息，设为当前房间，并触发房间集合同步。

### 7.3 消息标签与记忆类别

消息标签由当前 `type` 与状态列组成（字段见 `01-storage.md` `Message`）：

| type | 标签 |
|---|---|
| `null` | 不显示标签 |
| `open_question` | `open_question/OPEN`；CLOSED 时为 `open_question/CLOSED·<questionCloseReason>`；房间首条消息另加`目标` |
| `chain` | `chain/<chainStatus>`；`closesQuestion` 为 true 时追加 `·closes→<chainResolution>` |
| `exploring` | `exploring/<exploringStatus>` |
| `verify` | `verify/通过` 或 `verify/不通过`（按 `verifyVerdict`） |
| 其他 | 只显示 type |

`/memory` 类别参数与 `MemoryViewPayload`（`02-memory-management.md` §5）分组的对应：`questions`→`openQuestions`（含 goal，计数时单列"其中目标 1"），`hypotheses`→`hypotheses`，`facts`→`facts`，`boundaries`→`boundaries`，`chains`→`chains`，`exploring`→`exploring`（计数按 `exploringStatus` 分为 active/completed 两项），`proposals`→`completionProposals`，`challenges`→`challenges`，`verifies`→`verifies`。

## 8. 二次确认与内联按钮

`/confirm`、`/terminate`、`/deleteroom` 不直接执行，而是回复一条带"确认 / 取消"内联按钮的确认消息。`callback_data` 全部取值：

| callback_data | 来源 | 行为 | 过期 |
|---|---|---|---|
| `use:<roomId>` | `/rooms` 的"使用"按钮 | 同 `/use <roomId>` | 不过期 |
| `ask:<roomId>` | `propose_completion` 提醒的"确认完成…"按钮 | 发送一条与 `/confirm` 相同的确认消息（不直接执行） | 不过期 |
| `confirm:<roomId>` | 确认消息的"确认" | `confirmCompletion` | 10 分钟 |
| `terminate:<roomId>:<sessionId>` | 确认消息的"确认" | `terminateAgentSession` | 10 分钟 |
| `delete:<roomId>` | 确认消息的"确认" | `DELETE /api/rooms/:id` | 10 分钟 |
| `cancel` | 确认消息的"取消" | 不执行任何操作 | 不过期 |

- 收到 callback 先按 §3 校验，再 `answerCallbackQuery`。确认消息无论执行成功、失败还是取消，都把原消息编辑为结果文本并移除按钮，防止重复点击；`use`/`ask` 按钮保留，可重复点击。
- 标为 10 分钟的按钮以原消息的 `date` 判断，超时点击时把原消息编辑为"已过期，请重新执行命令"并移除按钮，不执行。
- `callback_data` 明确携带 `roomId`，不依赖点击时的当前房间；最长取值远小于 Telegram 的 64 字节限制。
- 执行时房间状态已不允许该操作（例如房间已被确认完成）时，由编排器返回错误，错误文案原样作为结果文本。

## 9. 输出格式

- 使用 `parse_mode: 'HTML'`，所有来自编排器的文本先转义 `&`、`<`、`>`；只用 `<b>`、`<code>`、`<pre>`。
- 长度按转义后、实际发送的文本计算。超过 4000 字符时按行切分为多条依次发送；HTML 标签不跨行使用，所以按行切分不会切断标签。`<pre>` 块是唯一允许跨行的标签，切分落在 `<pre>` 内时，在当前片段末尾补 `</pre>`、在下一片段开头补 `<pre>`。单行超长时在转义实体之外硬切。
- 时间显示为本机时区的 `HH:mm`（当天）或 `MM-DD HH:mm`；"已运行时长"按 `sessionStartedAt` 计算为 `Xm Ys`。
- 作者显示：`human` 显示"人类"，`system` 显示"系统"，其余显示实例标识。

## 10. 异常与运行

- Telegram `getUpdates` 失败：打印错误，3 秒后重试；`409 Conflict`（另一实例在轮询）打印"同一 token 已有其他实例在运行"后退出。
- 处理单个 update 抛出的异常被捕获并回复"内部错误"，不影响后续 update；`offset` 在处理完成后推进，处理中崩溃重启会重复处理至多一个 update。
- 编排器不可达不影响 Telegram 轮询；命令回复"编排器不可达"，监视连接按 §5.2 退避重连。
- 收到 SIGINT/SIGTERM：停止轮询、关闭全部 WS 后退出。

## 11. 对外依赖

```typescript
// 编排器对外接口（06-orchestrator-api.md）
REST: GET/POST /api/rooms, GET/DELETE /api/rooms/:id, GET /api/agents
房间 WS RPC: listMessages, postHumanMessage, getMemoryView, getRoomStatus, getEventTree,
  getUsageSummary, getRoomReport, terminateAgentSession, setAgentEnabled,
  pauseRoom, resumeRoom, confirmCompletion
房间 WS 推送: newMessage, roomStatus, roomDeleted（memoryUpdate 忽略）

// Telegram Bot API
getUpdates, sendMessage, editMessageText, answerCallbackQuery, setMyCommands
```
