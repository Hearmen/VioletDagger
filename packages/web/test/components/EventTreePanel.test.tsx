import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react';
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
    inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null,
    ...overrides,
  };
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
    expect(screen.getByText('codex #1 · done')).toBeInTheDocument();
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

  it('appends a compact token count to the session tag when both input and output tokens are known', () => {
    const messages = [makeMessage({ id: 1, sessionSeq: 1, authorId: 'codex' })];
    render(
      <EventTreePanel
        sessions={[makeSession({ seq: 1, agentId: 'codex', outcome: 'completed', inputTokens: 8000, outputTokens: 4345 })]}
        messages={messages}
        onOpenSession={vi.fn()}
      />,
    );
    expect(screen.getByText('codex #1 · done · 12.3k tok')).toBeInTheDocument();
  });

  it('appends the total run time of an ended session between the outcome and the token count', () => {
    const messages = [makeMessage({ id: 1, sessionSeq: 1, authorId: 'codex' })];
    render(
      <EventTreePanel
        sessions={[makeSession({
          seq: 1, agentId: 'codex', outcome: 'completed',
          startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:03:25.000Z',
          inputTokens: 8000, outputTokens: 4345,
        })]}
        messages={messages}
        onOpenSession={vi.fn()}
      />,
    );
    expect(screen.getByText('codex #1 · done · 03:25 · 12.3k tok')).toBeInTheDocument();
  });

  it('formats run times over an hour as h:mm:ss', () => {
    const messages = [makeMessage({ id: 1, sessionSeq: 1, authorId: 'codex' })];
    render(
      <EventTreePanel
        sessions={[makeSession({
          seq: 1, agentId: 'codex', outcome: 'error',
          startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T01:02:03.000Z',
        })]}
        messages={messages}
        onOpenSession={vi.fn()}
      />,
    );
    expect(screen.getByText('codex #1 · error · 1:02:03')).toBeInTheDocument();
  });

  it('shows no run time while the session is still running', () => {
    const messages = [makeMessage({ id: 1, sessionSeq: 1, authorId: 'codex' })];
    render(
      <EventTreePanel
        sessions={[makeSession({ seq: 1, agentId: 'codex', outcome: 'running', startedAt: '2026-01-01T00:00:00.000Z', endedAt: null })]}
        messages={messages}
        onOpenSession={vi.fn()}
      />,
    );
    expect(screen.getByText('codex #1')).toBeInTheDocument();
  });

  it('omits the token suffix when the agent does not report token usage', () => {
    const messages = [makeMessage({ id: 1, sessionSeq: 3, authorId: 'kimi' })];
    render(
      <EventTreePanel
        sessions={[makeSession({ seq: 3, agentId: 'kimi', outcome: 'passed', inputTokens: null, outputTokens: null })]}
        messages={messages}
        onOpenSession={vi.fn()}
      />,
    );
    expect(screen.getByText('kimi #3 · passed')).toBeInTheDocument();
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
      inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null,
      rawLog: 'raw output', wroteMessages: true, ...overrides,
    };
  }

  it('shows a usage line with cache/cost breakdown when input and output tokens are known', () => {
    const detail = makeDetail({
      inputTokens: 20, outputTokens: 6997, cacheReadTokens: 401226, cacheWriteTokens: 32806, costUsd: 0.28,
    });
    render(<SessionDetailModal roomId={1} detail={detail} onClose={vi.fn()} />);
    const usage = screen.getByTestId('session-usage');
    expect(usage).toHaveTextContent('输入 20');
    expect(usage).toHaveTextContent('输出 6,997');
    expect(usage).toHaveTextContent('缓存读 401,226');
    expect(usage).toHaveTextContent('缓存写 32,806');
    expect(usage).toHaveTextContent('$0.28');
  });

  it('omits the usage line entirely when no token data is available', () => {
    render(<SessionDetailModal roomId={1} detail={makeDetail()} onClose={vi.fn()} />);
    expect(screen.queryByTestId('session-usage')).not.toBeInTheDocument();
  });

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

