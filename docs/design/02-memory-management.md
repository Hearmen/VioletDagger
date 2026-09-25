# 记忆管理设计

把存储层的原始消息与状态转换记录组装成三种读取形状：给 agent 的概览（`buildOverview`，摘要/索引）、给 agent 的详情（`buildDetail`，全文）、给前端的记忆视图（`buildMemoryView`，全文）。本层只读、不写，不做自然语言语义判断，不依赖存储层以外的任何模块；MCP Server、Agent 调用适配层、编排器对外接口都直接调用它。

## 1. 原则

- **按当前状态投影**：消息的当前 type 与状态（`questionStatus`、`chainStatus`、`exploringStatus` 等）直接取自 `Message` 列，转换历史取自 `state_transition_log`。本层不从消息关系推断任何状态（需求 4.4）。
- **一次批量读取**：每次构建只调用 `getRoomMessages(roomId)` 与 `getRoomStateTransitions(roomId)` 各一次，在内存里建 `id → Message` 表和反向索引，不逐条查询。
- **摘要不含作者**：`MessageSummary` 只用 `source` 区分人类与 agent，不带 `authorId`；`ExploringOverview.agentId` 是占用状态，属于例外。原始消息和 `get_detail` 仍保留作者，供追溯。
- **历史不伪造**：引用的 id 不存在时直接跳过，不生成占位；不推测回填缺失的关系。

## 2. 共享索引

三个出口共用一次建表：

```typescript
interface RoomIndex {
  byId: Map<number, Message>;
  transitionsByMessage: Map<number, StateTransition[]>;  // 按 id 升序
  reactionsByTarget: Map<number, Message[]>;             // type 为 challenge/verify 且 targetMessageId 指向该消息，按 id 升序
  answersByQuestion: Map<number, Message[]>;             // 当前 type 为 hypothesis/fact/boundary/chain 且 targetMessageId 指向该 open_question
  referencedBy: Map<number, number[]>;                   // 反向引用：哪些消息的 referencedMessageIds 包含该 id
}
function buildRoomIndex(roomId: number): RoomIndex;
```

"回答某个问题"只看 `targetMessageId` 是否指向一条 `open_question`；fact/boundary 未带目标时不属于任何问题。

## 3. 概览 `buildOverview(roomId)`

### 3.1 结构

```typescript
interface OverviewPayload {
  goal: QuestionOverview;                    // 房间首条 open_question 即 goal
  questions: QuestionOverview[];             // goal 之外的全部 open_question，按 id 升序
  unattachedKnowledge: KnowledgeOverview[];  // 未指向任何问题的 fact/boundary，及其经 challenge 转成的 hypothesis
  activeExploring: ExploringOverview[];
  completedExploring: ExploringOverview[];
  completionProposals: MessageSummary[];
  recentRawMessages: MessageSummary[];       // 最近若干条不分类型的原始消息，默认 4 条
  guidance: string;                          // 固定引导语
}

interface MessageSummary {
  id: number;
  type: MessageType | null;                  // 当前 type；无 type 的聊天为 null
  source: 'human' | 'agent';
  summary: string;
  targetMessageId: number | null;
  referencedMessageIds: number[];
  createdAt: string;
}

interface QuestionOverview {
  question: MessageSummary;
  status: 'OPEN' | 'CLOSED';
  closeReason: 'RESOLVED' | 'UNRESOLVED' | null;
  hypotheses: KnowledgeOverview[];
  facts: KnowledgeOverview[];
  boundaries: KnowledgeOverview[];
  chains: ChainOverview[];
}

interface KnowledgeOverview {
  current: MessageSummary;                   // 当前 type：hypothesis/fact/boundary
  transitions: StateTransitionSummary[];
  verifies: MessageSummary[];
  challenges: MessageSummary[];
  references: MessageSummary[];              // referencedMessageIds 展开的依据
}

interface ChainOverview {
  current: MessageSummary;
  status: 'CANDIDATE' | 'VERIFIED' | 'CHALLENGED' | 'REJECT';
  closesQuestion: boolean;
  chainResolution: 'RESOLVED' | 'UNRESOLVED' | null;
  evidence: MessageSummary[];                // referencedMessageIds 展开的依据
  verifies: MessageSummary[];
  challenges: MessageSummary[];
  transitions: StateTransitionSummary[];
}

interface StateTransitionSummary {
  fromType: string | null;
  toType: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  triggerMessageId: number;
  createdAt: string;
  reason: string | null;
}

interface ExploringOverview {
  message: MessageSummary;
  agentId: string;
  status: 'active' | 'completed';
  target: MessageSummary;                    // 指向的 open_question 或 hypothesis
  resultSummary: string | null;              // complete_exploring 写入的结果摘要
  resultMessages: MessageSummary[];
}
```

### 3.2 组装规则

