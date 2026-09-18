import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { SessionLogView } from '../../src/components/SessionLogView';
import type { SessionLog } from '../../src/hooks/useSessionLog';
import type { LogChunk } from '../../src/api/types';

function makeLog(overrides: Partial<SessionLog> = {}): SessionLog {
  return {
    onData: () => () => {},
    source: 'live',
    truncated: false,
    ended: false,
    error: null,
    connectionState: 'connected',
    ...overrides,
  };
}

describe('SessionLogView', () => {
  it('renders stdout and stderr chunks with distinct stream classes', () => {
    const listeners = new Set<(chunk: LogChunk) => void>();
    const log = makeLog({
      onData: (cb) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    });
    render(<SessionLogView log={log} resetKey="1:2:live" />);
    act(() => {
      listeners.forEach((cb) => cb({ offset: 0, stream: 'stdout', text: 'out' }));
      listeners.forEach((cb) => cb({ offset: 1, stream: 'stderr', text: 'err' }));
    });
    expect(screen.getByText('out')).toHaveClass('log-chunk--stdout');
    expect(screen.getByText('err')).toHaveClass('log-chunk--stderr');
  });

  it('strips ANSI escape sequences before rendering, including split ones', () => {
    const listeners = new Set<(chunk: LogChunk) => void>();
    const log = makeLog({ onData: (cb) => { listeners.add(cb); return () => listeners.delete(cb); } });
    render(<SessionLogView log={log} resetKey="1:2:live" />);
    act(() => {
      listeners.forEach((cb) => cb({ offset: 0, stream: 'stdout', text: '\u001b[0m⚙ \u001b[32mgo\u001b[0m' }));
      // 被切开的两块：ESC[ 与 0m 分别到达
      listeners.forEach((cb) => cb({ offset: 1, stream: 'stdout', text: '\u001b[' }));
      listeners.forEach((cb) => cb({ offset: 2, stream: 'stdout', text: '0mnext' }));
    });
    expect(screen.getByText('⚙ go')).toBeInTheDocument();
    expect(screen.getByText('next')).toBeInTheDocument();
    expect(screen.queryByText(/\[0m/)).not.toBeInTheDocument();
  });

  it('shows truncation, error, and disconnect notices', () => {
    render(
      <SessionLogView
        log={makeLog({ truncated: true, error: 'read failed', connectionState: 'disconnected', ended: false })}
        resetKey="1:2:live"
      />,
    );
    expect(screen.getByText('仅显示部分日志，完整记录请查看详情')).toBeInTheDocument();
    expect(screen.getByText('read failed')).toBeInTheDocument();
    expect(screen.getByText('日志连接已断开，重新打开可获取最近快照')).toBeInTheDocument();
  });

  it('does not warn about disconnection once the stream has ended', () => {
    render(<SessionLogView log={makeLog({ connectionState: 'disconnected', ended: true })} resetKey="1:2:replay" />);
    expect(screen.queryByText('日志连接已断开，重新打开可获取最近快照')).not.toBeInTheDocument();
  });

  it('copies the accumulated text', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const listeners = new Set<(chunk: LogChunk) => void>();
    const log = makeLog({ onData: (cb) => { listeners.add(cb); return () => listeners.delete(cb); } });
    render(<SessionLogView log={log} resetKey="1:2:live" />);
    act(() => listeners.forEach((cb) => cb({ offset: 0, stream: 'stdout', text: 'copy me' })));
    screen.getByRole('button', { name: '复制' }).click();
    expect(writeText).toHaveBeenCalledWith('copy me');
    vi.unstubAllGlobals();
  });
});
