# 存储层设计

SQLite（WAL 模式），`better-sqlite3` 原生 SQL，不引入 ORM。`rooms`/`session_events` 使用 SQLite 自增整数主键；`sessions` 用 room 内自增 `seq`；`messages` 也用 **room 内自增 `id`**——消息编号只在所属 room 内有意义，不是全库唯一（与 `sessionId` 同理，见 `00-overview.md`）。单机工具，安全性不是考量，以简洁为先。

建连接时执行 `PRAGMA foreign_keys = ON`（SQLite 默认关闭），`rooms`/`rooms.room_id` 等 `REFERENCES` 才真正生效，级联/删除顺序必须按依赖排列（见第 4 节 `deleteRoom`）。注意：消息的 `target_message_id` / `referenced_message_id` **不加**复合外键——SQLite 的自引用复合外键在「被引用 id 恰等于本行 id」时会被本行自身满足，无法可靠强制同 room（见第 2 节），改由调用方的 room 内查找保证。

## 1. Schema

### rooms

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK AUTOINCREMENT | |
| name | TEXT NOT NULL | 创建时填写的简短标题，仅用于列表展示 |
| scheduling_mode | TEXT NOT NULL DEFAULT 'sequential' | v1 只有 `'sequential'`，字段为未来 `'parallel'` 预留 |
| status | TEXT NOT NULL DEFAULT 'active' | `active` / `paused_limit`（触及上限自动暂停） / `paused_manual`（人类主动暂停） / `completed` |
| completion_reason | TEXT | 仅 `status='completed'` 后有值；`'manual'`（人工调用 `confirmCompletion`）/ `'auto_silence'`（`auto_confirm_on_silence` 开启、房间进入稳定态后自动确认，见 `03-orchestrator-core.md` §1.4） |
| completion_reference_message_id | INTEGER | 仅 `completion_reason='auto_silence'` 时有值；记录触发自动确认时房间内 id 最大的那条 `propose_completion` 消息 id |
| max_sessions | INTEGER NOT NULL | 创建时写入，缺省 **20**（见下方"开放决策"），触及上限后 `resumeRoom(additionalSessions)` 会增加此值 |
| workdir | TEXT NOT NULL DEFAULT '' | 该 room 的工作目录（创建时解析而成的**绝对路径**）。空串表示"按服务端默认目录"解析（`VIOLETDAGGER_WORKDIR` 或 server 进程 cwd）——只为历史数据/缺省兜底，新建 room 一律写入具体路径 |
| auto_confirm_on_silence | INTEGER NOT NULL DEFAULT 0 | 创建时一次性写入的开关（0/1）；房间生命周期内不可修改，没有对应的运行期修改接口。开启后，房间进入"无待派发 agent、无 running/stopping session、且房间内最新一条信号类消息是 `propose_completion`"的稳定态时自动确认收尾（见 `03-orchestrator-core.md` §1.4） |
| created_at | TEXT NOT NULL | ISO8601 |

### room_agents

| 列 | 类型 | 说明 |
|---|---|---|
| room_id | INTEGER NOT NULL REFERENCES rooms(id) | |
| agent_id | TEXT NOT NULL | **agent 实例标识**（见 `00-overview.md`"agent 实例标识"）：该 agent 只加入一次时等于注册表 key（如 `"codex"`），加入多次时为 `"codex-1"`/`"codex-2"`……。不是外键（注册表是配置文件不是表） |
| registry_key | TEXT NOT NULL | 该实例对应的 `agents.config.json` 注册表 key（如 `"codex"`）。查注册表配置一律用这一列，不从 `agent_id` 反解后缀 |
| join_order | INTEGER NOT NULL | 加入房间的顺序，决定派发优先级（3.3："按固定顺序（agent 加入房间的顺序）"）；多个实例各自占一个位置 |
| state | TEXT NOT NULL DEFAULT 'idle' | `idle` / `running` / `stopping`。`passed`/`errored` 不是持久状态，只是某次 session 的 outcome（见下），该 session 结束后 agent 状态直接回 `idle` |
| current_session_seq | INTEGER | `running`/`stopping` 时必须非空，指向 `sessions.seq`（room 内），供 `terminateAgentSession` 和详情查看定位 |
| dispatch_enabled | INTEGER NOT NULL DEFAULT 1 | 是否参与派发。`1`=启用（默认），`0`=停用——人类手动停用，或连续失败达到阈值后由核心自动停用（见 `03-orchestrator-core.md` §6）。停用只阻止后续派发，不终止正在运行的 session，也不自动恢复 |

