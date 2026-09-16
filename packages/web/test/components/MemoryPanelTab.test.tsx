import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryPanelTab } from '../../src/components/MemoryPanelTab';
import type { Message, MemoryViewPayload } from '../../src/api/types';

function makeMessage(overrides: Partial<Message>): Message {
  return {
    id: 1, roomId: 1, sessionSeq: 1, authorId: 'codex', type: 'exploring', content: 'x',
    summary: 'x', targetMessageId: null, referencedMessageIds: [], exploringStatus: 'active',
    exploringNote: null, createdAt: '2026-01-01T00:00:00.000Z', ...overrides,
  };
}

describe('MemoryPanelTab', () => {
  it('renders facts in the facts section', () => {
    const memory: MemoryViewPayload = {
      facts: [makeMessage({ id: 1, type: 'fact', content: 'db is sqlite' })],
      boundaries: [], openQuestions: [], chains: [], hypotheses: [], exploring: [],
    };
    render(<MemoryPanelTab memory={memory} />);
    expect(screen.getByText('db is sqlite')).toBeInTheDocument();
  });

  it('groups exploring by author and keeps completed records visible with a label', () => {
    const memory: MemoryViewPayload = {
      facts: [], boundaries: [], openQuestions: [], chains: [], hypotheses: [],
      exploring: [
        makeMessage({ id: 1, content: 'first', exploringStatus: 'completed', exploringNote: '人类强制终止', createdAt: '2026-01-01T00:00:00.000Z' }),
        makeMessage({ id: 2, content: 'second', exploringStatus: 'active', createdAt: '2026-01-02T00:00:00.000Z' }),
      ],
    };
    render(<MemoryPanelTab memory={memory} />);
    expect(screen.getByText('codex')).toBeInTheDocument();
    expect(screen.getByText('first')).toBeInTheDocument();
    expect(screen.getByText('second')).toBeInTheDocument();
    expect(screen.getByText(/已完成/)).toHaveTextContent('人类强制终止');
  });
});
