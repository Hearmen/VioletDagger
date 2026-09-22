import { describe, it, expect } from 'vitest';
import { extractSessionUsage } from '../../src/agent-invocation/usage';

// 日志文件是 JSONL，每行 {offset, stream, text}（04-agent-invocation.md §3）。
function envelopeLine(stream: 'stdout' | 'stderr', text: string, offset = 0): string {
  return JSON.stringify({ offset, stream, text });
}

describe('extractSessionUsage', () => {
  it('claude: reads usage/cost off the single "result" event', () => {
    const event = {
      type: 'result',
      total_cost_usd: 0.2814792,
      usage: {
        input_tokens: 20,
        output_tokens: 6997,
        cache_read_input_tokens: 401226,
        cache_creation_input_tokens: 32806,
      },
    };
    const log = envelopeLine('stdout', `${JSON.stringify(event)}\n`);
    expect(extractSessionUsage('claude', log)).toEqual({
      inputTokens: 20, outputTokens: 6997, cacheReadTokens: 401226, cacheWriteTokens: 32806, costUsd: 0.2814792,
    });
  });

  it('claude: sums multiple "result" events defensively', () => {
    const one = { type: 'result', total_cost_usd: 0.1, usage: { input_tokens: 10, output_tokens: 20 } };
    const two = { type: 'result', total_cost_usd: 0.2, usage: { input_tokens: 5, output_tokens: 15 } };
    const log = envelopeLine('stdout', `${JSON.stringify(one)}\n${JSON.stringify(two)}\n`);
    const result = extractSessionUsage('claude', log);
    expect(result).toMatchObject({ inputTokens: 15, outputTokens: 35, cacheReadTokens: null, cacheWriteTokens: null });
    expect(result.costUsd).toBeCloseTo(0.3);
  });

  it('opencode: sums tokens/cost across multiple "step_finish" events', () => {
    const step1 = {
      type: 'step_finish',
      part: { tokens: { total: 19080, input: 150, output: 232, cache: { write: 0, read: 18304 } }, cost: 0.000453012 },
    };
    const step2 = {
      type: 'step_finish',
      part: { tokens: { total: 19280, input: 153, output: 122, cache: { write: 10, read: 18944 } }, cost: 0.000189582 },
    };
    const log = envelopeLine('stdout', `${JSON.stringify(step1)}\n${JSON.stringify(step2)}\n`);
    const result = extractSessionUsage('opencode', log);
    expect(result).toMatchObject({ inputTokens: 303, outputTokens: 354, cacheReadTokens: 37248, cacheWriteTokens: 10 });
    expect(result.costUsd).toBeCloseTo(0.000642594);
  });

  it('codex: reads token counts off "turn.completed" but never reports a cost', () => {
    const event = {
      type: 'turn.completed',
      usage: {
        input_tokens: 350549, cached_input_tokens: 297088, cache_write_input_tokens: 0,
        output_tokens: 4122, reasoning_output_tokens: 49,
      },
    };
    const log = envelopeLine('stdout', `${JSON.stringify(event)}\n`);
    expect(extractSessionUsage('codex', log)).toEqual({
      inputTokens: 350549, outputTokens: 4122, cacheReadTokens: 297088, cacheWriteTokens: 0, costUsd: null,
    });
  });

  it('kimi: has no usage telemetry at all, returns all-null regardless of log content', () => {
    const log = envelopeLine('stdout', `${JSON.stringify({ role: 'assistant', content: 'hi' })}\n`);
    expect(extractSessionUsage('kimi', log)).toEqual({
      inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null,
    });
  });

  it('unknown registryKey: returns all-null without throwing', () => {
    expect(extractSessionUsage('some-future-agent', 'garbage')).toEqual({
      inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null,
    });
  });

  it('ignores stderr content when looking for usage events', () => {
    const event = { type: 'result', total_cost_usd: 0.5, usage: { input_tokens: 1, output_tokens: 2 } };
    const log = envelopeLine('stderr', `${JSON.stringify(event)}\n`);
    expect(extractSessionUsage('claude', log)).toEqual({
      inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null,
    });
  });

  it('two stdout writes that concatenate two JSON lines without a clean split still parse (kimi log-capture quirk)', () => {
    const event = { type: 'result', total_cost_usd: 0.1, usage: { input_tokens: 1, output_tokens: 2 } };
    // 模拟一次 Node 'data' 事件里拼进了两行完整 JSON（真实观测到的现象：见 room 7 kimi 日志）。
    const combinedText = `${JSON.stringify({ role: 'meta' })}\n${JSON.stringify(event)}\n`;
    const log = envelopeLine('stdout', combinedText);
    expect(extractSessionUsage('claude', log)).toMatchObject({ inputTokens: 1, outputTokens: 2, costUsd: 0.1 });
  });

  it('a malformed line is skipped without breaking the rest of the parse', () => {
    const event = { type: 'result', total_cost_usd: 0.1, usage: { input_tokens: 1, output_tokens: 2 } };
    const log = envelopeLine('stdout', `not json at all\n${JSON.stringify(event)}\n`);
    expect(extractSessionUsage('claude', log)).toMatchObject({ inputTokens: 1, outputTokens: 2, costUsd: 0.1 });
  });

  it('an empty log produces all-null usage', () => {
    expect(extractSessionUsage('claude', '')).toEqual({
      inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null,
    });
  });
});