主键：`(room_id, agent_id)`

**实例标识的生成**：由 `createRoom(name, agentIds, schedulingMode)` 按传入的 `agentIds` 数组（这里装的是注册表 key，允许重复，顺序即 `join_order`）计算：对每个注册表 key 统计出现次数，只出现一次时实例标识就是该 key，出现多次时按出现顺序编号 `"<key>-1"`/`"<key>-2"`……。若算出的实例标识与本次传入的其它 key 或实例撞名，`createRoom` 抛错（正常注册表 key 不含这种 `-<数字>` 尾部，属于防御性校验）。

### sessions

| 列 | 类型 | 说明 |
|---|---|---|
| room_id | INTEGER NOT NULL REFERENCES rooms(id) | |
| seq | INTEGER NOT NULL | **room 内自增**的 sessionId（不是每个 agent 各自计数，也不是跨 room 全局，见 `00-overview.md`） |
| agent_id | TEXT NOT NULL | agent 实例标识（见 `room_agents.agent_id`） |
| outcome | TEXT NOT NULL DEFAULT 'running' | `running` / `stopping`（人工终止中、尚未确认退出） / `completed`（自然正常结束，且有实质消息） / `passed`（自然正常结束，无实质消息） / `error` / `terminated`（人类强制终止） |
| started_at | TEXT NOT NULL | |
| ended_at | TEXT | 结束前为空 |
| pgid | INTEGER | 进程组 id，spawn 成功后回填；spawn 失败则为空、outcome 直接是 `error` |
| raw_log_path | TEXT | stdout/stderr JSONL 日志路径，含 offset/stream/text；仅用于查看回放，历史文本兼容见 04 |
| exit_code | INTEGER | 进程退出码，尚未退出/未知为 NULL |
| exit_signal | TEXT | 实际退出信号，可能是系统主动清理所致，未知为 NULL |
| stop_intent | TEXT | NULL / terminate；人工 terminate 优先，终态后不可改写 |
| cleanup_started_at | TEXT | 首次实际清理开始时间，尚未开始为 NULL |
| exit_cause | TEXT | natural / managed-stop / unexpected / spawn-failed / not-started，尚未确认退出为 NULL |
| input_tokens | INTEGER | 用量统计，见 `04-agent-invocation.md` §7；该 agent 未提供或未结束为 NULL，不用 0 占位 |
| output_tokens | INTEGER | 同上 |
| cache_read_tokens | INTEGER | 同上 |
| cache_write_tokens | INTEGER | 同上 |
| cost_usd | REAL | 同上；只信任 agent CLI 自己报出的美元费用，不做任何定价表估算（如 codex 只有 token 没有费用字段，这里就是 NULL） |
| dispatch_scope | TEXT NOT NULL DEFAULT 'broadcast' | `'broadcast'`（因广播触发型消息派发）/ `'directed'`（因定向给它的 @ 消息派发，见需求 3.3.2）；`createSession` 时由核心按本次派发依据写入，不可事后修改 |

主键：`(room_id, seq)`。`messages.session_seq` 通过 `(room_id, session_seq)` 复合外键引用本表。

### session_events

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK AUTOINCREMENT | 事件稳定排序键 |
| room_id | INTEGER NOT NULL | 与 session_seq 组成外键引用 sessions(room_id, seq) |
| session_seq | INTEGER NOT NULL | 所属固定 session |
| kind | TEXT NOT NULL | cleanup_started / sigterm_sent / sigkill_sent / cleanup_failed / terminate_requested / process_exited / terminated |
| attempt_id | TEXT NOT NULL DEFAULT '' | 清理事件使用 cleanupAttemptId；其他一次性事件为空串 |
| detail | TEXT | 可选说明，不含凭据、prompt 或终端正文 |
| created_at | TEXT NOT NULL | ISO8601 |

