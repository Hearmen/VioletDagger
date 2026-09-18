import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDashboardLayout } from '../../src/hooks/useDashboardLayout';

describe('useDashboardLayout', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('clamps agent width adjustments to its limits', () => {
    const { result } = renderHook(() => useDashboardLayout());

    act(() => result.current.adjustAgentsW(-9999));
    expect(result.current.layout.agentsW).toBe(160);

    act(() => result.current.adjustAgentsW(9999));
    expect(result.current.layout.agentsW).toBe(420);
  });

  it('shrinks the events column when dragged to the right (inverse delta)', () => {
    const { result } = renderHook(() => useDashboardLayout());
    const before = result.current.layout.eventsW;

    act(() => result.current.adjustEventsW(50));
    expect(result.current.layout.eventsW).toBe(before - 50);
  });

  it('persists the layout to localStorage', () => {
    const { result } = renderHook(() => useDashboardLayout());

    act(() => result.current.adjustMemoryH(20));

    const stored = JSON.parse(window.localStorage.getItem('vd.dashboard.layout')!);
    expect(stored.memoryH).toBe(result.current.layout.memoryH);
    expect(stored.agentsW).toBe(result.current.layout.agentsW);
  });

  it('falls back to defaults when stored layout is corrupt', () => {
    window.localStorage.setItem('vd.dashboard.layout', '{not json');
    const { result } = renderHook(() => useDashboardLayout());
    expect(result.current.layout.agentsW).toBe(240);
    expect(result.current.layout.eventsW).toBe(400);
  });
});
