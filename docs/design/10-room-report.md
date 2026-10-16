# 任务分析报告设计

人类在房间页点击"生成分析报告"时，即时计算本房间各 agent 的量化指标并返回一份快照。需求依据见 requirements.md 3.1"任务分析报告"、3.5"CLI 原生会话""任务分析报告"。

本模块只读：不写存储、不 emit 任何事件、不调用任何模型、不缓存结果，每次调用重新计算。代码位于 `packages/server/src/room-report/`。

## 1. 依赖

- 存储层（`01-storage.md`）：`getRoom`、`getRoomAgents`、`listSessions`、`getFirstMessage`。
- Agent 调用适配层（`04-agent-invocation.md` §7.1）：`getNativeSessionAdapter(registryKey).analyze(source)`。
- 不依赖编排器核心；由编排器对外接口（`06-orchestrator-api.md`）调用。

## 2. 对外接口

```typescript
function getRoomReport(roomId: number): Promise<RoomReport>;
// room 不存在时抛 NotFound，由 06 转成 HTTP 404；其余任何局部失败都只让对应指标为空，不让整份报告失败

type Ratio = number | null; // 0~1，分母为 0 或数据不足时为 null

interface DurationStats {
  mean: number | null; median: number | null; p90: number | null;
  max: number | null; maxSeq: number | null; // 毫秒；maxSeq 为取到最大值的 sessionId
}

interface ReportRow {
  agentId: string | null;     // null 表示房间合计行
  registryKey: string | null; // 合计行为 null
  sessions: {
    total: number; // 已结束 session 数
    byOutcome: { completed: number; passed: number; error: number; terminated: number };
    completionRate: Ratio; passRate: Ratio; errorRate: Ratio;
    byTrigger: { room_flag: number; directed_flag: number; continuation: number; unknown: number };
  };
  time: {
    totalExecMs: number | null; // 没有已结束 session 时为 null
    exec: DurationStats;
  };
  tokens: {
    input: number | null; output: number | null;
    cacheRead: number | null; cacheWrite: number | null;
    total: number | null;
    shareOfRoom: Ratio;          // 合计行恒为 null
    cacheHitRate: Ratio;
    perSession: number | null;
    perCompletedSession: number | null;
    perStep: number | null;
    outputPerSecond: number | null;
    missingSessions: number;     // 四个 token 字段全为 null 的 session 数
  };
  model: {
    steps: number | null;
    stepsPerSession: number | null;
    firstResponse: { mean: number | null; median: number | null; missingSessions: number }; // 毫秒；missingSessions 为首次响应延迟为 null 的 session 数
    missingSessions: number;     // 步数为 null 的 session 数
  };
  tools: {
    total: number | null;
    perSession: number | null;
    perStep: number | null;
    failed: number | null;
    successRate: Ratio;
    unknownOutcomeCalls: number; // failed 为 null（成败未知）的调用次数
    missingSessions: number;     // toolCalls 为 null 的 session 数
  };
}

interface ToolNameCount { name: string; isRoomMcp: boolean; count: number; failed: number | null }

interface RoomReport {
  roomId: number;
  generatedAt: string;          // ISO8601
  runningSessions: number;      // 未计入统计的 running/stopping session 数
  room: ReportRow & {
    maxSessions: number;
    sessionsCreated: number;    // 已创建 session 总数（含运行中）
    sessionUsageRate: Ratio;    // sessionsCreated ÷ maxSessions
    roomDurationMs: number | null;
  };
  agents: ReportRow[];          // 按 joinOrder 排列，包含尚无 session 的 agent
  toolNames: {
    room: ToolNameCount[];                    // 按 count 降序，同数按 name 升序
    byAgent: Record<string, ToolNameCount[]>; // 同上
  };
}
```

## 3. 计算流程

1. `getRoom(roomId)`，不存在抛 NotFound；记下 `generatedAt = now`。
2. `listSessions(roomId)`：outcome 为 `running`/`stopping` 的只计入 `runningSessions`，其余为**已结束 session**，是后续全部统计的对象。
3. 对每个已结束 session 重建原生会话来源：
   - `native_storage = 'file'` 且 `native_copy_path` 非空 → `{ storage: 'file', copyPath }`；
   - `native_storage = 'database'` 且 `native_original_path`、`native_session_id` 非空 → `{ storage: 'database', originalPath, sessionId }`；
   - 其他 → 无来源，步数、首次响应、工具调用记 null。
4. 有来源的 session 按 `room_agents.registry_key` 取适配器调用 `analyze`。最多 4 个并发，单次超时 10 秒：超时即 abort 传入的 `AbortSignal`，适配器随之停止读取并关闭句柄（`04-agent-invocation.md` §7.1）。超时或抛错时该 session 的分析结果全为 null。
5. 为每个 session 形成一条记录：
   - **outcome、dispatchTrigger、执行时长**：来自 session 记录。执行时长 = `endedAt − startedAt`。
   - **token**：取 session 记录中已入库的四个 token 字段，不用 `analyze` 重新解析的值。这保证报告与 3.5"用量统计"展示的数字一致。
   - **步数、首次响应、工具调用**：来自 `analyze`。首次响应延迟 = `firstResponseAt − startedAt`，为负或无法解析时记 null。