事件只追加，不进入 messages 或任何记忆查询。按 (room_id, session_seq, id) 建索引，按 id 升序读取。一次性事件以 (room_id, session_seq, kind, attempt_id) 唯一约束防重复；人工终止与实际退出可各留一条记录；清理重试使用新的 attempt_id，保留每次信号及失败事件。删除 room 时随 session 级联清理。

### messages

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER NOT NULL | **room 内自增**（不是全库唯一）；与 `room_id` 组成主键 `(room_id, id)`。由 `insertMessage` 在同一事务内按 `SELECT COALESCE(MAX(id),0)+1 FROM messages WHERE room_id=?` 生成；room 删除后新建 room 从 1 重新计数。`targetMessageId`/`referencedMessageIds` 引用的就是同一 room 内的这个 id |
| room_id | INTEGER NOT NULL REFERENCES rooms(id) | |
| session_seq | INTEGER | 人类消息为空；agent 消息必填，`(room_id, session_seq)` 引用 `sessions` |
| author_id | TEXT NOT NULL | agent 实例标识（见 `room_agents.agent_id`），或保留值 `"human"` / `"system"` |
| type | TEXT | 可空；`fact`/`hypothesis`/`boundary`/`open_question`/`chain`/`exploring`/`propose_completion`/`endorse`/`challenge`/`verify`；为空即纯聊天，不进任何记忆层 |
| content | TEXT NOT NULL | 写入后永不修改 |
| summary | TEXT NOT NULL | 写入时计算好落盘（未显式提供则自动截断 `content`），供 `get_overview` 快速读取，不在读时现算 |
| target_message_id | INTEGER | 可空；同 room 消息 ID；reaction 必填，hypothesis 必填且目标为问题，fact 可选且目标为问题，open_question 可选追问 |
| target_agent_id | TEXT | 可空；agent 实例标识（见 `room_agents.agent_id`）。只有人类消息可能非空（由调用方在写入前校验，见 `06-orchestrator-api.md`），非空表示这条消息通过 @ 定向发给该 agent，见需求 3.3.2 |
| exploring_status | TEXT | 仅 exploring 使用；允许一次 active → completed，并同时写入结束信息 |
| exploring_note | TEXT | 配合 `exploring_status` 变更时的系统备注（如"人类强制终止"） |
| exploring_end_reason | TEXT | explicit / superseded / human_terminated；历史未知为 NULL |
| exploring_result_summary | TEXT | 主动完成时的结果摘要，允许描述无结论；历史未记录为 NULL |
| exploring_result_message_ids | TEXT NOT NULL DEFAULT '[]' | 结果消息 ID 的 JSON 数组，同 room |
| created_at | TEXT NOT NULL | |

主键：`(room_id, id)`。

### message_references

服务所有有类型消息的 `referencedMessageIds`：

| 列 | 类型 |
|---|---|
| room_id | INTEGER NOT NULL | 所属 room（所有引用必须同 room，由调用方保证） |
| message_id | INTEGER NOT NULL | 发起引用的消息（room 内 id） |
| referenced_message_id | INTEGER NOT NULL | 被引用的消息（同 room 内 id） |

主键：`(room_id, message_id, referenced_message_id)`。不加外键，理由同 `target_message_id`（见第 1、2 节）。

### 索引

- 主键 `messages(room_id, id)` 自带——`listMessages` 游标分页（游标即 room 内 `id`，房间内按 `id` 排序等价于按时间顺序）
- `messages(room_id, type)`——`get_overview`/`get_detail` 按类型查
- `messages(room_id, session_seq)`——`getMessagesBySession` 取某个 session 的消息（SessionDetailModal 详情视图与编排器核心判断该 session 是否产出过实质消息用）
- `messages(room_id, target_message_id)`——查某条消息挂载的所有 reaction/追问
- `messages(room_id, target_agent_id)`——定向触发判定用（`getLatestDirectedMessage`，见 `03-orchestrator-core.md` §1.2）

## 2. 不变量（在存储层函数内部强制，不暴露裸的 UPDATE 接口）

