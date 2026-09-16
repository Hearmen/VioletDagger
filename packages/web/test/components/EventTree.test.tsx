import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EventTreeTab } from '../../src/components/EventTreeTab';
import { SessionDetailModal } from '../../src/components/SessionDetailModal';
import type { EventTreePayload, SessionDetailPayload } from '../../src/api/types';

describe('EventTreeTab', () => {
  it('renders sessions in order with their outcome and messages', () => {
    const eventTree: EventTreePayload = {
      sessions: [
        { seq: 1, agentId: 'codex', outcome: 'completed', startedAt: 't1', endedAt: 't2', messages: [
          { id: 1, roomId: 1, sessionSeq: 1, authorId: 'codex', type: 'fact', content: 'a fact', summary: 'a fact', targetMessageId: null, referencedMessageIds: [], exploringStatus: null, exploringNote: null, createdAt: 't1' },
        ] },
      ],
    };
    render(<EventTreeTab eventTree={eventTree} onOpenSession={vi.fn()} />);
    expect(screen.getByText(/#1 codex — completed/)).toBeInTheDocument();
    expect(screen.getByText('a fact')).toBeInTheDocument();
  });

  it('calls onOpenSession with the seq when a session node is clicked', () => {
    const onOpenSession = vi.fn();
    const eventTree: EventTreePayload = {
      sessions: [{ seq: 2, agentId: 'claude', outcome: 'error', startedAt: 't1', endedAt: 't2', messages: [] }],
    };
    render(<EventTreeTab eventTree={eventTree} onOpenSession={onOpenSession} />);
    fireEvent.click(screen.getByText(/#2 claude — error/));
    expect(onOpenSession).toHaveBeenCalledWith(2);
  });
});

describe('SessionDetailModal', () => {
  it('renders nothing when detail is null', () => {
    const { container } = render(<SessionDetailModal detail={null} onClose={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the raw log and calls onClose', () => {
    const onClose = vi.fn();
    const detail: SessionDetailPayload = {
      agentId: 'codex', startedAt: 't1', endedAt: 't2', outcome: 'completed', rawLog: 'raw output', wroteMessages: true,
    };
    render(<SessionDetailModal detail={detail} onClose={onClose} />);
    expect(screen.getByText('raw output')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });
});
