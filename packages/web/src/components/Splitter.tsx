import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

// 面板之间的拖动分隔条（见 07-frontend.md §3）。用 Pointer Events + setPointerCapture，
// 按增量回调 onDrag(delta)；delta 的轴向由 orientation 决定。
export function Splitter(props: {
  orientation: 'v' | 'h';
  area: 'agents' | 'events' | 'memory';
  onDrag: (delta: number) => void;
}) {
  const lastRef = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);

  // 拖动中组件被卸载（比如切走页面）时，别把 body 上的光标/禁选状态留下。
  useEffect(() => () => {
    document.body.classList.remove('is-resizing-x', 'is-resizing-y');
  }, []);

  function handleDown(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    lastRef.current = props.orientation === 'v' ? event.clientX : event.clientY;
    setDragging(true);
    document.body.classList.add(props.orientation === 'v' ? 'is-resizing-x' : 'is-resizing-y');
  }

  function handleMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (lastRef.current == null) return;
    const current = props.orientation === 'v' ? event.clientX : event.clientY;
    const delta = current - lastRef.current;
    if (delta !== 0) {
      lastRef.current = current;
      props.onDrag(delta);
    }
  }

  function handleUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (lastRef.current == null) return;
    lastRef.current = null;
    setDragging(false);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    document.body.classList.remove('is-resizing-x', 'is-resizing-y');
  }

  return (
    <div
      role="separator"
      aria-orientation={props.orientation === 'v' ? 'vertical' : 'horizontal'}
      aria-label={`resize ${props.area}`}
      className={`splitter splitter--${props.orientation} splitter--${props.area} ${dragging ? 'is-dragging' : ''}`}
      onPointerDown={handleDown}
      onPointerMove={handleMove}
      onPointerUp={handleUp}
      onPointerCancel={handleUp}
    />
  );
}
