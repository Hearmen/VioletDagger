import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { AgentRail } from '../../src/components/AgentRail';
import type { RoomStatusPayload } from '../../src/api/types';

const noop = () => {};

function makeAgent(overrides: Partial<RoomStatusPayload['agents'][number]> = {}): RoomStatusPayload['agents'][number] {
  return { agentId: 'codex', state: 'idle', enabled: true, failureCount: 0, ...overrides };
}

function renderRail(agents: RoomStatusPayload['agents'], handlers: { onTerminate?: any; onOpenSession?: any; onSetAgentEnabled?: any } = {}) {
  return render(
    <AgentRail
      agents={agents}
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
});
