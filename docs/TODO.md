# TODO

## 记忆层"信息丢失"问题

**根因**：记忆层只沉淀"主张"（`fact`/`hypothesis`/`chain`/`boundary`/`open_question`/`exploring` 条目），不沉淀"主张之间的关系与过程状态"；而 `buildOverview` 是后续 session 唯一的连续性来源，凡未进入其分组的状态即对后续 session 等同不存在，导致重复劳动。

涉及文档：`design/01-storage.md`、`design/02-memory-management.md`、`design/05-mcp-server.md`、`design/07-frontend.md`、`requirements.md`。

### A. 反应类（endorse / challenge / verify）默认不可见
- [ ] A1. `buildOverview`（02 §4）与 `MemoryViewPayload`（02 §6）都不含 reaction，后续 session 不知道某条已被验证/质疑，会重复 reaction。
- [ ] A2. 需求 4.5 承诺"如实累积展示原始事件（谁验证/质疑了什么）"，但 overview 无任何注解，承诺在默认视图未兑现。
- [ ] A3. 唯一出口是 `get_detail`（按 messageId/type），但没有触发线索，agent 通常不会主动挖。

### B. 问答没有结构化关联与"已解决"状态
- [ ] B1. `hypothesis` 无 `targetMessageId`（02 §1、05 §4），"这条答案回答了哪个问题"不落任何记录。
- [ ] B2. `open_question` 永久留在 `openQuestions`，没有已解决/已获答案标记，后来者可能重复调查、重复作答。
- [ ] B3. 与"追问式 `open_question`"不对称：追问有结构化关联，回答却没有。

### C. 已完成探索不可见，且无结论无法沉淀
- [ ] C1. `buildOverview.activeExploring` 只给 active 快照（02 §4），已 `completed` 且无产出的方向对后续 session 不可见。
- [ ] C2. `complete_exploring` 不携带 note（note 是人类强制终止专用，05 §5），agent 没有一级记录出口表达"探过、无结论"。

### D. 完成提议不可见
- [ ] D1. `propose_completion` 不在 overview/memoryView（02 §4/§6），后续 session 可能反复提议完成。
- [ ] D2. 仅当它落在 `recentRawMessages`（默认 4 条）窗口内才偶然可见，或靠 `get_detail({type:'propose_completion'})` 主动捞。

### E. 访问能力本身的限制
- [ ] E1. agent 只有四个 MCP 工具，没有分页/列表能力（`listMessages` 是前端 RPC，06 §4），窗口外的原始消息对 agent 基本不可达。
- [ ] E2. 每个 session 从零开始，唯一连续性来自 overview，任何未编码进 overview 的状态对后续 session 等同不存在。

### F. 文档内部不一致
- [ ] F1. 07 §161 称记忆面板条目层展示"挂在它上面的注解信息"，但 `getMemoryView` 返回纯 `Message[]`、不带 annotations；§157 又声称面板数据"只来自 `getMemoryView()`"——两处对不上。
- [ ] F2. 02 §1 标题为"记忆类型定义"并把 `propose_completion`、reactions 都算作记忆类型，但记忆视图不含它们，"记忆里到底有没有 reaction"口径歧义。

## propose_completion 处理（已定方向，待细化）

- [ ] G1. `propose_completion` 纳入记忆：`buildOverview`（02 §4）新增分组/字段、`MemoryViewPayload`（02 §6）新增 `proposeCompletion: Message[]` 分组、`07` 记忆总线加对应 chip（§159 计数、§163 顺序）、`04` 派发 prompt 协作协议注明"仅提议，结束由人类决定"。性质保持只追加、不可变、无状态；该改动同时消解 F2（02 §1 本就把它列为记忆类型）。
  - 待定：overview 给全量 `completionProposals: {id, agentId, summary}[]`，还是 `completionProposed: boolean` + 最近一条摘要（倾向后者，省 token）。
- [ ] G2. 提议完成的 agent 进入 disable 状态，由人类通过前端命令再次启动，防止被无限拉起：agent 一旦发出 `propose_completion`，将其 `room_agents.dispatch_enabled` 置 0（复用现有 `setAgentEnabled`，01 §4 / 06 §4）。
  - 动机：`propose_completion` 是实质消息、会触发派发检查，可能把同一 agent 反复拉起、反复提议，形成循环；停用即切断循环。
  - 触发点：`05-mcp-server.md` §4 `post_message` 在 `type === 'propose_completion'` 时调用核心停用该 agent，并 emit `roomStatus`（dispatch_enabled 变化）。
  - 不变：仍需人类 `confirmCompletion` 才真正结束房间。
  - 待确认：停用只阻止后续派发、不终止当前正在运行的 session（与 01 §1 语义一致），以及前端再次启用的入口沿用现有 `setAgentEnabled`。

## 每个 room 的 token 开销记录（新需求，待细化）

- [ ] H1. 记录并展示每个 room 的累计 token 开销，最好能按 agent / session 细分，供人类掌握成本。
  - 数据来源：agent CLI 的过程流（codex `--json`、claude `--output-format stream-json`、opencode `--format json`、kimi `--output-format stream-json`，见 `04-agent-invocation.md` §1）是否包含 usage/token 字段，须逐家实测；这与 `04` §2/§3 "日志原样记录、不解析、不提取" 的既有约束冲突，需决定是破例解析 usage，还是要求 CLI 另行输出用量文件。
  - 存储：`sessions` 表加字段（input/output/total tokens）或新增 `session_usage` 表；room 级聚合读取。
  - 展示：`getRoomStatus` 或 `06` 的房间接口加汇总，前端房间头部显示；无法获取 usage 的 agent 明确标注"不可用"，不伪造。
  - 待确认：是否把 token 开销纳入 `deleteRoom` 的级联清理范围。

## 待定的修复方向（未决，需 review）

不引入自动状态、不破坏"只追加"：

1. `buildOverview` 每条记忆附注解计数 `annotations: {endorse, challenge, verify}`（读时派生，零 schema）——对应 A。
2. `buildOverview` 增加 `completionProposed: boolean`（读时派生）——对应 D。
3. 派发 prompt 协作协议明确"探索无结论也要发 `boundary`"——对应 C（零 schema）。
4. 给 `hypothesis` 增加可选 `targetMessageId`，`buildOverview` 派生 `openQuestions[].answeredBy`——对应 B（唯一存储改动）。
5. `buildMemoryView` 附带 annotations，或明确前端自行从消息流推导——对应 F1。
