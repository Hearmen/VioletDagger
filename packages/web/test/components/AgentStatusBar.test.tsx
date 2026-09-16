import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { AgentStatusBar } from '../../src/components/AgentStatusBar';
import type { RoomStatusPayload } from '../../src/api/types';

describe('AgentStatusBar', () => {
  it('renders idle and running agents with their state', () => {
    const agents: RoomStatusPayload['agents'] = [
      { agentId: 'codex', state: 'idle' },
      { agentId: 'claude', state: 'running', sessionId: 3, sessionStartedAt: new Date().toISOString() },
    ];
    render(<AgentStatusBar agents={agents} onTerminate={vi.fn()} />);
    expect(screen.getByTestId('agent-codex')).toHaveTextContent('idle');
    expect(screen.getByTestId('agent-claude')).toHaveTextContent('running');
  });

  it('shows a terminate button only for running agents and calls onTerminate with sessionId', () => {
    const onTerminate = vi.fn();
    const agents: RoomStatusPayload['agents'] = [
      { agentId: 'codex', state: 'idle' },
      { agentId: 'claude', state: 'running', sessionId: 3, sessionStartedAt: new Date().toISOString() },
    ];
    render(<AgentStatusBar agents={agents} onTerminate={onTerminate} />);
    const claudeBar = screen.getByTestId('agent-claude');
    fireEvent.click(within(claudeBar).getByRole('button', { name: 'Terminate' }));
    expect(onTerminate).toHaveBeenCalledWith(3);
  });

  it('shows a stuck indicator when stuck is true', () => {
    const agents: RoomStatusPayload['agents'] = [
      { agentId: 'codex', state: 'running', sessionId: 1, sessionStartedAt: new Date().toISOString(), stuck: true },
    ];
    render(<AgentStatusBar agents={agents} onTerminate={vi.fn()} />);
    expect(screen.getByTitle('这个 agent 可能卡住了，要不要看看')).toBeInTheDocument();
  });
});
