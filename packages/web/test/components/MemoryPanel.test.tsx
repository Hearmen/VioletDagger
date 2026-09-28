import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryPanel } from '../../src/components/MemoryPanel';
import type { Message, MemoryViewPayload } from '../../src/api/types';

function makeMessage(overrides: Partial<Message>): Message {
  return {
    id: 1, roomId: 1, sessionSeq: 1, authorId: 'codex', type: 'exploring', content: 'x',
    summary: 'x', targetMessageId: null, targetAgentId: null, referencedMessageIds: [],
    questionStatus: null, questionCloseReason: null, questionClosedBy: null,
    chainStatus: null, closesQuestion: false, chainResolution: null, verifyVerdict: null,
    exploringStatus: 'active', exploringNote: null, exploringEndReason: null,
    exploringResultSummary: null, exploringResultMessageIds: [],
    createdAt: '2026-01-01T00:00:00.000Z', ...overrides,
  };
}

function makeMemory(overrides: Partial<MemoryViewPayload>): MemoryViewPayload {
  return {
    goalMessageId: null, openQuestions: [], hypotheses: [], facts: [], boundaries: [], chains: [],
    exploring: [], completionProposals: [], challenges: [], verifies: [], transitions: {}, ...overrides,
  };
}

describe('MemoryPanel', () => {
  it('pins the goal, shows answers, reactions, transitions and proposals using only the memory payload', () => {
    const memory = makeMemory({
      goalMessageId: 1,
      openQuestions: [
        makeMessage({ id: 6, type: 'open_question', questionStatus: 'OPEN', summary: 'sub question' }),
        makeMessage({ id: 1, type: 'open_question', questionStatus: 'CLOSED', questionCloseReason: 'RESOLVED', summary: 'goal question', content: 'goal body' }),
      ],
      facts: [makeMessage({ id: 2, type: 'fact', targetMessageId: 1, summary: 'confirmed answer', content: 'answer body' })],
      chains: [makeMessage({ id: 7, type: 'chain', chainStatus: 'VERIFIED', targetMessageId: 1, closesQuestion: true, chainResolution: 'RESOLVED', summary: 'full chain' })],
      verifies: [makeMessage({ id: 3, type: 'verify', targetMessageId: 2, verifyVerdict: true, summary: 'short outage passed' })],
      challenges: [makeMessage({ id: 4, type: 'challenge', targetMessageId: 7, summary: 'long outage untested' })],
      completionProposals: [makeMessage({ id: 5, type: 'propose_completion', summary: 'stop proposal', content: 'await external evidence' })],
      transitions: {
        2: [{ id: 1, roomId: 1, messageId: 2, fromType: 'hypothesis', toType: 'fact', fromStatus: null, toStatus: null, triggerMessageId: 3, reason: null, createdAt: '2026-01-01T00:00:00.000Z' }],
      },
    });
    render(<MemoryPanel memory={memory} />);
    const chip = screen.getByRole('button', { name: 'memory group openQuestions' });
    expect(chip).toHaveTextContent('OPEN 1');
    expect(screen.getByRole('button', { name: 'memory group chains' })).toHaveTextContent('VERIFIED 1');
    fireEvent.click(chip);
    const rows = screen.getAllByRole('button', { name: /memory item/ });
    expect(rows[0]).toHaveAccessibleName('memory item 1');
    expect(rows[0]).toHaveTextContent('goal');
    expect(rows[0]).toHaveTextContent('CLOSED/RESOLVED');

    fireEvent.click(rows[0]);
    expect(screen.getByText('confirmed answer')).toBeInTheDocument();
    expect(screen.getByText('full chain')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'memory group facts' }));
    fireEvent.click(screen.getByRole('button', { name: 'memory item 2' }));
    expect(screen.getByLabelText('转换历史')).toHaveTextContent('hypothesis→fact');
    expect(screen.getAllByText('short outage passed').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'memory group chains' }));
    fireEvent.click(screen.getByRole('button', { name: 'memory item 7' }));
    expect(screen.getByText(/关闭意图/)).toHaveTextContent('已解决');
    expect(screen.getAllByText('long outage untested').length).toBeGreaterThan(0);

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
        makeMessage({ id: 1, summary: 'first', content: 'first body', exploringStatus: 'completed', exploringEndReason: 'human_terminated', exploringNote: '人类强制终止', createdAt: '2026-01-01T00:00:00.000Z' }),
        makeMessage({ id: 2, summary: 'second', content: 'second body', exploringStatus: 'active', createdAt: '2026-01-02T00:00:00.000Z' }),
      ],
    });
    render(<MemoryPanel memory={memory} />);

    const chip = screen.getByRole('button', { name: 'memory group exploring' });
    expect(chip).toHaveTextContent('1/1');

    fireEvent.click(chip);
    expect(screen.queryByText('codex')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'memory item 1' }));
    expect(screen.getByText(/已完成：/)).toHaveTextContent('人类强制终止');
    expect(screen.getByText(/已完成：/)).toHaveTextContent('未记录结果');
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