- **只追加不覆盖**：`type`/`content` 一旦写入永不修改；没有通用的"更新消息"接口，只有 `insertMessage` 和专用的 `completeExploring`。
- **`exploring` 自动顶替**：`insertMessage` 遇到 `type='exploring'` 时，在同一事务内先把该 `(room_id, author_id)` 下现有 `active` 的 exploring 消息标记为 `completed`，再插入新记录；返回值里的 `supersededExploringId` 就是被顶替那条消息的 id，供调用方据此 emit `memoryUpdate` 推送（否则前端不知道那条旧消息状态变了）。
- **`sessionId` 由调用方（编排器核心/MCP Server）显式传入 `insertMessage`**，存储层本身不做绑定推断（推断逻辑属于 MCP Server，见 `05-mcp-server.md`）；人类消息传 `session_seq = null`。
- 所有返回 `Message`/`Message[]` 的读取函数（`getMessageById`/`getFirstMessage`/`getMessagesBySession`/`listMessages`/`getMessagesByType`/`getActiveExploring`/`getRecentRawMessages`/`getAnnotations`）都会联表 `message_references` 填充 `referencedMessageIds`，不需要单独的 `getMessageReferences` 函数。
- **引用同一性由调用方的 room 内查找保证**：消息 id 是 room 内编号，调用方只能用 `getMessageById(roomId, id)` 解析 `targetMessageId`/`referencedMessageIds`——跨 room 的 id 在这个 room 内查不到，天然被拒。`05-mcp-server.md` 的 `post_message`、`06-orchestrator-api.md` 的 `postHumanMessage` 都必须在写入前做这一校验并给出清晰的业务错误。存储层不做跨 room 校验，也不加自引用复合外键（原因见第 1 节）。
- **定向 session 的产出不参与跨-agent 派发/收尾判定**：`dispatch_scope='directed'` 的 session 里产出的消息，正常写入 `messages`、正常进入记忆与事件树，但 `getLatestDispatchTriggerAt`（03 §1.2"待派发"）与 `getLatestMessageByTypes`（03 §1.4 静默收敛判定）在计算时都排除这些消息——它们只对触发这次定向 session 的那个 agent 有意义，不影响其他 agent 或房间级别的自动化判定。

## 3. 类型定义（TypeScript）

```typescript
interface Room {
  id: number;
  name: string;
  schedulingMode: 'sequential';
  status: 'active' | 'paused_limit' | 'paused_manual' | 'completed';
  completionReason: 'manual' | 'auto_silence' | null;         // 仅 status === 'completed' 有值
  completionReferenceMessageId: number | null;                // 仅 completionReason === 'auto_silence' 有值
  maxSessions: number;
  workdir: string;   // 绝对路径；空串表示按服务端默认目录解析（历史数据）
  autoConfirmOnSilence: boolean;   // 创建时一次性写入，房间生命周期内不可修改
  createdAt: string;
}

interface RoomSummary {
  id: number;
  name: string;
  status: Room['status'];
  createdAt: string;
}

interface RoomAgentState {
  roomId: number;
  agentId: string;          // 实例标识
  registryKey: string;      // 对应 agents.config.json 的 key
  joinOrder: number;
  state: 'idle' | 'running' | 'stopping';
  currentSessionSeq: number | null;
  dispatchEnabled: boolean; // 是否参与派发（见 room_agents.dispatch_enabled）
}

interface Session {
  roomId: number;
  seq: number;
  agentId: string;
  outcome: 'running' | 'stopping' | 'completed' | 'passed' | 'error' | 'terminated';
  startedAt: string;
  endedAt: string | null;
  pgid: number | null;
  rawLogPath: string | null;
  exitCode: number | null;
  exitSignal: string | null;
  stopIntent: 'terminate' | null;
  cleanupStartedAt: string | null;
  exitCause: 'natural' | 'managed-stop' | 'unexpected' | 'spawn-failed' | 'not-started' | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
  dispatchScope: 'broadcast' | 'directed';
}

interface SessionUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
}

interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;          // 参与聚合的 session 里一个费用数据都没有时为 null；否则是已知费用之和（不含缺失的部分）
  sessionCount: number;            // 参与聚合的已结束 session 数
  sessionsWithoutTokens: number;   // 四个 token 字段全为 NULL 的 session 数（如 kimi）
  sessionsWithoutCost: number;     // cost_usd 为 NULL 的 session 数（如 codex、kimi）
}

interface SessionEvent {
  id: number; roomId: number; sessionSeq: number;
  kind: 'cleanup_started' | 'sigterm_sent' | 'sigkill_sent' | 'cleanup_failed'
      | 'terminate_requested' | 'process_exited' | 'terminated';
  attemptId: string;
  detail: string | null;
  createdAt: string;
}

type RoomStatus = Room['status'];
type SessionOutcome = Session['outcome'];

type MessageType =
  | 'fact' | 'hypothesis' | 'boundary' | 'open_question' | 'chain'
  | 'exploring' | 'propose_completion' | 'endorse' | 'challenge' | 'verify';

interface Message {
  id: number;                      // room 内自增，仅在本 room 内有意义
  roomId: number;
  sessionSeq: number | null;       // 人类消息为 null
  authorId: string;                 // agent 实例标识，或 "human"/"system"
  type: MessageType | null;
  content: string;
  summary: string;
  targetMessageId: number | null;
  targetAgentId: string | null;    // 非空表示这条消息通过 @ 定向发给该 agent（见需求 3.3.2），只有人类消息可能非空
  referencedMessageIds: number[];  // 有类型消息的依据引用，从 message_references 联表得到
  exploringStatus: 'active' | 'completed' | null;  // 仅 type='exploring' 有意义
  exploringNote: string | null;
  exploringEndReason: 'explicit' | 'superseded' | 'human_terminated' | null;
  exploringResultSummary: string | null;
  exploringResultMessageIds: number[];
  createdAt: string;
}

interface InsertMessageParams {
  roomId: number;
  sessionSeq: number | null;
  authorId: string;
  content: string;
  type?: MessageType;
  targetMessageId?: number;
  targetAgentId?: string;
  referencedMessageIds?: number[];
  summary?: string;
}
```

