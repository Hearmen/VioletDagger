import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Splitter } from '../../src/components/Splitter';

describe('Splitter', () => {
  it('reports incremental drag deltas for a vertical splitter', () => {
    const onDrag = vi.fn();
    render(<Splitter orientation="v" area="agents" onDrag={onDrag} />);
    const el = screen.getByRole('separator');
    expect(el).toHaveAttribute('aria-orientation', 'vertical');
    expect(el).toHaveAttribute('aria-label', 'resize agents');

    fireEvent.pointerDown(el, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(el, { clientX: 130, pointerId: 1 });
    expect(onDrag).toHaveBeenLastCalledWith(30);

    fireEvent.pointerMove(el, { clientX: 150, pointerId: 1 });
    expect(onDrag).toHaveBeenLastCalledWith(20);

    fireEvent.pointerUp(el, { clientX: 150, pointerId: 1 });
    fireEvent.pointerMove(el, { clientX: 200, pointerId: 1 });
    expect(onDrag).toHaveBeenCalledTimes(2);
  });

  it('uses clientY for a horizontal splitter', () => {
    const onDrag = vi.fn();
    render(<Splitter orientation="h" area="memory" onDrag={onDrag} />);
    const el = screen.getByRole('separator');
    expect(el).toHaveAttribute('aria-orientation', 'horizontal');

    fireEvent.pointerDown(el, { clientY: 50, pointerId: 1 });
    fireEvent.pointerMove(el, { clientY: 80, pointerId: 1 });
    expect(onDrag).toHaveBeenLastCalledWith(30);
  });

  it('clears the dragging body class on unmount', () => {
    const { unmount } = render(<Splitter orientation="v" area="agents" onDrag={vi.fn()} />);
    const el = screen.getByRole('separator');
    fireEvent.pointerDown(el, { clientX: 10, pointerId: 1 });
    expect(document.body.classList.contains('is-resizing-x')).toBe(true);
    unmount();
    expect(document.body.classList.contains('is-resizing-x')).toBe(false);
  });
});
