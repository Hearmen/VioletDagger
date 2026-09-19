import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryPanel } from '../../src/components/MemoryPanel';
import type { Message, MemoryViewPayload } from '../../src/api/types';

function makeMessage(overrides: Partial<Message>): Message {
  return {
    id: 1, roomId: 1, sessionSeq: 1, authorId: 'codex', type: 'exploring', content: 'x',
    summary: 'x', targetMessageId: null, referencedMessageIds: [], exploringStatus: 'active',
    exploringNote: null, createdAt: '2026-01-01T00:00:00.000Z', ...overrides,
  };
}

function makeMemory(overrides: Partial<MemoryViewPayload>): MemoryViewPayload {
  return { facts: [], boundaries: [], openQuestions: [], chains: [], hypotheses: [], exploring: [], ...overrides };
}

describe('MemoryPanel', () => {
  it('shows answers, nested reactions and proposals using only the memory payload', () => {
    const memory = makeMemory({
      openQuestions: [makeMessage({ id: 1, type: 'open_question', summary: 'question', content: 'question body' })],
      hypotheses: [makeMessage({ id: 2, type: 'hypothesis', targetMessageId: 1, content: 'candidate answer' })],
      reactions: [makeMessage({ id: 3, type: 'verify', targetMessageId: 2, content: 'short outage passed' }), makeMessage({ id: 4, type: 'challenge', targetMessageId: 3, content: 'long outage untested' })],
      completionProposals: [makeMessage({ id: 5, type: 'propose_completion', summary: 'stop proposal', content: 'await external evidence' })],
      relations: {
        1: { answerIds: [2], annotationIds: [], referencedByIds: [] },
        2: { answerIds: [], annotationIds: [3], referencedByIds: [] },
        3: { answerIds: [], annotationIds: [4], referencedByIds: [] },
      },
    });
    render(<MemoryPanel memory={memory} />);
    fireEvent.click(screen.getByRole('button', { name: 'memory group openQuestions' }));
    fireEvent.click(screen.getByRole('button', { name: 'memory item 1' }));
    expect(screen.getByText('candidate answer')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '展开关联 #2' }));
    expect(screen.getAllByText('short outage passed').length).toBeGreaterThan(0);
    expect(screen.getByText(/long outage untested/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'memory group completionProposals' }));
    fireEvent.click(screen.getByRole('button', { name: 'memory item 5' }));
    expect(screen.getByText('await external evidence')).toBeInTheDocument();
    expect(screen.queryByText('codex')).not.toBeInTheDocument();
  });
  it('shows a memory bus with category counts and keeps categories collapsed by default', () => {
    const memory = makeMemory({
      facts: [makeMessage({ id: 1, type: 'fact', content: 'db is sqlite' })],
    });
    render(<MemoryPanel memory={memory} />);

    const factsChip = screen.getByRole('button', { name: 'memory group facts' });
    expect(factsChip).toHaveAttribute('aria-expanded', 'false');
    expect(factsChip).toHaveTextContent('1');
    expect(screen.queryByText('db is sqlite')).not.toBeInTheDocument();
    expect(screen.queryByText(/db is/)).not.toBeInTheDocument();
  });

  it('drills down: category chip -> item row, then item -> full content', () => {
    const memory = makeMemory({
      facts: [makeMessage({ id: 1, type: 'fact', summary: 'short summary', content: 'full fact body' })],
    });
    render(<MemoryPanel memory={memory} />);

    fireEvent.click(screen.getByRole('button', { name: 'memory group facts' }));
    const item = screen.getByRole('button', { name: 'memory item 1' });
    expect(item).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('short summary')).toBeInTheDocument();
    expect(screen.queryByText('full fact body')).not.toBeInTheDocument();

    fireEvent.click(item);
    expect(screen.getByText('full fact body')).toBeInTheDocument();
  });

  it('shows active/completed counts without authors, keeping completed visible', () => {
    const memory = makeMemory({
      exploring: [
        makeMessage({ id: 1, summary: 'first', content: 'first body', exploringStatus: 'completed', exploringNote: '人类强制终止', createdAt: '2026-01-01T00:00:00.000Z' }),
        makeMessage({ id: 2, summary: 'second', content: 'second body', exploringStatus: 'active', createdAt: '2026-01-02T00:00:00.000Z' }),
      ],
    });
    render(<MemoryPanel memory={memory} />);

    const chip = screen.getByRole('button', { name: 'memory group exploring' });
    expect(chip).toHaveTextContent('1/1');

    fireEvent.click(chip);
    expect(screen.queryByText('codex')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'memory item 1' }));
    expect(screen.getByText(/已完成/)).toHaveTextContent('人类强制终止');
    expect(screen.getByText('first body')).toBeInTheDocument();
    expect(screen.getAllByText('second').length).toBeGreaterThan(0);
  });

  it('collapses a category when its chip is clicked again', () => {
    const memory = makeMemory({
      facts: [makeMessage({ id: 1, type: 'fact', summary: 'short summary', content: 'db is sqlite' })],
    });
    render(<MemoryPanel memory={memory} />);

    const chip = screen.getByRole('button', { name: 'memory group facts' });
    fireEvent.click(chip);
    expect(chip).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(chip);
    expect(chip).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('short summary')).not.toBeInTheDocument();
  });
});