## 4. 对外接口（TypeScript 签名，供编排器核心 / MCP Server / 编排器对外接口调用）

```typescript
// Room
interface CreateRoomOptions {
  maxSessions?: number; // 正整数，不传用默认值 20（见 §5.1）；非正整数抛错
  workdir?: string;     // 绝对路径（由调用方解析/校验，见 06；存储层只负责落盘）
  autoConfirmOnSilence?: boolean; // 不传按 false；一次性写入 rooms.auto_confirm_on_silence，房间生命周期内不可修改，不提供对应的 setter（见 §1、§5.6）
}
function createRoom(name: string, agentIds: string[], schedulingMode: 'sequential', options?: CreateRoomOptions): Room;
// agentIds 装的是注册表 key 列表（允许重复）；createRoom 内部按上文规则生成实例标识写入 room_agents.agent_id，并写入 registry_key 与 join_order（数组顺序）
// workdir 缺省写 ''（读出来由 agent 调用层按服务端默认目录兜底）
function getRoom(roomId: number): Room | null;
function listRooms(): RoomSummary[];
function setRoomStatus(roomId: number, status: RoomStatus): void;
function recordCompletion(roomId: number, reason: 'manual' | 'auto_silence', referenceMessageId?: number): void;
// 事务内 setRoomStatus(roomId, 'completed') + 写 completion_reason/completion_reference_message_id（manual 路径不传 referenceMessageId，列保持 NULL）。
// confirmCompletion（人工路径）与静默收敛自动确认（03-orchestrator-core.md §1.4）都只通过这一个函数落盘 completed 状态，不各自维护一份 setStatus 调用
function increaseMaxSessions(roomId: number, additional: number): void;
function deleteRoom(roomId: number): void;
// 级联删除该 room 的全部数据，单个事务内按依赖顺序执行：
//   message_references(room_id) → messages(room_id)
//   → session_events(room_id) → sessions(room_id) → room_agents(room_id) → rooms(id)
// 只删数据库记录，不碰磁盘文件（日志/prompt 由 04-agent-invocation.md 的 deleteRoomArtifacts 负责）

// Room agents / 调度状态
function getRoomAgents(roomId: number): RoomAgentState[];
function setAgentState(roomId: number, agentId: string, state: 'idle' | 'running' | 'stopping', sessionSeq?: number): void;
function setAgentEnabled(roomId: number, agentId: string, enabled: boolean): void; // 只改 dispatch_enabled

// Session
function createSession(roomId: number, agentId: string, dispatchScope: 'broadcast' | 'directed'): Session; // seq 在此自增；dispatchScope 由调用方（checkAndDispatch）按 03 §1.2 的判定结果传入
function setSessionPgid(roomId: number, seq: number, pgid: number): void;
function setSessionRawLogPath(roomId: number, seq: number, rawLogPath: string): void;
// session 启动、日志文件路径确定后立即写入 raw_log_path：这样"运行中 session 的只读日志快照回放"
// （06-orchestrator-api.md §2.1 的 mode=replay）与 getSessionDetail.rawLog 在 session 结束前就能读到当前日志；
// finishSession 结束时仍会以最终路径写入（正常即同一路径）
function finishSession(roomId: number, seq: number,
  outcome: Exclude<SessionOutcome, 'running' | 'stopping'>, rawLogPath?: string,
  exit?: { exitCode: number | null; signal: string | null; exitCause: Session['exitCause'] },
  usage?: SessionUsage): void;
// usage 由 04-agent-invocation.md §7 从完整落盘的日志解析得到；spawn-failed/not-started 没有日志可读，不传即可，五个字段落 NULL
function markSessionTerminating(roomId: number, seq: number): { changed: boolean; session: Session };
function markSessionCleanupStarted(roomId: number, seq: number, attemptId: string): void;
function appendSessionEvent(roomId: number, seq: number, kind: SessionEvent['kind'], detail?: string, attemptId?: string): void;
function listSessionEvents(roomId: number, seq: number): SessionEvent[];
function getSession(roomId: number, seq: number): Session | null;
function listSessions(roomId: number): Session[]; // 按 seq 升序，供事件树给每条消息的 session 标签查出 outcome/起止时间（见 07-frontend.md §9）
function getLatestSessionStartedAt(roomId: number, agentId: string): string | null; // 该 agent 最近一次 session 的 started_at，供核心判定"待派发"（03 §1.2）；从没跑过为 null
function countSessions(roomId: number): number; // 计入 maxSessions 上限的 session 数 = 本 room 中 outcome != 'error' 的数量（error 不占配额；session 的 seq 仍由 createSession 内部 MAX(seq)+1 生成）
function getUsageTotals(roomId: number): { byAgent: Record<string, UsageTotals>; room: UsageTotals };
// 只统计已结束的 session（outcome 非 running/stopping）——还在跑的 session 用量没定，不计入，也不算"缺数据"。
// costUsd 只累加非 NULL 的部分，不把 NULL 当 0；sessionsWithoutTokens/sessionsWithoutCost 让调用方能诚实标"不完整"，
// 而不是让部分 agent（如 codex 没有费用、kimi 什么都没有）拖低总量却看不出来。

// Message
function insertMessage(params: InsertMessageParams): { message: Message; supersededExploringId: number | null };
// 含 exploring 自动顶替（若这次插入顶替了该 author 之前 active 的 exploring 消息，返回被顶替消息的 id，供调用方 emit memoryUpdate 推送；否则为 null）、summary 自动截断
function getMessageById(roomId: number, id: number): Message | null;
function getFirstMessage(roomId: number): Message | null; // room 内 id 最小的一条消息，供记忆管理层 buildOverview.goal 使用
function getMessagesBySession(roomId: number, seq: number): Message[]; // 按 session 取消息，供 SessionDetailModal（getSessionDetail）渲染该 session 的消息列表，也用于编排器核心判断该 session 是否产出过实质消息
function listMessages(roomId: number, cursor?: number, limit?: number): { messages: Message[]; nextCursor: number | null };
function getMessagesByType(roomId: number, type: MessageType): Message[];
function getActiveExploring(roomId: number): Message[];
function getRecentRawMessages(roomId: number, n: number): Message[];
function completeExploring(roomId: number, messageId: number, note?: string, result?: { resultSummary: string; resultMessageIds?: number[] }): void;
function getAnnotations(roomId: number, messageId: number): Message[]; // 挂在它上面的 endorse/challenge/verify/追问（room 内 id）
function getRoomMessages(roomId: number): Message[]; // 批量读取 room 全部消息（含 referencedMessageIds 联表），供记忆投影一次性建表，避免逐条查询
function getLatestDispatchTriggerAt(roomId: number, excludeAuthorId: string, triggerTypes: MessageType[]): string | null; // 触发型消息（author_id='human' 或 type ∈ triggerTypes，且非 excludeAuthorId 发出）的最新 created_at，供核心判定"待派发"（03 §1.2）；排除 target_agent_id IS NOT NULL 的消息（定向给别人的）与归属 dispatch_scope='directed' session 的消息（定向 session 的产出，见需求 3.3.2）
function getLatestDirectedMessage(roomId: number, targetAgentId: string): Message | null; // 该 agent 作为 target_agent_id 的最新一条消息（按 id 取最新，不比较时间戳，由调用方结合 getLatestSessionStartedAt 判定"待派发"，见 03 §1.2）；不存在返回 null
function getLatestMessageByTypes(roomId: number, types: MessageType[]): Message | null; // 房间内 type ∈ types 里 id 最大的一条消息，不排除任何 author、不比较时间戳（但排除 dispatch_scope='directed' session 的产出，原因同上）；供静默收敛自动确认判定"最新一条信号类消息是不是 propose_completion"用（03 §1.4），跟 getLatestDispatchTriggerAt（逐 agent 判定"待派发"）用途不同、不复用
function validateMessageRelations(roomId: number, params: Pick<InsertMessageParams, 'type' | 'targetMessageId' | 'referencedMessageIds'>): void; // hypothesis 目标须为 open_question、fact 目标若给须为 open_question、reaction 目标必填；拒绝未知 type；引用 ID 去重并校验同 room 存在；无类型消息不接受 referencedMessageIds。MCP 与人类 RPC 共用
```

