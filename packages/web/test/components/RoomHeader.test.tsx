import type { ComponentProps } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RoomHeader } from '../../src/components/RoomHeader';
import type { Room, RoomStatusPayload } from '../../src/api/types';

const room: Room = { id: 1, name: 'room a', schedulingMode: 'sequential', status: 'active', maxSessions: 20, workdir: '/tmp/work', createdAt: 'now' };

function status(overrides: Partial<RoomStatusPayload> = {}): RoomStatusPayload {
  return { currentSessionCount: 3, status: 'active', agents: [], ...overrides };
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
});