- **MessageSummary**：由 `Message` 直接映射，`source` 为 `authorId === 'human' ? 'human' : 'agent'`（系统占位消息的作者是 agent 实例标识，归为 `agent`）。
- **goal**：`getFirstMessage(roomId)`，它一定是 `open_question`（`03-orchestrator-core.md` §1.4 首条消息规则）。房间还没有消息时 `buildOverview` 抛错"room has no goal yet"——此时房间不可能有 session，只有未绑定身份的 `get_overview` 调用会遇到，MCP 按业务错误返回。
- **questions**：除 goal 外、当前 type 为 `open_question` 的全部消息，按 id 升序。goal 只出现在 `goal`，不在 `questions` 中重复。
- **QuestionOverview**：`status`/`closeReason` 直接取 `questionStatus`/`questionCloseReason`。`answersByQuestion` 里的消息按当前 type 分到 `hypotheses`/`facts`/`boundaries`/`chains`，各自按 id 升序。
- **unattachedKnowledge**：当前 type 为 `hypothesis`/`fact`/`boundary`，且 `targetMessageId` 为空或不指向 `open_question` 的消息，按 id 升序。新写入的 hypothesis 一定指向问题，所以这里的 hypothesis 只可能来自被 challenge 转换的无目标 fact/boundary。
- **KnowledgeOverview / ChainOverview**：`verifies`/`challenges` 取 `reactionsByTarget` 中对应 type 的消息；`transitions` 取 `transitionsByMessage`；`references`/`evidence` 按 `referencedMessageIds` 顺序展开，找不到的 id 跳过。chain 的 `status`/`closesQuestion`/`chainResolution` 直接取列值。chain 一定挂在某个问题下（写入校验保证），因此只出现在 `QuestionOverview.chains`。
- **activeExploring / completedExploring**：当前 type 为 `exploring`、按 `exploringStatus` 分成两组，各自按 id 升序；`agentId` 为 `authorId`；`target` 为 `targetMessageId` 指向的消息；`resultMessages` 按 `exploringResultMessageIds` 展开。
- **completionProposals**：全部 `propose_completion`，按 id 升序，不受最近窗口限制。
- **recentRawMessages**：`getRecentRawMessages(roomId, n)`，n 默认 4，由 `VIOLETDAGGER_RECENT_RAW_MESSAGES` 配置正整数（非法值回落默认 4）；按 id 升序；只提供最近上下文，不承担历史索引职责。
- **guidance**：固定文案"以上是当前任务的进展情况，仅供参考，请形成你自己的判断——可以采纳、组合、推翻，也可以提出全新方案。"（需求第 5 节）。

所有数组只提供摘要/索引，不提供全文；需要全文时使用 `get_detail`。

### 3.3 Prompt 大小保护

派发前检测完整 prompt 的 UTF-8 大小，默认上限 128 KiB，用 `VIOLETDAGGER_MAX_PROMPT_BYTES` 配置正整数。这是输入大小保护，不等同模型 token 上限。超限时在原始消息流写入一条无 type 的系统诊断，把 room 暂停为 `paused_manual`，以 `spawn-failed` 结算本次未启动的 session；不截断，也不自动重试。

## 4. 详情 `buildDetail(roomId, params)`

```typescript
interface DetailParams {
  messageId?: number;
  type?: MessageType;
  list?: boolean;
  targetMessageId?: number;
  beforeId?: number;
  limit?: number;
}

interface MessageWithAnnotations extends Message {
  annotations: Message[];         // 指向它的 challenge/verify 全文
  answers: Message[];             // 它是 open_question 时，回答它的 hypothesis/fact/boundary/chain 全文
  referencedByIds: number[];
  transitions: StateTransition[]; // 它自己的 type/状态转换历史
}

interface DetailPage { messages: MessageWithAnnotations[]; nextCursor: number | null }

function buildDetail(roomId: number, params: DetailParams):
  MessageWithAnnotations | MessageWithAnnotations[] | DetailPage;
```

三种模式互斥，同时提供或都不提供时报错：

- **单条**（`messageId`）：返回该消息及其挂载内容；不存在时报错。
- **按类型全量**（`type`）：返回当前 type 为该值的全部消息，按 id 升序。`type: "exploring"` 返回全部记录，不分 active/completed。
- **分页浏览**（`list: true`）：可选 `type`、`targetMessageId` 过滤；不传 `type` 时包含无 type 聊天。`limit` 默认 30、范围 1..100；`beforeId` 排他。按 id 倒序取页、页内升序返回；还有更早的消息时 `nextCursor` 为本页最小 id，否则为 null。

所有 id 必须为正整数，查询限定在本 room。挂载内容只展开一层，不递归。

## 5. 记忆视图 `buildMemoryView(roomId)`

给前端记忆面板用的全文数据（需求 3.5），按当前 type 分组，前端据此构建"记忆总线 → 类别 → 条目"的渐进式展示（`07-frontend.md` §8）：

```typescript
interface MemoryViewPayload {
  goalMessageId: number | null;             // 房间首条消息 id；房间为空时为 null
  openQuestions: Message[];                 // 含 goal，前端据 goalMessageId 单独标出
  hypotheses: Message[];
  facts: Message[];
  boundaries: Message[];
  chains: Message[];
  exploring: Message[];                     // 全部，不分 active/completed
  completionProposals: Message[];
  challenges: Message[];
  verifies: Message[];
  transitions: Record<number, StateTransition[]>; // messageId → 转换历史，只包含有转换的消息
}
```

- 每个分组按 id 升序；每条消息只出现在它当前 type 对应的一组。
- 分组里是完整 `Message`（含全部状态列与 `targetAgentId`），前端用 id 表自行关联问题与回答、目标与 challenge/verify、引用与反向引用，不依赖消息流面板已加载的分页范围。
- 面板不显示作者；原始消息流和 session 详情仍可追溯作者。

## 6. 边界

- `session_events` 和进程日志不进入任何记忆出口。
- 代码只对引用 id 集合去重，不判定语义重复。
- 超过最近窗口的回答、challenge/verify、完成提议、探索结果仍通过各自分组可见；无 type 的历史通过 `get_detail` 的 list 模式分页取回。

## 7. 对外接口与依赖

```typescript
// 对外接口
function buildOverview(roomId: number): OverviewPayload;
function buildDetail(roomId: number, params: DetailParams): MessageWithAnnotations | MessageWithAnnotations[] | DetailPage;
function buildMemoryView(roomId: number): MemoryViewPayload;

// 依赖（01-storage.md）
getRoomMessages, getRoomStateTransitions, getFirstMessage, getRecentRawMessages
```