describe('EventTreePanel tabs and session lanes', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  const sessions = [
    makeSession({ seq: 1, agentId: 'codex', outcome: 'completed' }),
    makeSession({ seq: 2, agentId: 'kimi', outcome: 'passed' }),
    makeSession({ seq: 3, agentId: 'claude', outcome: 'running', endedAt: null }),
    makeSession({ seq: 4, agentId: 'opencode', outcome: 'completed' }),
  ];
  const messages: Message[] = [
    makeMessage({ id: 3, sessionSeq: 2, authorId: 'kimi', type: 'hypothesis', content: 'kimi hyp', createdAt: 't3' }),
    makeMessage({ id: 1, sessionSeq: null, authorId: 'human', type: null, content: 'the goal', createdAt: 't1' }),
    makeMessage({ id: 2, sessionSeq: 1, authorId: 'codex', type: 'fact', content: 'codex fact', createdAt: 't2' }),
    makeMessage({ id: 4, sessionSeq: 1, authorId: 'codex', type: 'chain', content: 'codex chain', createdAt: 't4' }),
  ];

  function renderPanel(overrides: Partial<Parameters<typeof EventTreePanel>[0]> = {}) {
    return render(
      <EventTreePanel sessions={sessions} messages={messages} onOpenSession={vi.fn()} {...overrides} />,
    );
  }

  it('defaults to the timeline tab and switches to the session lanes', () => {
    renderPanel();
    expect(screen.getByRole('tab', { name: '时间线' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('codex fact')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Session' }));
    expect(screen.getByRole('tab', { name: 'Session' })).toHaveAttribute('aria-selected', 'true');
    // 泳道只标出事件，不显示内容。
    expect(screen.queryByText('codex fact')).not.toBeInTheDocument();
    expect(screen.getByText('#2')).toBeInTheDocument();
    expect(window.localStorage.getItem('vd.eventTree.tab')).toBe('sessions');
  });

  it('restores the remembered tab and falls back to the timeline for invalid values', () => {
    window.localStorage.setItem('vd.eventTree.tab', 'sessions');
    renderPanel();
    expect(screen.getByRole('tab', { name: 'Session' })).toHaveAttribute('aria-selected', 'true');
    cleanup();

    window.localStorage.setItem('vd.eventTree.tab', 'bogus');
    renderPanel();
    expect(screen.getByRole('tab', { name: '时间线' })).toHaveAttribute('aria-selected', 'true');
  });

  it('builds lanes: human first, then loaded or running sessions by seq', () => {
    window.localStorage.setItem('vd.eventTree.tab', 'sessions');
    const { container } = renderPanel();
    const heads = [...container.querySelectorAll('.lane-head')].map((el) => el.textContent);
    // seq 4 既没有已加载的消息也不在运行，不占列；seq 3 在运行，即使没有消息也占列。
    expect(heads).toEqual(['人类', 'codex #1 · done', 'kimi #2 · passed', 'claude #3']);
  });

  it('puts every event on its own global row, in its session column, ordered by time', () => {
    window.localStorage.setItem('vd.eventTree.tab', 'sessions');
    const { container } = renderPanel();
    const rows = [...container.querySelectorAll<HTMLElement>('[data-lane-message-id]')];
    expect(rows.map((row) => row.dataset.laneMessageId)).toEqual(['1', '2', '3', '4']);
    const columns = rows.map((row) => (row.querySelector('.lane-event') as HTMLElement).style.gridColumn);
    // 时间列占第 1 列，人类第 2 列，codex #1 第 3 列，kimi #2 第 4 列。
    expect(columns).toEqual(['2', '3', '4', '3']);
    expect(within(rows[0]).getByText('消息')).toBeInTheDocument();
    expect(within(rows[1]).getByText('#2')).toBeInTheDocument();
  });

  it('opens session detail from a lane header and jumps to the message from an event', () => {
    window.localStorage.setItem('vd.eventTree.tab', 'sessions');
    const onOpenSession = vi.fn();
    const onJumpToMessage = vi.fn();
    renderPanel({ onOpenSession, onJumpToMessage });
    fireEvent.click(screen.getByRole('button', { name: 'kimi #2 · passed' }));
    expect(onOpenSession).toHaveBeenCalledWith(2);
    fireEvent.click(screen.getByText('#3'));
    expect(onJumpToMessage).toHaveBeenCalledWith(3);
  });

  it('shows the empty state when there are no events', () => {
    window.localStorage.setItem('vd.eventTree.tab', 'sessions');
    renderPanel({ sessions: [], messages: [] });
    expect(screen.getByText('还没有任何事件')).toBeInTheDocument();
  });
});

describe('EventTreePanel session boundary markers', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  const sessions = [
    makeSession({ seq: 1, agentId: 'codex', outcome: 'completed', startedAt: 't2', endedAt: 't5' }),
    makeSession({ seq: 2, agentId: 'kimi', outcome: 'running', startedAt: 't3', endedAt: null }),
    // 已加载窗口之外、也不在运行：不可见，不出标记。
    makeSession({ seq: 3, agentId: 'claude', outcome: 'completed', startedAt: 't0', endedAt: 't0' }),
  ];
  const messages: Message[] = [
    makeMessage({ id: 1, sessionSeq: null, authorId: 'human', type: null, content: 'the goal', createdAt: 't1' }),
    // 与 codex #1 开始同一时刻：开始标记应排在消息前面。
    makeMessage({ id: 2, sessionSeq: 1, authorId: 'codex', type: 'fact', content: 'codex fact', createdAt: 't2' }),
    makeMessage({ id: 3, sessionSeq: 1, authorId: 'codex', type: 'chain', content: 'codex chain', createdAt: 't4' }),
  ];

  function order(container: HTMLElement, selector: string, attr: string, markerAttr: string): string[] {
    return [...container.querySelectorAll<HTMLElement>(selector)].map(
      (el) => el.getAttribute(markerAttr) ?? `m${el.getAttribute(attr)}`,
    );
  }

  it('merges start/end markers into the timeline by time, start before and end after same-time messages', () => {
    const { container } = render(<EventTreePanel sessions={sessions} messages={messages} onOpenSession={vi.fn()} />);
    expect(order(container, '.tree-row, .tree-marker', 'data-message-id', 'data-marker')).toEqual([
      'm1', 'start-1', 'm2', 'start-2', 'm3', 'end-1',
    ]);
    expect(screen.getByText('▶ codex #1 开始')).toBeInTheDocument();
    expect(screen.getByText('■ codex #1 结束 · done')).toBeInTheDocument();
    // 运行中的 session 只有开始标记。
    expect(screen.getByText('▶ kimi #2 开始')).toBeInTheDocument();
    expect(screen.queryByText(/kimi #2 结束/)).not.toBeInTheDocument();
    expect(screen.queryByText(/claude #3/)).not.toBeInTheDocument();
    // 标记不计入计数。
    expect(container.querySelector('.panel__count')).toHaveTextContent('3');
  });

  it('opens session detail from a timeline marker', () => {
    const onOpenSession = vi.fn();
    render(<EventTreePanel sessions={sessions} messages={messages} onOpenSession={onOpenSession} />);
    fireEvent.click(screen.getByText('■ codex #1 结束 · done'));
    expect(onOpenSession).toHaveBeenCalledWith(1);
  });

  it('shows markers and running rails in the session lanes', () => {
    window.localStorage.setItem('vd.eventTree.tab', 'sessions');
    const onOpenSession = vi.fn();
    const { container } = render(<EventTreePanel sessions={sessions} messages={messages} onOpenSession={onOpenSession} />);
    const rows = [...container.querySelectorAll<HTMLElement>('.lane-row:not(.lane-row--head)')];
    expect(rows.map((row) => row.dataset.laneMarker ?? `m${row.dataset.laneMessageId}`)).toEqual([
      'm1', 'start-1', 'm2', 'start-2', 'm3', 'end-1',
    ]);
    // codex #1（第 3 列）的竖线从开始行（1）到结束行（5）；kimi #2（第 4 列）从开始行（3）延伸到最后一行。
    const railRows = (column: string) =>
      rows.flatMap((row, index) =>
        [...row.querySelectorAll<HTMLElement>('.lane-rail')].some((rail) => rail.style.gridColumn === column) ? [index] : [],
      );
    expect(railRows('3')).toEqual([1, 2, 3, 4, 5]);
    expect(railRows('4')).toEqual([3, 4, 5]);
    expect(rows[1].querySelector('.lane-rail')).toHaveClass('lane-rail--start');
    expect(within(rows[5]).getByText('■ done')).toHaveClass('outcome-text--completed');

    fireEvent.click(within(rows[3]).getByText('▶ 开始'));
    expect(onOpenSession).toHaveBeenCalledWith(2);
  });

  it('shows a running session start marker instead of the empty state', () => {
    window.localStorage.setItem('vd.eventTree.tab', 'sessions');
    render(
      <EventTreePanel
        sessions={[makeSession({ seq: 1, agentId: 'codex', outcome: 'running', startedAt: 't1', endedAt: null })]}
        messages={[]}
        onOpenSession={vi.fn()}
      />,
    );
    expect(screen.queryByText('还没有任何事件')).not.toBeInTheDocument();
    expect(screen.getByText('▶ 开始')).toBeInTheDocument();
  });
});
