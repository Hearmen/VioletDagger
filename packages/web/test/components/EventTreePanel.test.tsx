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
  return { seq: 1, agentId: 'codex', outcome: 'completed', startedAt: 't1', endedAt: 't2', ...overrides };
}

describe('EventTreePanel', () => {
  it('renders every message as its own row, tagged with its session outcome, sorted by real time', () => {
    const messages: Message[] = [
      makeMessage({ id: 1, sessionSeq: 1, authorId: 'codex', content: 'a fact', createdAt: 't2' }),
      makeMessage({ id: 2, sessionSeq: null, authorId: 'human', type: null, content: 'the goal', createdAt: 't1' }),
    ];
    render(
      <EventTreePanel
        sessions={[makeSession({ seq: 1, agentId: 'codex', outcome: 'completed' })]}
        messages={messages}
        onOpenSession={vi.fn()}
      />,
    );
    expect(screen.getByText('codex #1 · completed')).toBeInTheDocument();
    expect(screen.getByText('a fact')).toBeInTheDocument();
    expect(screen.getByText('人类')).toBeInTheDocument();
    expect(screen.getByText('the goal')).toBeInTheDocument();
    // 真实时间排序：人类消息（t1）在前，agent 消息（t2）在后。
    const rows = screen.getAllByText(/the goal|a fact/);
    expect(rows[0]).toHaveTextContent('the goal');
    expect(rows[1]).toHaveTextContent('a fact');
  });

  it('does not render a separate session node — there is no #seq node to find', () => {
    const messages = [makeMessage({ id: 1, sessionSeq: 1, authorId: 'codex' })];
    render(<EventTreePanel sessions={[makeSession()]} messages={messages} onOpenSession={vi.fn()} />);
    expect(screen.queryByText('#1')).not.toBeInTheDocument();
  });

  it('calls onOpenSession with the seq when a message session tag is clicked', () => {
    const onOpenSession = vi.fn();
    const messages = [makeMessage({ id: 1, sessionSeq: 2, authorId: 'claude', content: 'boom' })];
    render(
      <EventTreePanel
        sessions={[makeSession({ seq: 2, agentId: 'claude', outcome: 'error' })]}
        messages={messages}
        onOpenSession={onOpenSession}
      />,
    );
    fireEvent.click(screen.getByText('claude #2 · error'));
    expect(onOpenSession).toHaveBeenCalledWith(2);
  });

  it('calls onJumpToMessage when a message row is clicked, agent or human', () => {
    const onJumpToMessage = vi.fn();
    const messages = [makeMessage({ id: 5, sessionSeq: null, authorId: 'human', type: null, content: 'ping' })];
    render(
      <EventTreePanel sessions={[]} messages={messages} onOpenSession={vi.fn()} onJumpToMessage={onJumpToMessage} />,
    );
    fireEvent.click(screen.getByText('ping'));
    expect(onJumpToMessage).toHaveBeenCalledWith(5);
  });

  it('shows a passed placeholder message with its outcome tag, without a dedicated session node', () => {
    const messages = [
      makeMessage({ id: 1, sessionSeq: 3, authorId: 'kimi', type: null, content: 'Agent kimi 的 session #3 未发出任何实质消息' }),
    ];
    render(
      <EventTreePanel
        sessions={[makeSession({ seq: 3, agentId: 'kimi', outcome: 'passed' })]}
        messages={messages}
        onOpenSession={vi.fn()}
      />,
    );
    expect(screen.getByText('kimi #3 · passed')).toBeInTheDocument();
    expect(screen.getByText(/未发出任何实质消息/)).toBeInTheDocument();
  });

  it('shows an empty state when there are no messages', () => {
    render(<EventTreePanel sessions={[]} messages={[]} onOpenSession={vi.fn()} />);
    expect(screen.getByText('还没有任何事件')).toBeInTheDocument();
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
