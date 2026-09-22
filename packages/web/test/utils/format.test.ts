import { describe, it, expect } from 'vitest';
import { formatTokens, formatCostUsd } from '../../src/utils/format';

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
