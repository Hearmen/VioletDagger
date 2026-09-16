import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RoomHeader } from '../../src/components/RoomHeader';
import type { Room, RoomStatusPayload } from '../../src/api/types';

const room: Room = { id: 1, name: 'room a', schedulingMode: 'sequential', status: 'active', maxSessions: 20, createdAt: 'now' };

function status(overrides: Partial<RoomStatusPayload> = {}): RoomStatusPayload {
  return { currentSessionCount: 3, status: 'active', agents: [], ...overrides };
}

describe('RoomHeader', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the room name and session count', () => {
    render(<RoomHeader room={room} status={status()} connectionState="connected" onPause={vi.fn()} onResume={vi.fn()} onConfirmCompletion={vi.fn()} />);
    expect(screen.getByText('room a')).toBeInTheDocument();
    expect(screen.getByText('3/20 sessions')).toBeInTheDocument();
  });

  it('calls onPause when active and Pause is clicked', () => {
    const onPause = vi.fn();
    render(<RoomHeader room={room} status={status()} connectionState="connected" onPause={onPause} onResume={vi.fn()} onConfirmCompletion={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(onPause).toHaveBeenCalled();
  });

  it('resumes without a prompt when paused_manual', () => {
    const onResume = vi.fn();
    render(
      <RoomHeader room={room} status={status({ status: 'paused_manual' })} connectionState="connected" onPause={vi.fn()} onResume={onResume} onConfirmCompletion={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(onResume).toHaveBeenCalledWith();
  });

  it('prompts for additionalSessions when paused_limit', () => {
    vi.spyOn(window, 'prompt').mockReturnValue('5');
    const onResume = vi.fn();
    render(
      <RoomHeader room={room} status={status({ status: 'paused_limit' })} connectionState="connected" onPause={vi.fn()} onResume={onResume} onConfirmCompletion={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(onResume).toHaveBeenCalledWith(5);
  });

  it('hides controls when the room is completed', () => {
    render(<RoomHeader room={room} status={status({ status: 'completed' })} connectionState="connected" onPause={vi.fn()} onResume={vi.fn()} onConfirmCompletion={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
  });

  it('shows a disconnect banner when connectionState is disconnected', () => {
    render(
      <RoomHeader room={room} status={status()} connectionState="disconnected" onPause={vi.fn()} onResume={vi.fn()} onConfirmCompletion={vi.fn()} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('连接已断开');
  });

  it('does not show a disconnect banner when connected', () => {
    render(
      <RoomHeader room={room} status={status()} connectionState="connected" onPause={vi.fn()} onResume={vi.fn()} onConfirmCompletion={vi.fn()} />,
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
