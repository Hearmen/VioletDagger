import { describe, it, expect } from 'vitest';
import { createT } from '../../src/i18n/translate';
import {
  authorInitial, authorLabel, formatCostUsd, formatRelative, formatTokens, formatUsageParts, outcomeLabel, typeLabel,
} from '../../src/utils/format';

describe('formatTokens', () => {
  it('shows a raw number under 1000', () => {
    expect(formatTokens(42)).toBe('42 tok');
  });

  it('shows one decimal in k for thousands', () => {
    expect(formatTokens(12345)).toBe('12.3k tok');
  });

  it('shows one decimal in m for millions', () => {
    expect(formatTokens(2_500_000)).toBe('2.5m tok');
  });
});

describe('formatCostUsd', () => {
  it('shows a bare $0 for exactly zero', () => {
    expect(formatCostUsd(0)).toBe('$0');
  });

  it('shows two decimals for amounts >= a cent', () => {
    expect(formatCostUsd(0.28)).toBe('$0.28');
  });

  it('shows four decimals for sub-cent amounts so they are not rounded away to $0.00', () => {
    expect(formatCostUsd(0.000642594)).toBe('$0.0006');
  });
});

describe('localized format helpers', () => {
  const zhT = createT('zh');
  const enT = createT('en');

  it('labels reserved authors per locale and passes agent ids through', () => {
    expect(authorLabel('human', zhT)).toBe('人类');
    expect(authorLabel('system', enT)).toBe('System');
    expect(authorLabel('codex', enT)).toBe('codex');
    expect(authorInitial('human', enT)).toBe('H');
    expect(authorInitial('system', zhT)).toBe('系');
  });

  it('formats relative time per locale', () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(formatRelative(fiveMinutesAgo, zhT)).toBe('5 分钟前');
    expect(formatRelative(fiveMinutesAgo, enT)).toBe('5 min ago');
  });

  it('only translates the propose_completion type label', () => {
    expect(typeLabel('propose_completion', zhT)).toBe('提议完成');
    expect(typeLabel('propose_completion', enT)).toBe('propose completion');
    expect(typeLabel('fact', zhT)).toBe('fact');
  });

  it('only translates the running outcome', () => {
    expect(outcomeLabel('running', enT)).toBe('running');
    expect(outcomeLabel('running', zhT)).toBe('运行中');
    expect(outcomeLabel('terminated', zhT)).toBe('terminated');
  });

  it('builds usage parts with cache items only when non-zero', () => {
    const usage = {
      inputTokens: 1200, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 5,
      costUsd: null, sessionCount: 1, sessionsWithoutTokens: 0, sessionsWithoutCost: 0,
    };
    expect(formatUsageParts(usage, zhT, 'zh')).toEqual(['输入 1,200', '输出 30', '缓存写 5']);
    expect(formatUsageParts(usage, enT, 'en')).toEqual(['input 1,200', 'output 30', 'cache write 5']);
  });
});
