import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EventTreePanel } from '../../src/components/EventTreePanel';
import { SessionDetailModal } from '../../src/components/SessionDetailModal';
import type { EventTreePayload, Message, SessionDetailPayload } from '../../src/api/types';

vi.mock('../../src/hooks/useSessionLog', () => ({
  useSessionLog: () => ({
    onData: () => () => {},
    source: 'snapshot',
    truncated: false,
    ended: true,
    error: null,
    connectionState: 'disconnected',
  }),
}));

vi.mock('../../src/components/SessionLogView', () => ({
  SessionLogView: ({ resetKey }: { resetKey: string }) => (
    <div data-testid="session-log-view" data-key={resetKey} />
  ),
}));

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 1, roomId: 1, sessionSeq: 1, authorId: 'codex', type: 'fact', content: 'a fact',
    summary: 'a fact', targetMessageId: null, referencedMessageIds: [], exploringStatus: null,
    exploringNote: null, createdAt: 't1', ...overrides,
  };
}

function makeSession(overrides: Partial<EventTreePayload['sessions'][number]> = {}): EventTreePayload['sessions'][number] {
  return {
    seq: 1, agentId: 'codex', outcome: 'completed', startedAt: 't1', endedAt: 't2',
    lifecycleEvents: [], messages: [makeMessage()], ...overrides,
  };
}

describe('EventTreePanel', () => {
  it('renders sessions in order with their outcome and messages', () => {
    render(<EventTreePanel sessions={[makeSession()]} humanMessages={[]} onOpenSession={vi.fn()} />);
    expect(screen.getByRole('button', { name: /#1/ })).toBeInTheDocument();
    expect(screen.getByText('codex')).toBeInTheDocument();
    expect(screen.getByText('a fact')).toBeInTheDocument();
  });

  it('calls onOpenSession with the seq when a session node is clicked', () => {
    const onOpenSession = vi.fn();
    render(
      <EventTreePanel
        sessions={[makeSession({ seq: 2, agentId: 'claude', outcome: 'error', messages: [] })]}
        humanMessages={[]}
        onOpenSession={onOpenSession}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /#2/ }));
    expect(onOpenSession).toHaveBeenCalledWith(2);
  });

  it('interleaves human messages as their own nodes', () => {
    const sessions = [makeSession({ seq: 1, outcome: 'passed', startedAt: 't2', endedAt: 't3', messages: [] })];
    const humanMessages: Message[] = [
      makeMessage({ id: 9, sessionSeq: null, authorId: 'human', type: null, content: 'the goal', createdAt: 't1' }),
    ];
    render(<EventTreePanel sessions={sessions} humanMessages={humanMessages} onOpenSession={vi.fn()} />);
    expect(screen.getByText('人类')).toBeInTheDocument();
    expect(screen.getByText('the goal')).toBeInTheDocument();
  });

  it('shows an empty state when there are no sessions', () => {
    render(<EventTreePanel sessions={[]} humanMessages={[]} onOpenSession={vi.fn()} />);
    expect(screen.getByText('还没有任何 session')).toBeInTheDocument();
  });
});

describe('SessionDetailModal', () => {
  function makeDetail(overrides: Partial<SessionDetailPayload> = {}): SessionDetailPayload {
    return {
      sessionId: 7, agentId: 'codex', startedAt: 't1', endedAt: 't2', outcome: 'completed',
      messages: [makeMessage({ id: 42, content: 'a session fact' })],
      lifecycleEvents: [],
      exitCode: 0, exitSignal: null, stopIntent: null, cleanupStartedAt: null, exitCause: 'natural',
      rawLog: 'raw output', wroteMessages: true, ...overrides,
    };
  }

  it('renders nothing when detail is null', () => {
    const { container } = render(<SessionDetailModal roomId={1} detail={null} onClose={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the session messages, lifecycle events, and a read-only replay log, and calls onClose', () => {
    const onClose = vi.fn();
    const detail = makeDetail({
      lifecycleEvents: [
        { id: 1, roomId: 1, sessionSeq: 7, kind: 'terminate_requested', attemptId: '', detail: null, createdAt: 't1' },
        { id: 2, roomId: 1, sessionSeq: 7, kind: 'process_exited', attemptId: '', detail: null, createdAt: 't2' },
      ],
    });
    render(<SessionDetailModal roomId={1} detail={detail} onClose={onClose} />);
    const log = screen.getByTestId('session-log-view');
    expect(log).toHaveAttribute('data-key', '1:7:replay');
    expect(screen.getByText('#7')).toBeInTheDocument();
    expect(screen.getByText('a session fact')).toBeInTheDocument();
    expect(screen.getByText('请求人工终止')).toBeInTheDocument();
    expect(screen.getByText('进程退出')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('marks a running session as a snapshot', () => {
    render(<SessionDetailModal roomId={1} detail={makeDetail({ outcome: 'running', endedAt: null })} onClose={vi.fn()} />);
    expect(screen.getByText('尚未结束 · 日志快照')).toBeInTheDocument();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<SessionDetailModal roomId={1} detail={makeDetail()} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
