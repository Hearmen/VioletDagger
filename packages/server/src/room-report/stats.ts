// 统计工具函数（10-room-report.md §4 通用规则）。

export type Ratio = number | null;

export interface DurationStats {
  mean: number | null;
  median: number | null;
  p90: number | null;
  max: number | null;
  maxSeq: number | null;
}

// 只对非 null 值求和；全为 null（或没有值）时为 null。
export function sumOrNull(values: (number | null)[]): number | null {
  let total: number | null = null;
  for (const value of values) if (value != null) total = (total ?? 0) + value;
  return total;
}

// 分母为 0 或任一方缺失时为 null。
export function ratio(numerator: number | null, denominator: number | null): Ratio {
  if (numerator == null || denominator == null || denominator === 0) return null;
  return numerator / denominator;
}

export function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

// 排序后取中间值，偶数个取中间两个的平均。
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// 最近秩法：排序后第 ceil(0.9 × n) 个。
export function p90(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.9 * sorted.length) - 1];
}

// 样本带 seq；最大值同值时取 seq 最小的那个。
export function durationStats(samples: { seq: number; value: number }[]): DurationStats {
  const values = samples.map((s) => s.value);
  let maxSample: { seq: number; value: number } | null = null;
  for (const sample of samples) {
    if (!maxSample || sample.value > maxSample.value || (sample.value === maxSample.value && sample.seq < maxSample.seq)) {
      maxSample = sample;
    }
  }
  return {
    mean: mean(values),
    median: median(values),
    p90: p90(values),
    max: maxSample?.value ?? null,
    maxSeq: maxSample?.seq ?? null,
  };
}
