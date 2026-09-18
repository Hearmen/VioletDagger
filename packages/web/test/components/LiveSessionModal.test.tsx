import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LiveSessionModal, type LiveSessionSnapshot, type LiveSessionTarget } from '../../src/components/LiveSessionModal';

vi.mock('../../src/hooks/useSessionLog', () => ({
  useSessionLog: () => ({
    onData: () => () => {},
    source: 'live',
    truncated: false,
    ended: false,
    error: null,
    connectionState: 'connected',
  }),
}));

vi.mock('../../src/components/SessionLogView', () => ({
  SessionLogView: () => <div data-testid="session-log-view" />,
}));

function renderModal(overrides: {
  target?: Partial<LiveSessionTarget>;
  snapshot?: LiveSessionSnapshot | null;
  roomConnected?: boolean;
  onTerminate?: (sessionId: number) => Promise<void>;
} = {}) {
  const onTerminate = overrides.onTerminate ?? vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  const props = {
    target: {
      roomId: 1,
      sessionId: 7,
      agentId: 'claude',
      startedAt: new Date().toISOString(),
      ...overrides.target,
    },
    snapshot: overrides.snapshot === undefined
      ? { outcome: 'running' as const, endedAt: null, exitCode: null, exitCause: null }
      : overrides.snapshot,
    roomConnected: overrides.roomConnected ?? true,
    onTerminate,
    onClose,
  };
  render(<LiveSessionModal {...props} />);
  return { onTerminate, onClose };
}

describe('LiveSessionModal', () => {
  it('renders the read-only live log with session metadata', () => {
    renderModal();
    expect(screen.getByTestId('session-log-view')).toBeInTheDocument();
    expect(screen.getByText('claude')).toBeInTheDocument();
    expect(screen.getByText('#7')).toBeInTheDocument();
    expect(screen.getByText('实时只读日志')).toBeInTheDocument();
    expect(screen.getByText('运行中')).toBeInTheDocument();
  });

  it('terminates the fixed session', async () => {
    const { onTerminate } = renderModal();
    fireEvent.click(screen.getByRole('button', { name: '终止' }));
    await waitFor(() => expect(onTerminate).toHaveBeenCalledWith(7));
  });

  it('disables terminate when the room is disconnected', () => {
    renderModal({ roomConnected: false });
    expect(screen.getByRole('button', { name: '终止' })).toBeDisabled();
    expect(screen.getByText('房间连接已断开，无法终止')).toBeInTheDocument();
  });

  it('hides termination once the session is terminal', () => {
    renderModal({ snapshot: { outcome: 'completed', endedAt: 't2', exitCode: 0, exitCause: 'natural' } });
    expect(screen.getByRole('button', { name: '终止' })).toBeDisabled();
  });

  it('shows a cleanup-failure warning from the snapshot', () => {
    renderModal({ snapshot: { outcome: 'stopping', endedAt: null, exitCode: null, exitCause: null, exitWarning: '清理未确认' } });
    expect(screen.getByText('清理未确认')).toBeInTheDocument();
  });

  it('closes on Escape and on backdrop click', () => {
    const { onClose } = renderModal();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
