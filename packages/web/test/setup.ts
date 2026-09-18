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
});
