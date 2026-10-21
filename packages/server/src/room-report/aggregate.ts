import type { NativeToolCall } from '../agent-invocation';
import { durationStats, mean, median, ratio, sumOrNull } from './stats';
import type { ReportRow, SessionRecord, ToolNameCount } from './types';

// 10-room-report.md §4 指标口径：输入 session 记录数组，输出一行 ReportRow。纯函数。

function sessionTotalTokens(r: SessionRecord): number | null {
  return sumOrNull([r.input, r.output, r.cacheRead, r.cacheWrite]);
}

// 只取两项都存在的 session，分别求和（§4 比率与平均）。
function pairedSums(records: SessionRecord[], a: (r: SessionRecord) => number | null, b: (r: SessionRecord) => number | null) {
  let sumA = 0;
  let sumB = 0;
  let count = 0;
  for (const r of records) {
    const va = a(r);
    const vb = b(r);
    if (va == null || vb == null) continue;
    sumA += va;
    sumB += vb;
    count++;
  }
  return count ? { sumA, sumB } : null;
}

// 失败数：调用数为 0 时为 0；调用数 > 0 且全部成败未知时为 null（§4.5 failed）。
function failedCount(calls: NativeToolCall[]): number | null {
  if (!calls.length) return 0;
  const known = calls.filter((c) => c.failed !== null);
  return known.length ? known.filter((c) => c.failed === true).length : null;
}

export function aggregateRow(
  records: SessionRecord[],
  identity: { agentId: string | null; registryKey: string | null },
): ReportRow {
  const total = records.length;
  const byOutcome = { completed: 0, passed: 0, error: 0, terminated: 0 };
  const byTrigger = { room_flag: 0, directed_flag: 0, continuation: 0, turn: 0, unknown: 0 };
  for (const r of records) {
    byOutcome[r.outcome]++;
    byTrigger[r.trigger ?? 'unknown']++;
  }

  // Token
  const sessionTotals = records.map(sessionTotalTokens);
  const tokenTotal = sumOrNull(sessionTotals);
  const withTokens = sessionTotals.filter((t) => t != null).length;
  const cache = pairedSums(records, (r) => r.cacheRead, (r) => r.input);
  const tokenPerStep = pairedSums(records, sessionTotalTokens, (r) => r.steps);
  const outputRate = pairedSums(records, (r) => r.output, (r) => r.execMs / 1000);

  // 模型调用
  const steps = sumOrNull(records.map((r) => r.steps));
  const withSteps = records.filter((r) => r.steps != null).length;
  const firstResponses = records.map((r) => r.firstResponseMs).filter((v): v is number => v != null);

  // 工具调用：toolCalls 为 null 的 session 不参与本节任何指标。
  const withTools = records.filter((r) => r.toolCalls != null);
  const calls = withTools.flatMap((r) => r.toolCalls!);
  const knownCalls = calls.filter((c) => c.failed !== null);
  const failedTrue = knownCalls.filter((c) => c.failed === true).length;
  const toolPerStep = pairedSums(withTools, (r) => r.toolCalls!.length, (r) => r.steps);
  const toolsTotal = withTools.length ? calls.length : null;

  return {
    agentId: identity.agentId,
    registryKey: identity.registryKey,
    sessions: {
      total,
      byOutcome,
      completionRate: ratio(byOutcome.completed, total),
      passRate: ratio(byOutcome.passed, total),
      errorRate: ratio(byOutcome.error, total),
      byTrigger,
    },
    time: {
      totalExecMs: total ? records.reduce((sum, r) => sum + r.execMs, 0) : null,
      exec: durationStats(records.map((r) => ({ seq: r.seq, value: r.execMs }))),
    },
    tokens: {
      input: sumOrNull(records.map((r) => r.input)),
      output: sumOrNull(records.map((r) => r.output)),
      cacheRead: sumOrNull(records.map((r) => r.cacheRead)),
      cacheWrite: sumOrNull(records.map((r) => r.cacheWrite)),
      total: tokenTotal,
      shareOfRoom: null, // 由调用方用合计行 total 填入
      cacheHitRate: cache ? ratio(cache.sumA, cache.sumA + cache.sumB) : null,
      perSession: ratio(tokenTotal, withTokens),
      perCompletedSession: ratio(tokenTotal, byOutcome.completed),
      perStep: tokenPerStep ? ratio(tokenPerStep.sumA, tokenPerStep.sumB) : null,
      outputPerSecond: outputRate ? ratio(outputRate.sumA, outputRate.sumB) : null,
      missingSessions: total - withTokens,
    },
    model: {
      steps,
      stepsPerSession: ratio(steps, withSteps),
      firstResponse: {
        mean: mean(firstResponses),
        median: median(firstResponses),
        missingSessions: total - firstResponses.length,
      },
      missingSessions: total - withSteps,
    },
    tools: {
      total: toolsTotal,
      perSession: ratio(toolsTotal, withTools.length),
      perStep: toolPerStep ? ratio(toolPerStep.sumA, toolPerStep.sumB) : null,
      failed: withTools.length ? failedCount(calls) : null,
      successRate: ratio(knownCalls.length - failedTrue, knownCalls.length),
      unknownOutcomeCalls: calls.length - knownCalls.length,
      missingSessions: total - withTools.length,
    },
  };
}

// 按 (name, isRoomMcp) 汇总；按 count 降序，同数按 name 升序（§2 toolNames、§4.5）。
export function aggregateToolNames(records: SessionRecord[]): ToolNameCount[] {
  const groups = new Map<string, { name: string; isRoomMcp: boolean; calls: NativeToolCall[] }>();
  for (const call of records.flatMap((r) => r.toolCalls ?? [])) {
    const key = `${call.isRoomMcp ? 1 : 0}:${call.name}`;
    const group = groups.get(key) ?? { name: call.name, isRoomMcp: call.isRoomMcp, calls: [] };
    group.calls.push(call);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((g) => ({ name: g.name, isRoomMcp: g.isRoomMcp, count: g.calls.length, failed: failedCount(g.calls) }))
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
