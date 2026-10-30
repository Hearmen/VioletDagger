import { describe, it, expect, vi, afterEach } from 'vitest';
import { diffStatus, RoomAlertMonitor, snapshotOf } from '../src/alerts';
import type { AgentStatus, Message, RoomStatusPayload } from '../src/types';

function agent(overrides: Partial<AgentStatus> = {}): AgentStatus {
  return { agentId: 'codex', state: 'idle', enabled: true, failureCount: 0, ...overrides };
}

function status(overrides: Partial<RoomStatusPayload> = {}): RoomStatusPayload {
  return {
    currentSessionCount: 1, status: 'active', dispatchIdle: false, disabledAgentCount: 0,
    nextTurnAgentId: null, agents: [agent()], ...overrides,
  };
}

function message(overrides: Partial<Message>): Message {
  return {
    id: 5, roomId: 1, sessionSeq: 3, authorId: 'codex', type: null, content: 'Agent codex 的 session #3 异常退出',
    summary: '', targetMessageId: null, targetAgentId: null, referencedMessageIds: [], questionStatus: null,
    questionCloseReason: null, chainStatus: null, closesQuestion: false, chainResolution: null,
    verifyVerdict: null, exploringStatus: null, createdAt: '2026-10-30T10:00:00.000Z', ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('diffStatus', () => {
  it('fires only on edges', () => {
    const prev = snapshotOf(status());
    expect(diffStatus(prev, status())).toEqual([]);
    expect(diffStatus(prev, status({ status: 'paused_limit' }))).toEqual([{ kind: 'pausedLimit' }]);
    expect(diffStatus(snapshotOf(status({ status: 'paused_limit' })), status({ status: 'paused_limit' }))).toEqual([]);
    expect(diffStatus(prev, status({ dispatchIdle: true }))).toEqual([{ kind: 'idleEdge' }]);
  });

  it('reports stuck agents once', () => {
    const stuck = status({ agents: [agent({ state: 'running', sessionId: 4, stuck: true, activeExploringSummary: 'db' })] });
    expect(diffStatus(snapshotOf(status()), stuck)).toEqual([
      { kind: 'stuck', agentId: 'codex', sessionId: 4, exploringSummary: 'db' },
    ]);
    expect(diffStatus(snapshotOf(stuck), stuck)).toEqual([]);
  });

  it('keys exitWarning by session id', () => {
    const warn = (sessionId: number) => status({
      agents: [agent({ state: 'stopping', sessionId, exitWarning: '清理未确认，可重试终止' })],
    });
    expect(diffStatus(snapshotOf(status()), warn(4))).toEqual([{ kind: 'exitWarning', agentId: 'codex', sessionId: 4 }]);
    expect(diffStatus(snapshotOf(warn(4)), warn(4))).toEqual([]);
    expect(diffStatus(snapshotOf(warn(4)), warn(6))).toEqual([{ kind: 'exitWarning', agentId: 'codex', sessionId: 6 }]);
  });
});

function setupMonitor(responses: Record<string, unknown[]>, idleNotifyDelayMs = 1000) {
  const notify = vi.fn();
  const call = vi.fn(async (method: string) => {
    const queue = responses[method];
    if (!queue || queue.length === 0) throw new Error(`unexpected call ${method}`);
    return queue.length > 1 ? queue.shift() : queue[0];
  });
  const monitor = new RoomAlertMonitor({
    roomId: 1,
    call: call as never,
    roomTag: () => '<b>[#1 r]</b>',
    notify,
    idleNotifyDelayMs,
    coalesceMs: 10,
  });
  return { monitor, notify, call };
}

describe('RoomAlertMonitor', () => {
  it('takes a silent baseline on connect, then alerts on the next change', async () => {
    vi.useFakeTimers();
    const { monitor, notify } = setupMonitor({
      getRoomStatus: [status({ status: 'paused_limit' }), status(), status({ status: 'paused_limit' })],
    });
    monitor.onConnected();
    await monitor.idle();
    expect(notify).not.toHaveBeenCalled();

    monitor.onRoomStatus();
    await vi.advanceTimersByTimeAsync(10);
    await monitor.idle();
    monitor.onRoomStatus();
    await vi.advanceTimersByTimeAsync(10);
    await monitor.idle();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain('已达 session 上限');
  });

  it('coalesces bursts of roomStatus pushes', async () => {
    vi.useFakeTimers();
    const { monitor, call } = setupMonitor({ getRoomStatus: [status()] });
    monitor.onConnected();
    await monitor.idle();
    monitor.onRoomStatus();
    monitor.onRoomStatus();
    monitor.onRoomStatus();
    await vi.advanceTimersByTimeAsync(10);
    await monitor.idle();
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('notifies dispatchIdle only if it is still idle after the delay', async () => {
    vi.useFakeTimers();
    const idle = status({ dispatchIdle: true, disabledAgentCount: 1 });
    const { monitor, notify } = setupMonitor({ getRoomStatus: [status(), idle, idle] });
    monitor.onConnected();
    await monitor.idle();
    monitor.onRoomStatus();
    await vi.advanceTimersByTimeAsync(10);
    await monitor.idle();
    expect(notify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await monitor.idle();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain('没有任务可派发（1 个 agent 已停用派发）');
  });

  it('cancels the dispatchIdle alert when the room becomes busy again', async () => {
    vi.useFakeTimers();
    const { monitor, notify } = setupMonitor({
      getRoomStatus: [status(), status({ dispatchIdle: true }), status()],
    });
    monitor.onConnected();
    await monitor.idle();
    monitor.onRoomStatus();
    await vi.advanceTimersByTimeAsync(10);
    await monitor.idle();
    monitor.onRoomStatus();
    await vi.advanceTimersByTimeAsync(10);
    await monitor.idle();
    await vi.advanceTimersByTimeAsync(2000);
    await monitor.idle();
    expect(notify).not.toHaveBeenCalled();
  });

  it('alerts on an error placeholder and mentions auto-disable', async () => {
    const { monitor, notify } = setupMonitor({
      getEventTree: [{ sessions: [{ seq: 3, agentId: 'codex', outcome: 'error' }], messages: [] }],
      getRoomStatus: [status({ agents: [agent({ enabled: false })] })],
    });
    monitor.onNewMessage(message({}));
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify.mock.calls[0][0]).toContain('session #3 异常退出');
    expect(notify.mock.calls[0][0]).toContain('/enable codex');
  });

  it('ignores passed/terminated placeholders and in-session chat', async () => {
    const { monitor, notify, call } = setupMonitor({
      getEventTree: [{ sessions: [{ seq: 3, agentId: 'codex', outcome: 'passed' }], messages: [] }],
    });
    monitor.onNewMessage(message({}));
    monitor.onNewMessage(message({ authorId: 'human', sessionSeq: null }));
    monitor.onNewMessage(message({ type: 'fact' }));
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(notify).not.toHaveBeenCalled();
  });

  it('forwards system messages and completion proposals with a button', async () => {
    const { monitor, notify } = setupMonitor({});
    monitor.onNewMessage(message({ authorId: 'system', content: 'budget <exceeded>' }));
    monitor.onNewMessage(message({ id: 9, type: 'propose_completion', sessionSeq: 4, content: 'done' }));
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(2));
    expect(notify.mock.calls[0][0]).toContain('budget &lt;exceeded&gt;');
    expect(notify.mock.calls[1][1]).toEqual([[{ text: '确认完成…', callback_data: 'ask:1' }]]);
  });
});
