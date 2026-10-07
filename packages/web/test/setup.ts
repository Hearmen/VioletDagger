import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom 没有 PointerEvent；Splitter 用 Pointer Events，测试里用 MouseEvent 顶上。
if (typeof window !== 'undefined' && !('PointerEvent' in window)) {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    pointerType: string;
    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 1;
      this.pointerType = params.pointerType ?? 'mouse';
    }
  }
  // @ts-expect-error 补进 jsdom 的 window
  window.PointerEvent = PointerEventPolyfill;
}

afterEach(() => {
  cleanup();
  // 切换语言的用例不得影响后续用例（09-frontend-i18n.md §7）。
  try {
    window.localStorage.removeItem('vd.locale');
  } catch {
    // 存储不可用时无需清理
  }
  document.documentElement.lang = 'zh-CN';
});
