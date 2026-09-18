# 记忆管理设计

存储层（`01-storage.md`）之上、其余模块之下的一层：定义"记忆"这个概念本身——有哪些类型、什么规则、怎么读——并把存储层的原始查询组装成 `get_overview`/`get_detail`/`getMemoryView` 需要的具体形状。三个消费方——Agent 调用适配层（预渲染派发 prompt）、MCP Server（`get_overview`/`get_detail` 工具）、编排器对外接口（`getMemoryView` RPC）——都调用这一层，而不是各自实现一遍组装逻辑。

## 1. 记忆类型定义（对应需求 4.3）

| type | 含义 | 特殊字段要求 | 可变性 |
|---|---|---|---|
| （不传）| 纯聊天/过渡性发言，只出现在原始消息流里，不进入任何记忆层 | 无 | `content` 永不改写 |
| `fact` | 已确认的事实 | 无 | 不可变 |
| `hypothesis` | 针对某个 `open_question` 提出的候选答案，尚无定论 | 无 | 不可变 |
| `boundary` | 已确认走不通的路径/死胡同 | 无 | 不可变 |
| `open_question` | 尚无人给出候选答案的空白问题 | `targetMessageId` 可选（表示"追问"某条具体消息，而非全新问题） | 不可变 |
| `chain` | 一条从输入到输出的候选端到端方案；可多条并存，**没有系统自动裁定的"当前最优"**——所有 chain 一律平等地列出摘要，由 agent/人类自己判断取舍 | `referencedMessageIds` 可选（标注依赖了哪些 fact/hypothesis 等消息，不填就只在 `content` 里用文字描述） | 不可变 |
| `exploring` | 某个 agent 正在探索某方向的状态广播（用于防止重复劳动） | 无（`authorId` 决定归属） | **唯一有状态的类型**——`exploringStatus: active \| completed` 可事后修改，规则见第 2 节 |
| `propose_completion` | agent 认为任务可以结束了，发出的一次性信号；只触发前端提醒，不自动结束房间——只有人类调用 `confirmCompletion` 才真正结束 | 无 | 不可变 |
| `endorse` / `challenge` / `verify` | 对某条已有消息的赞同/质疑/验证，纯注解，不改变原消息的 type，不触发任何自动的状态流转 | `targetMessageId` 必填 | 不可变 |

**开放问题 vs 假设**：`open_question` 是问题本身（还没人回答），`hypothesis` 是对某个问题给出的候选回答（还没被认定为定论）——二者概念不重复。

## 2. 记忆原则：只追加不覆盖，`exploring` 是唯一例外（对应需求 4.5/4.6）

- **只追加不覆盖**：除 `exploring` 外，所有类型都是追加式的——没有"当前唯一状态"字段会被覆盖，也没有系统自动挑出的"当前最优"。一个 `hypothesis` 被 `verify` 后**不会**自动升级为 `fact`；一个 `fact` 被 `challenge` 后**不会**自动降级——系统只如实累积展示原始事件（谁验证/质疑了什么），最终"信不信"的判断权留给读取记忆的 agent 和人类。多条 `chain`（候选方案）、多条 `boundary`（死胡同）可以同时并存，互不覆盖。
- **`exploring` 的状态机**（唯一的例外）：一个 agent 同时只能有一条 **active** 的 `exploring` 记录。
  - **自动顶替**：agent 发一条新的 `exploring` 消息时，自动把它自己名下之前那条 active 的标记为 `completed`。
  - **显式完成**：探索完一个方向、但还没想好下一个方向时，调用 `complete_exploring` 工具把当前 active 的记录标记为 `completed`。
  - **人类强制完成**：人类可通过 `terminateAgentSession` 把它标记为 `completed`，带"人类强制终止"的系统备注。
  - **不做超时自动完成**（明确排除）——`exploring` 会不会"卡住"完全靠 UI 层面的"卡住提醒"交给人类判断，不由系统自动处理。
  - `status` 的变更**只发生在 `exploring` 这一种类型上**，其他所有类型永远不会有字段被事后修改。
- 这些规则的**机械实现**在存储层（`01-storage.md` 第 2 节"不变量"、`insertMessage`/`completeExploring` 两个函数）；本节是规则本身的完整定义，供理解"为什么 `get_overview`/`get_detail`/`getMemoryView` 长这样"打基础——三个读取函数（第 4-6 节）都是在这套原则之上做"怎么把这些数据挑出来给谁看"的工作，不重新定义原则本身。

### 2.1 生命周期与日志边界

session_events 中人工终止请求、信号清理与退出事实不属于消息或记忆类型。buildOverview（包括 recentRawMessages）、buildDetail、buildMemoryView 和派发 prompt 不读取生命周期表或日志。正式发现由 post_message 按类型进入记忆，正常 session 退出不自动完成 exploring；历史消息保持不变。

## 3. 记忆读取的两个粒度（对应需求 4.4）

- **概览级**（`buildOverview`，见第 4 节）：只给摘要/索引（`{id, summary}`），不给全文；`activeExploring` 只给 active 状态的快照。这是 agent 每次被派发时自动获得的默认视图（预渲染进 prompt，见 `03-orchestrator-core.md` 1.3），为节省 token 设计。
- **深挖级**（`buildDetail`，见第 5 节）：agent 按需调用，拿某条或某类记忆的**完整内容**（包括它挂载的所有 `endorse`/`challenge`/`verify` 注解）。按 `type: "exploring"` 查询时返回该类型下的**全部记录，不分 active/completed**——跟 `buildOverview` 里只给 active 快照的 `activeExploring` 是两回事。
- **人类视图**（`buildMemoryView`，见第 6 节）：给前端看的是**全文**而不是摘要——摘要是为 agent 省 token 设计的，人类看网页没有这个限制。

