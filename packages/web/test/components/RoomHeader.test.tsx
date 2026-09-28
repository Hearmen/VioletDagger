import type { ComponentProps } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RoomHeader } from '../../src/components/RoomHeader';
import type { Room, RoomStatusPayload } from '../../src/api/types';

const room: Room = {
  id: 1, name: 'room a', schedulingMode: 'sequential', status: 'active',
  maxSessions: 20, workdir: '/tmp/work', createdAt: 'now',
};

function status(overrides: Partial<RoomStatusPayload> = {}): RoomStatusPayload {
  return { currentSessionCount: 3, status: 'active', dispatchIdle: false, disabledAgentCount: 0, agents: [], ...overrides };
}

function renderHeader(props: Partial<ComponentProps<typeof RoomHeader>> = {}) {
  return render(
    <MemoryRouter>
      <RoomHeader
        room={room}
        status={status()}
        connectionState="connected"
        onPause={vi.fn()}
        onResume={vi.fn()}
        onConfirmCompletion={vi.fn()}
        {...props}
      />
    </MemoryRouter>,
  );
}

describe('RoomHeader', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the room name and session count', () => {
    renderHeader();
    expect(screen.getByText('room a')).toBeInTheDocument();
    expect(screen.getByText('3/20 sessions')).toBeInTheDocument();
  });

  it('calls onPause when active and Pause is clicked', () => {
    const onPause = vi.fn();
    renderHeader({ onPause });
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(onPause).toHaveBeenCalled();
  });

  it('resumes without a prompt when paused_manual', () => {
    const onResume = vi.fn();
    renderHeader({ status: status({ status: 'paused_manual' }), onResume });
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(onResume).toHaveBeenCalledWith();
  });

  it('prompts for additionalSessions when paused_limit', () => {
    vi.spyOn(window, 'prompt').mockReturnValue('5');
    const onResume = vi.fn();
    renderHeader({ status: status({ status: 'paused_limit' }), onResume });
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(onResume).toHaveBeenCalledWith(5);
  });

  it('confirms before ending the room', () => {
    const onConfirmCompletion = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderHeader({ onConfirmCompletion });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Completion' }));
    expect(onConfirmCompletion).toHaveBeenCalled();
  });

  it('hides controls when the room is completed', () => {
    renderHeader({ status: status({ status: 'completed' }) });
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm Completion' })).not.toBeInTheDocument();
  });

  it('shows the read-only label for a completed room', () => {
    renderHeader({ status: status({ status: 'completed' }) });
    expect(screen.getByText('已结束 · 只读')).toBeInTheDocument();
  });

  it('shows the room total usage next to the session count when provided', () => {
    renderHeader({
      roomUsage: {
        inputTokens: 8000, outputTokens: 4345, cacheReadTokens: 0, cacheWriteTokens: 0,
        costUsd: 0.28, sessionCount: 3, sessionsWithoutTokens: 0, sessionsWithoutCost: 0,
      },
    });
    expect(screen.getByText('room a')).toBeInTheDocument();
    expect(document.querySelector('.room-header__usage')?.textContent).toContain('12.3k tok');
    expect(document.querySelector('.room-header__usage')?.textContent).toContain('$0.28');
  });

  it('shows no room usage summary when no session has finished yet', () => {
    renderHeader({
      roomUsage: {
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        costUsd: null, sessionCount: 0, sessionsWithoutTokens: 0, sessionsWithoutCost: 0,
      },
    });
    expect(document.querySelector('.room-header__usage')).not.toBeInTheDocument();
  });

  it('offers a Delete Room button for a completed room and confirms before deleting', () => {
    const onDeleteRoom = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderHeader({ status: status({ status: 'completed' }), onDeleteRoom });

    fireEvent.click(screen.getByRole('button', { name: 'Delete Room' }));
    expect(onDeleteRoom).toHaveBeenCalled();
  });

  it('does not delete when the confirmation is dismissed', () => {
    const onDeleteRoom = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderHeader({ status: status({ status: 'completed' }), onDeleteRoom });

    fireEvent.click(screen.getByRole('button', { name: 'Delete Room' }));
    expect(onDeleteRoom).not.toHaveBeenCalled();
  });

  it('shows a disconnect banner when connectionState is disconnected', () => {
    renderHeader({ connectionState: 'disconnected' });
    expect(screen.getByRole('alert')).toHaveTextContent('连接已断开');
  });

  it('shows a propose_completion banner that can be dismissed', () => {
    renderHeader({ proposeCompletionId: 5 });
    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent('有 agent 提议完成这个房间');
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not show a disconnect banner when connected', () => {
    renderHeader();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a dismissible no-dispatch banner with the disabled agent count', () => {
    renderHeader({ status: status({ dispatchIdle: true, disabledAgentCount: 2 }) });
    expect(screen.getByRole('alert')).toHaveTextContent('当前没有任务可派发');
    expect(screen.getByRole('alert')).toHaveTextContent('（2 个 agent 已停用派发）');
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(screen.queryByText(/当前没有任务可派发/)).not.toBeInTheDocument();
  });

  it('keeps the no-dispatch banner dismissed until dispatchIdle flips back to true', () => {
    const header = (dispatchIdle: boolean) => (
      <MemoryRouter>
        <RoomHeader room={room} status={status({ dispatchIdle })} connectionState="connected"
          onPause={vi.fn()} onResume={vi.fn()} onConfirmCompletion={vi.fn()} />
      </MemoryRouter>
    );
    const { rerender } = render(header(true));
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    rerender(header(true));
    expect(screen.queryByText(/当前没有任务可派发/)).not.toBeInTheDocument();
    rerender(header(false));
    rerender(header(true));
    expect(screen.getByText(/当前没有任务可派发/)).toBeInTheDocument();
  });
});
