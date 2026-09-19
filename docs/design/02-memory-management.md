# 记忆管理设计

## 1. 原则与类型

原始事件只追加，不裁定真伪、不合并同义问题、不设置 resolved、不挑最优 chain。exploring 仅允许一次 active → completed 转换，同时保存结束信息。摘要不包含 authorId；原始 Message 保留作者用于权限与追溯，activeExploring 的 agentId 是占用状态例外。

所有有类型消息均进入默认记忆，无类型聊天可分页浏览。hypothesis 新写入必须 targetMessageId 指向 open_question；fact 可选指向问题；open_question 可选追问任意消息；reaction 必须有目标。所有有类型消息可携带 referencedMessageIds 引用依据。历史缺失关系不推测回填。open_question 表示提出的问题，不意味着尚无人回答。

## 2. 共享关系投影

批量读取 room 消息及引用，建立 ID 表和反向关系；三个读取出口共用此逻辑，不逐条查询。每个事件在分组载荷中只出现一次，关系用 ID，不递归嵌套。

```ts
interface MessageRelations {
  annotationIds: number[]; // reaction、追问
  answerIds: number[]; // 指向问题的 hypothesis/fact
  referencedByIds: number[];
}
interface MemorySummary {
  id: number; type: MessageType | null; summary: string;
  targetMessageId: number | null; referencedMessageIds: number[];
  exploringStatus: 'active' | 'completed' | null;
  exploringEndReason: 'explicit' | 'superseded' | 'human_terminated' | null;
  exploringNote: string | null;
  exploringResultSummary: string | null;
  exploringResultMessageIds: number[];
}
interface MessageWithAnnotations extends Message {
  annotations: Message[]; // endorse/challenge/verify/追问
  answers: Message[]; // 指向该问题的 hypothesis/fact
  referencedByIds: number[];
}
interface DetailParams {
  messageId?: number; type?: MessageType; list?: boolean;
  targetMessageId?: number; beforeId?: number; limit?: number;
}
interface DetailPage { messages: MessageWithAnnotations[]; nextCursor: number | null }
```

## 3. 默认概览 buildOverview(roomId)

```ts
interface OverviewPayload {
  goal: string;
  facts: MemorySummary[]; hypotheses: MemorySummary[];
  boundaries: MemorySummary[]; openQuestions: MemorySummary[];
  chains: MemorySummary[];
  activeExploring: (MemorySummary & { agentId: string })[];
  completedExploring: MemorySummary[];
  completionProposals: MemorySummary[];
  reactions: MemorySummary[];
  contextMessages: MemorySummary[]; // 类型消息所指向/引用的无类型目标
  relations: Record<number, MessageRelations>;
  recentRawMessages: Message[];
  guidance: string;
}
```

所有分组按 ID 升序，全量保留。goal 是首条消息正文。recentRawMessages 默认最近 4 条，用 VIOLETDAGGER_RECENT_RAW_MESSAGES 配置正整数（非法值回落默认 4），不承担历史索引职责。reaction 在目标下渲染摘要和 ID，目标为 reaction 时只展示直接关系；历史异常无目标事件也保留。引用、回答 ID、注解、结束原因和结果均进入 prompt。已结束探索和完成提议不受最近窗口限制。guidance 是固定文案："以上是当前任务的进展情况，仅供参考，请形成你自己的判断——可以采纳、组合、推翻，也可以提出全新方案。"

派发前检测完整 prompt UTF-8 大小，默认 128 KiB，用 VIOLETDAGGER_MAX_PROMPT_BYTES 配置正整数。此为输入大小保护，不等同模型 token 上限。超限在原始消息流写入无类型系统诊断、暂停 room 为 paused_manual、以 spawn-failed 结算本次未启动 session，不截断或自动循环重试。

## 4. 详情 buildDetail 与历史浏览

保留 messageId 单条及 type 全量旧模式，新增显式 list 模式：
```ts
get_detail({ roomId, messageId });
get_detail({ roomId, type });
get_detail({ roomId, list: true, type?, targetMessageId?, beforeId?, limit? });
// { messages: MessageWithAnnotations[], nextCursor: number | null }
```

三模式互斥；列表 limit 默认 30、范围 1..100，ID 为正整数。按 ID 倒序取页、页内升序，beforeId 排他，有更多时 nextCursor 是本页最小 ID，否则 null。无 type 时包含无类型聊天。单条不存在报错；所有查询限定 room。详情保留 annotations 全文，新增 answers 全文和 referencedByIds；只展开一层。

## 5. buildMemoryView(roomId)

MemoryViewPayload 保留 facts/boundaries/openQuestions/chains/hypotheses/exploring 全文分组，新增 completionProposals、reactions、contextMessages、relations。原始消息每条一份，前端建 ID 表显示注解、回答和反向引用，只依赖 getMemoryView，不依赖聊天窗口加载范围。面板不显示作者；原始消息和详情仍可追溯作者。

## 6. 探索结束

complete_exploring 必填非空 resultSummary，可选 resultMessageIds（同 room 已有消息）。状态、explicit 原因、摘要及结果 ID 同事务一次写入；重复结束拒绝。自动顶替记录 superseded，人类终止记录 human_terminated 和系统 note，不伪造结果。旧库新增可空字段和默认空数组，旧原因未知显示“结束原因未记录”，空结果显示“未记录结果”，不推断成无结论。后续补充通过新消息追加。

## 7. 边界与验证

session_events 和进程日志不进入记忆。代码仅对引用 ID 集合去重，不判定语义重复。验证超过最近四条的反应、回答、完成提议、探索结果仍可见；原始无类型历史可分页取回；摘要无作者；旧数据不伪造关联；超预算不静默截断。