## 4. `buildOverview(roomId): OverviewPayload`

```typescript
interface OverviewPayload {
  goal: string;
  facts: { id: number; summary: string }[];
  boundaries: { id: number; summary: string }[];
  openQuestions: { id: number; summary: string }[];
  chains: { id: number; summary: string }[];
  hypotheses: { id: number; summary: string }[];
  activeExploring: { agentId: string; summary: string }[];
  recentRawMessages: Message[];
  guidance: string;
}

function buildOverview(roomId: number): OverviewPayload;
```

实现：
- `goal`：`getFirstMessage(roomId).content`（房间创建后第一条消息必然是人类发的任务描述，见需求 3.1）。
- `facts`/`boundaries`/`openQuestions`/`chains`/`hypotheses`：分别 `getMessagesByType(roomId, <type>)`，只取 `{id, summary}`。
- `activeExploring`：`getActiveExploring(roomId)`，映射成 `{agentId: m.authorId, summary: m.summary}`。
- `recentRawMessages`：`getRecentRawMessages(roomId, N)`，默认 `N = 4`（需求第 9 节待细化项；原定 5-10，已下调为 4 以进一步省 token，可通过服务端配置调整）。
- `guidance`：固定文案，对应需求 5——"以上是聊天室的既有记忆，仅供参考，请形成你自己的判断——可以采纳、组合、推翻，也可以提出全新方案。"

**两个调用方，用途不同**：
- `05-mcp-server.md` 的 `get_overview` 工具：agent 主动调用时，直接返回 `buildOverview(roomId)` 的结果——用于 session 中途想要刷新最新状态。
- `04-agent-invocation.md` 的 `startSession`：派发时调用 `buildOverview(roomId)`，把结果渲染进 prompt（见 `04-agent-invocation.md` 第 2 节）——这是派发**那一刻**的快照，之后房间状态如果变了（其他并发 session 产出新内容），要靠 agent 自己再调用 `get_overview` 工具刷新，预渲染的快照不会自动更新。

## 5. `buildDetail(roomId, params): MessageWithAnnotations | MessageWithAnnotations[]`

```typescript
interface MessageWithAnnotations extends Message {
  annotations: Message[];
}

function buildDetail(roomId: number, params: { messageId: number } | { type: MessageType }): MessageWithAnnotations | MessageWithAnnotations[];
```

实现：
1. 传 `messageId`：`getMessageById(roomId, messageId)`（消息 id 是 room 内编号，见 `01-storage.md`），必须存在；附加 `annotations: getAnnotations(roomId, messageId)`（挂在它上面的 endorse/challenge/verify/追问），返回单个对象。
2. 传 `type`：
   - `type === 'exploring'`：`getMessagesByType(roomId, 'exploring')` 返回该类型下**全部记录，不分 active/completed**（需求 4.4 明确要求，跟 `buildOverview.activeExploring` 只给 active 快照是两回事）。
   - 其他 `type`：`getMessagesByType(roomId, type)`。
   - 每条结果都附加 `annotations: getAnnotations(roomId, m.id)`。

**唯一调用方**：`05-mcp-server.md` 的 `get_detail` 工具（只有 agent 会按需深挖，派发 prompt 不需要这份全量数据）。

**异常情况**：传 `messageId` 查询时，若 `getMessageById(roomId, messageId)` 查不到该消息（id 不属于这个 room 或不存在），`buildDetail` 直接抛出错误（不返回 `null`、不返回空数组）——调用方（`05-mcp-server.md` 的 `get_detail`）负责把这类错误转换成 MCP 工具的错误返回（见 `05-mcp-server.md`"错误返回形式统一"一节），不静默吞掉。

## 6. `buildMemoryView(roomId): MemoryViewPayload`

给前端看的全文视图：

```typescript
interface MemoryViewPayload {
  facts: Message[]; boundaries: Message[]; openQuestions: Message[];
  chains: Message[]; hypotheses: Message[];
  exploring: Message[]; // getMessagesByType(roomId, 'exploring') 全量，不筛 active/completed
}

function buildMemoryView(roomId: number): MemoryViewPayload;
```

跟 `buildOverview` 的区别：这里每个分组给的是 `Message[]` 全文，`buildOverview` 给的是 `{id, summary}`——摘要是为 agent 省 token 设计的，人类看网页没有这个限制（需求 3.5）。

**唯一调用方**：`06-orchestrator-api.md` 的 `getMemoryView` RPC。

## 7. 对外接口

```typescript
function buildOverview(roomId: number): OverviewPayload;
function buildDetail(roomId: number, params: { messageId: number } | { type: MessageType }): MessageWithAnnotations | MessageWithAnnotations[];
function buildMemoryView(roomId: number): MemoryViewPayload;
```

## 8. 对存储层的依赖

```typescript
// 01-storage.md
getMessageById, getFirstMessage, getMessagesByType, getActiveExploring, getRecentRawMessages, getAnnotations
```
