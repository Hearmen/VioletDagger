---
name: room-dispatch-analysis
description: 分析 VioletDagger 某个房间的运行日志和数据库，还原调度过程，画出调度顺序图，并找出调度异常。适用于用户要求"分析 room N 的 log"、"画调度顺序图/时间线"、"为什么某个 agent 没被派发/被重复派发"之类的请求。
---

# 房间调度分析

目标：对指定房间，还原每个 session 是在什么时刻、因为什么被派发的；画出调度顺序图；找出实际调度和调度规则对不上的地方。

## 1. 数据源

`packages/server/logs/<roomId>/<seq>.jsonl` 只是每个 session 进程的原始 stdout/stderr（`{offset, stream, text}`），不带调度信息。调度分析要以数据库为主，日志只用来查失败原因和 session 内的行为。

| 来源 | 位置 | 用途 |
|---|---|---|
| sessions 表 | `packages/server/violetdagger.db` | seq、agent、started_at/ended_at、outcome、exit_cause、dispatch_scope |
| messages 表 | 同上 | 每条消息的 id、session_seq、author、type、target、各类状态、created_at |
| state_transition_log | 同上 | 知识状态的历史变化（CANDIDATE→REJECT 等），用于还原某一时刻的状态 |
| room_agents | 同上 | join_order（派发扫描顺序）、dispatch_enabled（是否被停用） |
| session_events | 同上 | process_exited / terminate_requested / terminated 的精确时间 |
| rooms | 同上 | scheduling_mode、status、max_sessions |
| session 原始日志 | `packages/server/logs/<roomId>/<seq>.jsonl` | 失败原因（看 stderr 尾部）、session 内调用了哪些工具 |
| 派发时的 prompt | `packages/server/logs/prompts/violetdagger-<roomId>-<seq>.prompt.txt` | 该 session 拿到的上下文快照；文件修改时间≈派发时间 |
| MCP 配置 | `packages/server/logs/mcp/<roomId>/<seq>.json` | 只有部分 agent 会生成，一般用不上 |

数据库一律只读打开：`sqlite3 -readonly packages/server/violetdagger.db`。

## 2. 取数

```sql
-- 房间与 agent（join_order 即派发扫描顺序）
select * from rooms where id = :room;
select agent_id, registry_key, join_order, state, dispatch_enabled
  from room_agents where room_id = :room order by join_order;

-- session 列表
select seq, agent_id, outcome, started_at, ended_at, exit_code, exit_signal,
       stop_intent, exit_cause, dispatch_scope
  from sessions where room_id = :room order by seq;

-- 消息时间线
select id, session_seq, author_id, coalesce(type,'chat') type, target_message_id, target_agent_id,
       question_status, chain_status, exploring_status, created_at, substr(summary,1,80)
  from messages where room_id = :room order by id;

-- 状态变化历史
select message_id, from_status, to_status, trigger_message_id, created_at
  from state_transition_log where room_id = :room order by id;

-- session 事件
select session_seq, kind, created_at, detail
  from session_events where room_id = :room order by id;
```

失败的 session 用 `tail -c 600 packages/server/logs/<roomId>/<seq>.jsonl` 查看 stderr 里的报错。

## 3. 读当前调度规则

先读当前规则再推算，不要凭记忆：

- 设计：`docs/design/03-orchestrator-core.md` §1.2（派发判定）、§6（连续失败停用）
- 实现：`packages/server/src/orchestrator-core/dispatch.ts`（`checkAndDispatch`、`resolveDispatchDecision`）、`packages/server/src/storage/messages.ts`（`getLatestTriggerAt`）、`packages/server/src/orchestrator-core/submitMessage.ts`（`isTriggerAtWrite`）、`packages/server/src/orchestrator-core/sessionLifecycle.ts`（`onSessionEnded`）

需要从代码中确认的要点：
1. 哪些事件会调用 `checkAndDispatch`（触发型消息写入、session 结算、resume、启用 agent 等）。
2. 一次调用最多派发几个 session，按什么顺序扫描 agent。
3. 哪些消息类型、哪些状态算触发型消息；定向（directed）session 的产出是否排除在外。
4. "待派发"如何判定（触发消息时间与该 agent 上次 session 开始时间比较，边界是否严格大于）。
5. 连续失败阈值和停用逻辑。

## 4. 逐次推算派发原因

把 session 开始、session 结束、消息写入、状态变化合并成一条按时间排序的事件流，然后按顺序模拟调度：

1. 对每个会调用 `checkAndDispatch` 的事件，按 join_order 扫描 agent：跳过停用的、跳过 running/stopping 的，找到第一个空闲且待派发的 agent。
2. 判断"待派发"时，要看的是**事件发生那一刻**消息的状态，而不是数据库里的当前状态。例如某条 chain 现在是 REJECT，但如果它在 state_transition_log 里是在该事件之后才变成 REJECT 的，那么在那一刻它仍是 CANDIDATE，仍然算触发。
3. 该 agent 自己发的消息不会触发它自己。
4. 把推算结果和 sessions 表里的实际 started_at 对照，逐条记录：派发时机（哪条消息写入或哪个 session 退出）、待派发依据（哪些触发消息）。
5. 失败的 session 按 agent 维护连续失败计数，到阈值时记下停用时刻，之后的扫描跳过该 agent。

## 5. 识别异常

- **漏派发**：推算出某时刻应当派发某个 agent，但实际上没有派发，或实际派发时间晚于推算时间。
- **多派发**：实际有 session 开始，但推算出那一刻没有 agent 待派发，或当时没有能调用 `checkAndDispatch` 的事件。
- **重复劳动**：多个并发 session 在处理同一条消息，或 session 开始时它的目标已经被驳回。
- **连续失败**：失败原因（配额、鉴权、崩溃）、是否按阈值停用。

发现异常后，先排除代码版本差异再下结论：比较 `packages/server/src/orchestrator-core/*.ts`、`packages/server/src/storage/*.ts` 的修改时间（`ls -la`）和该房间的运行时间，再用 `git log` 和 `git status` 看工作区是否有未提交的改动。如果代码在运行之后被改过，就说明当时运行的版本无法还原，结论只能写成推测。人工操作（resume、启用/停用 agent、终止 session）不会留下消息，数据库里查不到的触发源要明确写成"来源不明"，不要编造。

注意时区：数据库时间是 UTC，文件修改时间是本地时间，比较前先换算。

## 6. 输出

1. **Mermaid 顺序图**（sequenceDiagram）：参与者为 human、Scheduler 和各个 agent。
   - 派发：`S->>+A: ▶seqN（派发依据）`
   - 触发型消息：`A->>S: #id type 状态 时间`
   - 非触发消息（verify、fact）：同样画出，并注明引起的状态变化，例如 `#5 verify ✗ → #3 REJECT`
   - 正常退出：`A-->>-S: seqN exit 时间`；失败退出：`A--x-S: seqN ✗ 原因（连续失败 k）`
   - 没有派发出任何 session 的调度检查，以及异常，用 `Note` 标出
2. **结论**：调度规则是否得到遵守、知识链的收敛过程、失败和停用、异常及其可能原因（区分已确认和推测）。
3. 用户要可视化页面时，另外用 Artifact 发布：泳道时间轴（session 条按结果着色、消息标记、派发箭头、异常时间段）+ 派发记录表 + 顺序图。

分析过程中只读，不修改数据库、日志或代码。