## 5. 开放决策

### 5.1 `max_sessions`：创建时可选、默认 20

**（已更新）** 建房间时现在可以指定 session 总数上限（需求 3.1/3.3/3.5/7 已相应改写）：`POST /api/rooms` 接受可选 `maxSessions`（正整数），透传给 `createRoom` 写入 `rooms.max_sessions`；**不传时用服务端默认值 20**。非法值（非正整数）在建房间时拒绝。创建后不能直接改，只能用 `resumeRoom(additionalSessions)` 追加。默认值仍可通过服务端配置调整，不影响 schema。

### 5.2 消息 id 类型与需求文档字面不一致

需求与设计的消息 ID 均使用 number（room 内自增）；targetMessageId 和 referencedMessageIds 使用同一 room 内 ID。

### 5.3 状态与迁移

agent.state 为 idle/running/stopping，后两者必须保留 currentSessionSeq。session.outcome 中 running/stopping 是非终态，endedAt 为空；completed/passed/error/terminated 为终态。passed/error 不作为 agent 的持久状态。

markSessionTerminating 在事务内将 stopIntent 设为 terminate、状态置 stopping 并记录请求；只在确认主进程退出或从未启动后写 terminated。自然退出从 running 直接结算。核心事务组合 finishSession、追加事件与条件释放 agent；只清理 currentSessionSeq 等于本 seq 的占位。cleanupStartedAt 及尝试事件记录人工清理，失败保留占位，条件更新保证一次结算。

