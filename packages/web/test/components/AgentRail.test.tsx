import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { AgentRail } from '../../src/components/AgentRail';
import type { RoomStatusPayload, UsageTotals } from '../../src/api/types';

const noop = () => {};

function makeAgent(overrides: Partial<RoomStatusPayload['agents'][number]> = {}): RoomStatusPayload['agents'][number] {
  return { agentId: 'codex', state: 'idle', enabled: true, failureCount: 0, ...overrides };
}

function makeUsage(overrides: Partial<UsageTotals> = {}): UsageTotals {
  return {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    costUsd: null, sessionCount: 0, sessionsWithoutTokens: 0, sessionsWithoutCost: 0, ...overrides,
  };
}

function renderRail(
  agents: RoomStatusPayload['agents'],
  handlers: { onTerminate?: any; onOpenSession?: any; onSetAgentEnabled?: any; usageByAgent?: Record<string, UsageTotals> } = {},
) {
  return render(
    <AgentRail
      agents={agents}
      usageByAgent={handlers.usageByAgent}
      onTerminate={handlers.onTerminate ?? vi.fn()}
      onOpenSession={handlers.onOpenSession ?? noop}
      onSetAgentEnabled={handlers.onSetAgentEnabled ?? vi.fn()}
    />,
  );
}

describe('AgentRail', () => {
  it('renders idle and running agents with their state', () => {
    renderRail([
      makeAgent(),
      makeAgent({ agentId: 'claude', state: 'running', sessionId: 3, sessionStartedAt: new Date().toISOString() }),
    ]);
    expect(screen.getByTestId('agent-codex')).toHaveTextContent('idle');
    expect(screen.getByTestId('agent-claude')).toHaveTextContent('running');
    expect(screen.getByTestId('agent-claude')).toHaveTextContent('已运行');
  });

  it('shows a terminate button only for running/stopping agents and calls onTerminate with sessionId', () => {
    const onTerminate = vi.fn();
    renderRail(
      [
        makeAgent(),
        makeAgent({ agentId: 'claude', state: 'running', sessionId: 3, sessionStartedAt: new Date().toISOString() }),
      ],
      { onTerminate },
    );
    fireEvent.click(within(screen.getByTestId('agent-claude')).getByRole('button', { name: '终止' }));
    expect(onTerminate).toHaveBeenCalledWith(3);
  });

  it('keeps the terminate action for a stopping agent', () => {
    const onTerminate = vi.fn();
    renderRail(
      [makeAgent({ agentId: 'claude', state: 'stopping', sessionId: 5, sessionStartedAt: new Date().toISOString() })],
      { onTerminate },
    );
    fireEvent.click(screen.getByRole('button', { name: '终止' }));
    expect(onTerminate).toHaveBeenCalledWith(5);
  });

  it('opens the session detail from the session id badge', () => {
    const onOpenSession = vi.fn();
    renderRail(
      [makeAgent({ agentId: 'claude', state: 'running', sessionId: 7, sessionStartedAt: new Date().toISOString() })],
      { onOpenSession },
    );
    fireEvent.click(screen.getByRole('button', { name: 'session #7' }));
    expect(onOpenSession).toHaveBeenCalledWith(7);
  });

  it('shows the raw agent state (idle/running) without any derived "completed" label', () => {
    renderRail([makeAgent({ state: 'idle' })]);
    expect(screen.getByTestId('agent-codex')).toHaveTextContent('idle');
    expect(screen.getByTestId('agent-codex')).not.toHaveTextContent('completed');
  });

  it('shows a stuck indicator when stuck is true', () => {
    renderRail([makeAgent({ state: 'running', sessionId: 1, sessionStartedAt: new Date().toISOString(), stuck: true })]);
    expect(screen.getByTitle('这个 agent 可能卡住了，要不要看看')).toBeInTheDocument();
  });

  it('shows a disabled agent with its failure count and a 启用 button', () => {
    const onSetAgentEnabled = vi.fn();
    renderRail([makeAgent({ enabled: false, failureCount: 3 })], { onSetAgentEnabled });
    expect(screen.getByText(/已停用派发/)).toBeInTheDocument();
    expect(screen.getByText(/连续失败 ×3/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '启用' }));
    expect(onSetAgentEnabled).toHaveBeenCalledWith('codex', true);
  });

  it('lets the human disable an enabled agent', () => {
    const onSetAgentEnabled = vi.fn();
    renderRail([makeAgent()], { onSetAgentEnabled });
    fireEvent.click(screen.getByRole('button', { name: '停用' }));
    expect(onSetAgentEnabled).toHaveBeenCalledWith('codex', false);
  });

  it('shows a compact usage line with cost when the agent has completed sessions with usage data', () => {
    renderRail([makeAgent()], {
      usageByAgent: {
        codex: makeUsage({ inputTokens: 8000, outputTokens: 4345, sessionCount: 2, costUsd: 0.28 }),
      },
    });
    expect(screen.getByTestId('agent-codex')).toHaveTextContent('12.3k tok');
    expect(screen.getByTestId('agent-codex')).toHaveTextContent('$0.28');
  });

  it('marks the usage line with a * when some sessions have no cost data', () => {
    renderRail([makeAgent()], {
      usageByAgent: {
        codex: makeUsage({ inputTokens: 5, outputTokens: 5, sessionCount: 2, costUsd: 0.1, sessionsWithoutCost: 1 }),
      },
    });
    expect(screen.getByTitle('1 个 session 无费用数据，未计入')).toBeInTheDocument();
  });

  it('omits the $ part when the agent never reports a cost (e.g. codex-only token data)', () => {
    renderRail([makeAgent()], {
      usageByAgent: { codex: makeUsage({ inputTokens: 5, outputTokens: 5, sessionCount: 1, costUsd: null }) },
    });
    expect(screen.getByTestId('agent-codex')).toHaveTextContent('10 tok');
    expect(screen.getByTestId('agent-codex')).not.toHaveTextContent('$');
  });

  it('shows no usage line at all when the agent has not finished a session yet (e.g. kimi with zero runs)', () => {
    renderRail([makeAgent({ agentId: 'kimi' })], {
      usageByAgent: { kimi: makeUsage({ sessionCount: 0 }) },
    });
    expect(screen.queryByText(/tok/)).not.toBeInTheDocument();
  });
});
