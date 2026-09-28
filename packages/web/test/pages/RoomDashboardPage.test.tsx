import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { RoomDashboardPage } from '../../src/pages/RoomDashboardPage';
import * as rest from '../../src/api/rest';
import { useRoomSocket } from '../../src/hooks/useRoomSocket';
import type { Message, MemoryViewPayload, RoomStatusPayload, UsageTotals } from '../../src/api/types';

vi.mock('../../src/api/rest');
vi.mock('../../src/hooks/useRoomSocket');
// Session log connection isn't relevant to these tests; stub the hook and view.
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

const emptyMemory: MemoryViewPayload = {
  goalMessageId: null, openQuestions: [], hypotheses: [], facts: [], boundaries: [], chains: [],
  exploring: [], completionProposals: [], challenges: [], verifies: [], transitions: {},
};

const emptyUsageTotals: UsageTotals = {
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  costUsd: null, sessionCount: 0, sessionsWithoutTokens: 0, sessionsWithoutCost: 0,
};

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 1, roomId: 1, sessionSeq: null, authorId: 'human', type: null, content: 'hi',
    summary: 'hi', targetMessageId: null, targetAgentId: null, referencedMessageIds: [],
    questionStatus: null, questionCloseReason: null, questionClosedBy: null,
    chainStatus: null, closesQuestion: false, chainResolution: null, verifyVerdict: null,
    exploringStatus: null, exploringNote: null, exploringEndReason: null,
    exploringResultSummary: null, exploringResultMessageIds: [], createdAt: 'now', ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/rooms/1']}>
      <Routes>
        <Route path="/" element={<div>ROOM LIST</div>} />
        <Route path="/rooms/:roomId" element={<RoomDashboardPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RoomDashboardPage', () => {
  const call = vi.fn();
  const handlers: Record<string, (data: any) => void> = {};
  const subscribe = vi.fn((event: string, handler: (data: any) => void) => {
    handlers[event] = handler;
    return () => {};
  });

  function defaultCall(method: string) {
    if (method === 'getRoomStatus') {
      return Promise.resolve<RoomStatusPayload>({ currentSessionCount: 1, status: 'active', dispatchIdle: false, disabledAgentCount: 0, agents: [] });
    }
    if (method === 'listMessages') return Promise.resolve({ messages: [], nextCursor: null });
    if (method === 'getMemoryView') return Promise.resolve(emptyMemory);
    if (method === 'getEventTree') return Promise.resolve({ sessions: [] });
    if (method === 'getUsageSummary') return Promise.resolve({ byAgent: {}, room: emptyUsageTotals });
    return Promise.resolve({ ok: true });
  }

  beforeEach(() => {
    vi.mocked(rest.fetchRoom).mockResolvedValue({
      id: 1, name: 'room a', schedulingMode: 'sequential', status: 'active',
      maxSessions: 20, workdir: '/tmp/work', createdAt: 'now',
    });
    call.mockReset();
    call.mockImplementation(defaultCall);
    subscribe.mockClear();
    Object.keys(handlers).forEach((key) => delete handlers[key]);
    vi.mocked(useRoomSocket).mockReturnValue({ call, subscribe, connectionState: 'connected', reconnectCount: 0 });
  });

  it('shows a loading state before room/status resolve, then renders the header', async () => {
    renderPage();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(await screen.findByText('room a')).toBeInTheDocument();
  });

  it('shows an error banner during initial load when a load call fails, alongside Loading…', async () => {
    call.mockImplementation((method: string) =>
      method === 'getRoomStatus' ? Promise.reject(new Error('status fetch failed')) : defaultCall(method),
    );
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('status fetch failed');
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('sends a human message via postHumanMessage', async () => {
    renderPage();
    await screen.findByText('room a');

    fireEvent.change(screen.getByLabelText('content'), { target: { value: 'the goal' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('postHumanMessage', {
        content: 'the goal', type: undefined, targetMessageId: undefined,
      }),
    );
  });

  it('shows the first-message hint while the room is empty', async () => {
    renderPage();
    expect(await screen.findByText('第一条消息就是任务目标')).toBeInTheDocument();
  });

  it('replaces a loaded message with its latest version on memoryUpdate', async () => {
    const hypothesis = makeMessage({ id: 2, type: 'hypothesis', content: 'a guess', targetMessageId: 1 });
    const goal = makeMessage({ id: 1, type: 'open_question', questionStatus: 'OPEN', content: 'goal' });
    let memory: MemoryViewPayload = { ...emptyMemory, goalMessageId: 1, openQuestions: [goal], hypotheses: [hypothesis] };
    call.mockImplementation((method: string) => {
      if (method === 'listMessages') return Promise.resolve({ messages: [goal, hypothesis], nextCursor: null });
      if (method === 'getMemoryView') return Promise.resolve(memory);
      return defaultCall(method);
    });
    renderPage();
    await waitFor(() => expect(document.querySelector('[data-message-id="2"] .type-badge')).toHaveTextContent('hypothesis'));

    memory = { ...memory, hypotheses: [], facts: [{ ...hypothesis, type: 'fact' }] };
    handlers.memoryUpdate({ messageId: 2 });

    await waitFor(() => {
      const row = document.querySelector('[data-message-id="2"]')!;
      expect(row.querySelector('.type-badge')).toHaveTextContent('fact');
    });
  });

  it('shows a toast when postHumanMessage fails', async () => {
    call.mockImplementation((method: string) =>
      method === 'postHumanMessage' ? Promise.reject(new Error('rpc failed')) : defaultCall(method),
    );
    renderPage();
    await screen.findByText('room a');

    fireEvent.change(screen.getByLabelText('content'), { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('rpc failed');
  });

  it('passes connectionState to the header so the disconnect banner can show', async () => {
    vi.mocked(useRoomSocket).mockReturnValue({ call, subscribe, connectionState: 'disconnected', reconnectCount: 0 });
    renderPage();
    await screen.findByText('room a');
    expect(screen.getByText('连接已断开，正在重连…')).toBeInTheDocument();
  });

  it('shows the propose_completion banner derived from loaded messages', async () => {
    call.mockImplementation((method: string) =>
      method === 'listMessages'
        ? Promise.resolve({ messages: [makeMessage({ id: 3, type: 'propose_completion', content: 'done?' })], nextCursor: null })
        : defaultCall(method),
    );
    renderPage();
    expect(await screen.findByText('有 agent 提议完成这个房间')).toBeInTheDocument();
  });

  it('goes read-only when the room is completed', async () => {
    call.mockImplementation((method: string) => {
      if (method === 'getRoomStatus') {
        return Promise.resolve<RoomStatusPayload>({
          currentSessionCount: 1, dispatchIdle: false, disabledAgentCount: 0,
          status: 'completed',
          agents: [{ agentId: 'claude', state: 'running', sessionId: 3, sessionStartedAt: new Date().toISOString() }],
        });
      }
      return defaultCall(method);
    });
    renderPage();
    await screen.findByText('room a');

    expect(screen.getByText('房间已结束，只读')).toBeInTheDocument();
    expect(screen.queryByLabelText('content')).not.toBeInTheDocument();
    // completed 房间仍保留 running/stopping session 的终止入口（08 §6）。
    expect(screen.getByRole('button', { name: '终止' })).toBeInTheDocument();
  });

  it('opens the live read-only log from the agent rail badge and fetches the fixed session metadata', async () => {
    const now = new Date().toISOString();
    call.mockImplementation((method: string) => {
      if (method === 'getRoomStatus') {
        return Promise.resolve<RoomStatusPayload>({
          currentSessionCount: 1, dispatchIdle: false, disabledAgentCount: 0,
          status: 'active',
          agents: [{ agentId: 'claude', state: 'running', sessionId: 7, sessionStartedAt: now }],
        });
      }
      if (method === 'getSessionDetail') {
        return Promise.resolve({
          sessionId: 7, agentId: 'claude', startedAt: now, endedAt: null, outcome: 'running',
          messages: [], lifecycleEvents: [], exitCode: null, exitSignal: null, stopIntent: null,
          cleanupStartedAt: null, exitCause: null,
          inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null,
          rawLog: '', wroteMessages: false,
        });
      }
      return defaultCall(method);
    });
    renderPage();
    await screen.findByText('room a');

    fireEvent.click(await screen.findByRole('button', { name: 'session #7' }));

    expect(await screen.findByRole('dialog', { name: 'session live log' })).toBeInTheDocument();
    await waitFor(() => expect(call).toHaveBeenCalledWith('getSessionDetail', { sessionId: 7 }));
  });

  it('opens the read-only session detail from a message row\'s session tag', async () => {
    const now = new Date().toISOString();
    call.mockImplementation((method: string) => {
      if (method === 'getEventTree') {
        return Promise.resolve({
          sessions: [{ seq: 4, agentId: 'codex', outcome: 'passed', startedAt: now, endedAt: now }],
        });
      }
      if (method === 'listMessages') {
        return Promise.resolve({
          messages: [
            makeMessage({
              id: 1, sessionSeq: 4, authorId: 'codex', type: null,
              content: 'Agent codex 的 session #4 未发出任何实质消息', createdAt: now,
            }),
          ],
          nextCursor: null,
        });
      }
      if (method === 'getSessionDetail') {
        return Promise.resolve({
          sessionId: 4, agentId: 'codex', startedAt: now, endedAt: now, outcome: 'passed',
          messages: [], lifecycleEvents: [], exitCode: 0, exitSignal: null, stopIntent: null,
          cleanupStartedAt: null, exitCause: 'natural', rawLog: '', wroteMessages: false,
        });
      }
      return defaultCall(method);
    });
    renderPage();
    await screen.findByText('room a');

    fireEvent.click(await screen.findByText('codex #4 · passed · 00:00'));

    await waitFor(() => expect(call).toHaveBeenCalledWith('getSessionDetail', { sessionId: 4 }));
    expect(await screen.findByRole('dialog', { name: 'session detail' })).toBeInTheDocument();
    expect(call).not.toHaveBeenCalledWith('terminateAgentSession', expect.anything());
  });

  it('navigates back to the room list when the room is deleted remotely', async () => {
    renderPage();
    await screen.findByText('room a');

    expect(subscribe).toHaveBeenCalledWith('roomDeleted', expect.any(Function));
    handlers.roomDeleted({});

    expect(await screen.findByText('ROOM LIST')).toBeInTheDocument();
  });

  it('refetches full state after a reconnect', async () => {
    const { rerender } = renderPage();
    await screen.findByText('room a');
    const statusCallsBefore = call.mock.calls.filter(([method]) => method === 'getRoomStatus').length;

    vi.mocked(useRoomSocket).mockReturnValue({ call, subscribe, connectionState: 'connected', reconnectCount: 1 });
    rerender(
      <MemoryRouter initialEntries={['/rooms/1']}>
        <Routes>
          <Route path="/rooms/:roomId" element={<RoomDashboardPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      const statusCallsAfter = call.mock.calls.filter(([method]) => method === 'getRoomStatus').length;
      expect(statusCallsAfter).toBeGreaterThan(statusCallsBefore);
    });
  });
});