既有数据库新增可空清理/退出字段、`room_agents.dispatch_enabled` 与 session_events；状态 CHECK 若存在需扩展 `stopping`。历史记录不伪造事件，不删除已有消息。凭据仅运行时管理，不落入本表。

### 5.4 工作目录 `workdir`

新增：room 创建时可指定 `workdir`——该房**所有 agent CLI 的 spawn cwd**。不填时默认取服务端配置 `VIOLETDAGGER_WORKDIR`，再退回 server 进程 cwd。**路径解析/校验（`~` 展开、绝对化、必须存在且是目录）与默认值求值放在编排器对外接口层（`06`）**，存储层只落盘解析后的绝对路径；agent 调用层（`04`）spawn 时读 `room.workdir`，为空串则回退 `VIOLETDAGGER_WORKDIR`/cwd。`workdir` 只是给进程设 cwd，**不是工作区隔离**（需求第 1/8 节）；多个 room 可指向同一目录。

### 5.5 消息 id 改为 room 内自增（不兼容旧库）

**（已更新）** 消息 `id` 从"全库自增、全库唯一"改为"room 内自增"（见 §1）：`messages` 主键为 `(room_id, id)`。动机：与 `sessionId` 语义统一；`#N` 更小、更可读；跨 room 的 id 歧义消失。引用同一性由调用方（`05` 的 `post_message`、`06` 的 `postHumanMessage`）用 room 内查找（`getMessageById(roomId, id)`）强制。

