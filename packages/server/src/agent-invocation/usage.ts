import type { SessionUsage } from '../storage';

// 见 04-agent-invocation.md §7：不同 CLI 的 stream-json 输出里，用量信息落在不同的事件类型上，
// 有的一次 session 只有一条，有的每一步（每次真正调用模型）一条、需要累加。
type RawEvent = Record<string, unknown>;

const EMPTY_USAGE: SessionUsage = {
  inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null,
};

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// null 只在"一个都没有"时返回；否则是已知值之和——防止把"没数据"和"是 0"混为一谈。
function sumOrNull(values: (number | null)[]): number | null {
  const present = values.filter((v): v is number => v != null);
  return present.length ? present.reduce((a, b) => a + b, 0) : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

// 日志文件是 JSONL，每行 {offset, stream, text}（04-agent-invocation.md §3）；只看 stdout——
// 结构化事件走 stdout，stderr 是噪音，混进来会破坏按行 JSON 解析。stdout 的 text 片段按 offset
// 顺序拼接后再按换行切分：单次 Node 'data' 事件既可能拆散一行 JSON，也可能挤进好几行。
function parseStdoutEvents(rawLogText: string): RawEvent[] {
  const stdoutChunks: string[] = [];
  for (const envelopeLine of rawLogText.split('\n')) {
    if (!envelopeLine.trim()) continue;
    let envelope: { stream?: string; text?: string };
    try {
      envelope = JSON.parse(envelopeLine);
    } catch {
      continue;
    }
    if (envelope.stream === 'stdout' && typeof envelope.text === 'string') stdoutChunks.push(envelope.text);
  }

  const events: RawEvent[] = [];
  for (const eventLine of stdoutChunks.join('').split('\n')) {
    if (!eventLine.trim()) continue;
    try {
      const parsed = JSON.parse(eventLine);
      if (parsed != null && typeof parsed === 'object') events.push(parsed as RawEvent);
    } catch {
      // 单行不是合法 JSON（罕见的截断/交错）：跳过这一行，不让它拖垮其余事件的解析。
    }
  }
  return events;
}

type UsageExtractor = (events: RawEvent[]) => SessionUsage;

// claude -p --output-format stream-json：单次调用只有一条 type: "result"，防御性地对多条求和。
const extractClaudeUsage: UsageExtractor = (events) => {
  const results = events.filter((e) => e.type === 'result');
  const usages = results.map((e) => asRecord(e.usage));
  return {
    inputTokens: sumOrNull(usages.map((u) => numberOrNull(u.input_tokens))),
    outputTokens: sumOrNull(usages.map((u) => numberOrNull(u.output_tokens))),
    cacheReadTokens: sumOrNull(usages.map((u) => numberOrNull(u.cache_read_input_tokens))),
    cacheWriteTokens: sumOrNull(usages.map((u) => numberOrNull(u.cache_creation_input_tokens))),
    costUsd: sumOrNull(results.map((e) => numberOrNull(e.total_cost_usd))),
  };
};

// opencode --format json：每一步一条 type: "step_finish"，token/费用都是当步数字，必须累加。
const extractOpencodeUsage: UsageExtractor = (events) => {
  const steps = events.filter((e) => e.type === 'step_finish');
  const tokens = steps.map((e) => asRecord(asRecord(e.part).tokens));
  return {
    inputTokens: sumOrNull(tokens.map((t) => numberOrNull(t.input))),
    outputTokens: sumOrNull(tokens.map((t) => numberOrNull(t.output))),
    cacheReadTokens: sumOrNull(tokens.map((t) => numberOrNull(asRecord(t.cache).read))),
    cacheWriteTokens: sumOrNull(tokens.map((t) => numberOrNull(asRecord(t.cache).write))),
    costUsd: sumOrNull(steps.map((e) => numberOrNull(asRecord(e.part).cost))),
  };
};

// codex exec --json：单次调用只有一条 type: "turn.completed"，只有 token 没有费用字段。
const extractCodexUsage: UsageExtractor = (events) => {
  const turns = events.filter((e) => e.type === 'turn.completed');
  const usages = turns.map((e) => asRecord(e.usage));
  return {
    inputTokens: sumOrNull(usages.map((u) => numberOrNull(u.input_tokens))),
    outputTokens: sumOrNull(usages.map((u) => numberOrNull(u.output_tokens))),
    cacheReadTokens: sumOrNull(usages.map((u) => numberOrNull(u.cached_input_tokens))),
    cacheWriteTokens: sumOrNull(usages.map((u) => numberOrNull(u.cache_write_input_tokens))),
    costUsd: null,
  };
};

// kimi 的 stream-json 里没有任何用量遥测；其它/未来新增的 registryKey 默认也没有提取器——
// 全部字段恒为 null，不报错、不用定价表估算（见 04-agent-invocation.md §7）。
const USAGE_EXTRACTORS: Record<string, UsageExtractor> = {
  claude: extractClaudeUsage,
  opencode: extractOpencodeUsage,
  codex: extractCodexUsage,
};

export function extractSessionUsage(registryKey: string, rawLogText: string): SessionUsage {
  const extractor = USAGE_EXTRACTORS[registryKey];
  if (!extractor) return EMPTY_USAGE;
  try {
    return extractor(parseStdoutEvents(rawLogText));
  } catch {
    // 解析失败不影响 outcome 结算，只是这次拿不到用量数据（04-agent-invocation.md §7）。
    return EMPTY_USAGE;
  }
}
