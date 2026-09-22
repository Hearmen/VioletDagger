import type { ComponentProps } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RoomHeader } from '../../src/components/RoomHeader';
import type { Room, RoomStatusPayload } from '../../src/api/types';

const room: Room = {
  id: 1, name: 'room a', schedulingMode: 'sequential', status: 'active',
  completionReason: null, completionReferenceMessageId: null,
  maxSessions: 20, workdir: '/tmp/work', autoConfirmOnSilence: false, createdAt: 'now',
};

function status(overrides: Partial<RoomStatusPayload> = {}): RoomStatusPayload {
  return { currentSessionCount: 3, status: 'active', allCaughtUp: false, agents: [], ...overrides };
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

  it('shows no completion-reason suffix for a manually confirmed room', () => {
    renderHeader({ status: status({ status: 'completed', completionReason: 'manual' }) });
    expect(screen.getByText('已结束 · 只读')).toBeInTheDocument();
    expect(screen.queryByText(/静默期自动确认/)).not.toBeInTheDocument();
  });

  it('shows the auto-silence completion reason with a jump-to-message link', () => {
    const onJumpToMessage = vi.fn();
    renderHeader({
      status: status({ status: 'completed', completionReason: 'auto_silence', completionReferenceMessageId: 55 }),
      onJumpToMessage,
    });
    expect(screen.getByText(/静默期自动确认/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '#55' }));
    expect(onJumpToMessage).toHaveBeenCalledWith(55);
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

  it('falls back to the room snapshot completionReason when getRoomStatus has not reported it yet', () => {
    const { container } = renderHeader({
      room: { ...room, completionReason: 'auto_silence', completionReferenceMessageId: 12 },
      status: status({ status: 'completed' }),
    });
    expect(container.querySelector('.room-header__readonly')?.textContent).toContain('静默期自动确认');
    expect(container.querySelector('.room-header__readonly')?.textContent).toContain('#12');
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

  function renderHeaderEl(props: Partial<ComponentProps<typeof RoomHeader>> = {}) {
    return (
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
      </MemoryRouter>
    );
  }

  it('shows a dismissible banner once every agent has caught up in an active room', () => {
    renderHeader({ status: status({ allCaughtUp: true }) });
    expect(screen.getByRole('alert')).toHaveTextContent('所有 agent 都已完成，看起来任务已经收敛');
  });

  it('shows no caught-up banner while there is still pending work', () => {
    renderHeader({ status: status({ allCaughtUp: false }) });
    expect(screen.queryByText(/看起来任务已经收敛/)).not.toBeInTheDocument();
  });

  it('shows no caught-up banner when the room is not active, even if allCaughtUp is true', () => {
    renderHeader({ status: status({ status: 'paused_manual', allCaughtUp: true }) });
    expect(screen.queryByText(/看起来任务已经收敛/)).not.toBeInTheDocument();
  });

  it('keeps the caught-up banner dismissed across re-renders until allCaughtUp flips back to true', () => {
    const { rerender } = render(renderHeaderEl({ status: status({ allCaughtUp: true }) }));
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(screen.queryByText(/看起来任务已经收敛/)).not.toBeInTheDocument();

    // 仍然是 true：保持已关闭，不重新弹出。
    rerender(renderHeaderEl({ status: status({ allCaughtUp: true }) }));
    expect(screen.queryByText(/看起来任务已经收敛/)).not.toBeInTheDocument();

    // 先变 false（房间重新活跃过一轮），再变回 true：重新出现。
    rerender(renderHeaderEl({ status: status({ allCaughtUp: false }) }));
    rerender(renderHeaderEl({ status: status({ allCaughtUp: true }) }));
    expect(screen.getByText(/看起来任务已经收敛/)).toBeInTheDocument();
  });
});