**不兼容旧库、不做数据迁移（已确认）**：升级时若检测到旧 schema（`messages.id` 为单列主键，即没有 `(room_id, id)` 复合主键），**直接重建整个数据库**——清空 `rooms`/`room_agents`/`sessions`/`session_events`/`messages`/`message_references` 全部数据，按 §1 的 schema 重新建表；旧数据不迁移、不保留。本地单机工具，接受这一取舍。

### 5.6 `auto_confirm_on_silence`：建房时一次性开关，不支持运行期修改

`POST /api/rooms` 的可选参数，默认 `false`。选择"只能建房时定、房间中途不能开关"而不是提供 `setAutoConfirmOnSilence` 之类的运行期接口：这个开关改变的是"任务收尾要不要人工点头"这条安全边界，中途切换会让同一个房间在生命周期内出现"前半段必须人工确认、后半段可能被自动确认掉"的不一致语义，也会引入"打开开关那一刻房间恰好已经处于稳定态该不该立刻补一次确认"这类边界判断。建房时定死，避免这些问题；确实需要不同的收尾策略就新建一个房间。具体自动确认的判定逻辑见 `03-orchestrator-core.md` §1.4。

`id` **不使用 `AUTOINCREMENT`**：在 `insertMessage` 的事务内用 `MAX(id)+1` 生成，保证 room 内连续编号。

## 记忆连续性修订（2026-09-19）

messages 增加 exploring_end_reason TEXT、exploring_result_summary TEXT、exploring_result_message_ids TEXT NOT NULL DEFAULT '[]'（JSON 数组）。Message 对应 exploringEndReason、exploringResultSummary、exploringResultMessageIds。旧库只补列，不推测回填、不删除历史。completeExploring(roomId, messageId, note?, result?) 的 result 为 { resultSummary, resultMessageIds? }；仅 active 可转 completed，结果与状态事务写入一次，explicit/human_terminated 分别由结果/系统 note 决定；自动顶替记录 superseded。引用数组机械去重。批量读取消息和 message_references，供共享记忆投影建立反向关系。新写入的 hypothesis 目标必须是问题；fact 目标若提供也必须是问题；reaction 必须有目标。MCP 和人类 RPC 共用校验，历史读取不套用新写入约束。

## 用量统计修订（2026-09-21）

`sessions` 新增 `input_tokens`/`output_tokens`/`cache_read_tokens`/`cache_write_tokens`/`cost_usd` 五个可空列，`finishSession` 新增可选 `usage` 参数一次性写入；旧库补列全部为 NULL，不推测回填（这五列在这个功能上线前从未被采集过，NULL 就是唯一诚实的初值）。新增 `getUsageTotals(roomId)` 按 agent 和整个房间两级聚合，只统计已结束的 session，明确区分"没有费用数据"和"费用是 0"，也明确统计参与聚合但缺数据的 session 数（`sessionsWithoutTokens`/`sessionsWithoutCost`），供上层（`06-orchestrator-api.md` 的 `getUsageSummary`）如实展示"不完整"而不是让空值悄悄拉低总量。解析逻辑本身（从日志 JSON 提取这几个数字）属于 `04-agent-invocation.md` §7，存储层只负责落盘和聚合。

## @ 定向消息修订（2026-09-22）

`messages` 新增可空 `target_agent_id`（agent 实例标识，只有人类消息可能非空），`sessions` 新增 `dispatch_scope`（`'broadcast'` / `'directed'`，`createSession` 时写入且不可事后修改）。`createSession` 签名新增必填的 `dispatchScope` 参数。`getLatestDispatchTriggerAt`/`getLatestMessageByTypes` 都排除"定向给别人的消息"与"`dispatch_scope='directed'` session 的产出"，新增 `getLatestDirectedMessage(roomId, targetAgentId)` 供核心判定定向"待派发"。旧库补列：`target_agent_id` 为 NULL、`dispatch_scope` 默认 `'broadcast'`，不推测回填历史 session 的定向归属。动机与派发算法细节见 `03-orchestrator-core.md` 的同名修订、需求 3.3.2。