6. 按 agent 分组计算各 agent 行；把全部已结束 session 合在一起，按同一套规则计算合计行。合计行**不是**各 agent 行的再加工。
7. 计算合计行的专属字段和工具名分布，组装返回。

## 4. 指标口径

**通用规则**：
- **求和**：只对非 null 值求和；参与的值全为 null 时结果为 null。"没有数据"和"是 0"不混淆。
- **比率与平均**：分子分母只取两项数据都存在的 session；分母为 0 时为 null。
- **中位数**：样本排序后取中间值，偶数个时取中间两个的平均。
- **P90**：最近秩法，取排序后第 `ceil(0.9 × n)` 个。
- **最大值**：同为最大值时取 seq 最小的那个 session。
- **空样本**：没有样本时，平均值、中位数、P90、最大值及其 seq 全为 null。已结束 session 一定有 `endedAt`（`01-storage.md` 终态规则），执行时长总能算出。

### 4.1 Session 结果

| 字段 | 口径 |
|---|---|
| `total` | 已结束 session 数 |
| `byOutcome` | 按 outcome 计数 |
| `completionRate` / `passRate` / `errorRate` | completed / passed / error ÷ `total` |
| `byTrigger` | 按 `dispatch_trigger` 计数；NULL 计入 `unknown` |

### 4.2 执行时间

| 字段 | 口径 |
|---|---|
| `totalExecMs` | 各 session 执行时长之和 |
| `exec` | 执行时长的平均值、中位数、P90、最大值及其 seq |
| `roomDurationMs`（仅合计行） | 墙钟时长，含暂停期间。起点为 `getFirstMessage` 的 `createdAt`。终点：`status = 'completed'` 时取 `rooms.completed_at` 与各 session `endedAt` 中较晚者（房间结束后仍在跑的 session 会延后终点）；否则为 `generatedAt`。没有首条消息，或已结束但 `completed_at` 为空，则为 null |

### 4.3 Token 消耗

单个 session 的总 token = 四个字段中非 null 值之和；四个全为 null 时，该 session 计入 `missingSessions`。

| 字段 | 口径 |
|---|---|
| `input` / `output` / `cacheRead` / `cacheWrite` / `total` | 求和 |
| `shareOfRoom` | 本 agent `total` ÷ 合计行 `total` |
| `cacheHitRate` | Σ cacheRead ÷ Σ(input + cacheRead)，只取 input 与 cacheRead 都非 null 的 session |
| `perSession` | `total` ÷ 有 token 数据的 session 数 |
| `perCompletedSession` | `total` ÷ completed 数（需求 3.5 的定义；分子含非 completed session 的消耗，表示"每完成一次的平均代价"） |
| `perStep` | Σ 总 token ÷ Σ 步数，只取两者都非 null 的 session |
| `outputPerSecond` | Σ output ÷ Σ 执行秒数，只取 output 非 null 的 session |

### 4.4 模型调用

| 字段 | 口径 |
|---|---|
| `steps` | 步数求和 |
| `stepsPerSession` | `steps` ÷ 步数非 null 的 session 数 |
| `firstResponse` | 首次响应延迟的平均值与中位数；`missingSessions` 为首次响应延迟为 null 的 session 数 |

### 4.5 工具调用

| 字段 | 口径 |
|---|---|
| （范围） | `toolCalls` 为 null 的 session 不参与本节任何指标，只计入 `missingSessions`；全部 session 的 toolCalls 都为 null 时，`total`、`perSession`、`perStep`、`failed` 为 null |
| `total` | 各 session `toolCalls.length` 之和 |
| `perSession` | `total` ÷ toolCalls 非 null 的 session 数 |
| `perStep` | Σ 调用数 ÷ Σ 步数，只取两者都非 null 的 session |
| `failed` | `failed === true` 的调用数。调用数为 0 时为 0；调用数大于 0 且全部成败未知时为 null |
| `successRate` | (已知成败的调用数 − `failed`) ÷ 已知成败的调用数；已知成败的调用数为 0 时为 null |
| `unknownOutcomeCalls` | `failed === null` 的调用数 |
| `toolNames` | 按 `(name, isRoomMcp)` 汇总次数与失败数（失败数规则同 `failed`）；本系统 MCP 工具的 `name` 已由适配器去掉前缀，不同 CLI 的同一工具合并为一行 |

## 5. 性能与边界

- **耗时**：报告按需生成，不缓存。耗时主要来自 `analyze` 读取原生会话；并发上限 4、单次超时 10 秒，保证大房间也在可控时间内返回。
- **原生会话丢失**：原件或副本缺失（数据库型会话被人在 CLI 中删除、副本被手动清理）只影响该 session 的步数与工具指标。token 已入库，不受影响。
- **native 字段与 `dispatch_trigger` 为 NULL 的 session**（见 `01-storage.md` §5.7）：分别计入各项的缺失数与 `unknown`。
- **运行中的房间**：可以生成报告。运行中 session 只出现在 `runningSessions` 与 `sessionUsageRate` 里。

## 6. 代码结构

`packages/server/src/room-report/`：
- `index.ts`：`getRoomReport`
- `types.ts`：第 2 节的对外类型与内部的 session 记录类型
- `collect.ts`：第 3 节第 1–5 步，形成 session 记录
- `aggregate.ts`：第 4 节的纯函数，输入 session 记录数组、输出 `ReportRow`，便于单测
- `stats.ts`：求和、中位数、P90 等工具函数
