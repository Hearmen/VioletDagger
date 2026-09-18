import { useCallback, useEffect, useState, type CSSProperties } from 'react';

export interface DashboardLayout {
  agentsW: number;
  eventsW: number;
  memoryH: number;
}

const STORAGE_KEY = 'vd.dashboard.layout';
const AGENTS_LIMITS = { min: 160, max: 420 };
const EVENTS_LIMITS = { min: 260, max: 720 };

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function viewportHeight(): number {
  return typeof window === 'undefined' ? 900 : window.innerHeight;
}

function memoryLimits(): { min: number; max: number } {
  return { min: 120, max: Math.max(160, viewportHeight() - 160) };
}

function defaults(): DashboardLayout {
  const limits = memoryLimits();
  return {
    agentsW: 240,
    eventsW: 400,
    memoryH: clamp(Math.round(viewportHeight() * 0.4), limits.min, limits.max),
  };
}

// localStorage 里可能是旧值/被手改过，读取时一律校验并夹到当前视口的合法范围。
function sanitize(raw: unknown): DashboardLayout | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.agentsW !== 'number' || typeof value.eventsW !== 'number' || typeof value.memoryH !== 'number') {
    return null;
  }
  const limits = memoryLimits();
  return {
    agentsW: clamp(value.agentsW, AGENTS_LIMITS.min, AGENTS_LIMITS.max),
    eventsW: clamp(value.eventsW, EVENTS_LIMITS.min, EVENTS_LIMITS.max),
    memoryH: clamp(value.memoryH, limits.min, limits.max),
  };
}

// 面板尺寸状态：左栏宽、右栏宽、中列"记忆 / 消息流"的上下高度。持久化到 localStorage（见 07-frontend.md §3）。
export function useDashboardLayout() {
  const [layout, setLayout] = useState<DashboardLayout>(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = sanitize(JSON.parse(stored));
        if (parsed) return parsed;
      }
    } catch {
      // 存储不可用/内容损坏，退回默认值
    }
    return defaults();
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
    } catch {
      // 忽略写入失败（隐私模式等）
    }
  }, [layout]);

  const adjustAgentsW = useCallback((delta: number) => {
    setLayout((current) => ({
      ...current,
      agentsW: clamp(current.agentsW + delta, AGENTS_LIMITS.min, AGENTS_LIMITS.max),
    }));
  }, []);

  // vsplit2 向右拖（delta>0）是缩小右栏，所以这里减去 delta。
  const adjustEventsW = useCallback((delta: number) => {
    setLayout((current) => ({
      ...current,
      eventsW: clamp(current.eventsW - delta, EVENTS_LIMITS.min, EVENTS_LIMITS.max),
    }));
  }, []);

  const adjustMemoryH = useCallback((delta: number) => {
    setLayout((current) => {
      const limits = memoryLimits();
      return { ...current, memoryH: clamp(current.memoryH + delta, limits.min, limits.max) };
    });
  }, []);

  const style = {
    '--agents-w': `${layout.agentsW}px`,
    '--events-w': `${layout.eventsW}px`,
    '--memory-h': `${layout.memoryH}px`,
  } as CSSProperties;

  return { layout, adjustAgentsW, adjustEventsW, adjustMemoryH, style };
}
