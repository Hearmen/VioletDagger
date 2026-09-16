import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MessageStreamTab } from '../../src/components/MessageStreamTab';
import type { Message } from '../../src/api/types';

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 1, roomId: 1, sessionSeq: null, authorId: 'human', type: null, content: 'hello',
    summary: 'hello', targetMessageId: null, referencedMessageIds: [], exploringStatus: null,
    exploringNote: null, createdAt: 'now', ...overrides,
  };
}

describe('MessageStreamTab', () => {
  it('renders messages and highlights propose_completion', () => {
    render(
      <MessageStreamTab
        messages={[makeMessage({ id: 1, content: 'chat' }), makeMessage({ id: 2, type: 'propose_completion', content: 'done?' })]}
        onSend={vi.fn()}
      />,
    );
    expect(screen.getByText(/\[human\].*chat/)).toBeInTheDocument();
    expect(screen.getByText('[提议完成]')).toBeInTheDocument();
  });

  it('disables Send for a reaction type until a target message is clicked', () => {
    const onSend = vi.fn();
    render(<MessageStreamTab messages={[makeMessage({ id: 5, content: 'the target' })]} onSend={onSend} />);

    fireEvent.change(screen.getByLabelText('content'), { target: { value: 'I agree' } });
    fireEvent.change(screen.getByLabelText('message type'), { target: { value: 'endorse' } });
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    fireEvent.click(screen.getByText(/the target/));
    expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith({ content: 'I agree', type: 'endorse', targetMessageId: 5, referencedMessageIds: undefined });
  });

  it('sends a plain chat message with no type', () => {
    const onSend = vi.fn();
    render(<MessageStreamTab messages={[]} onSend={onSend} />);
    fireEvent.change(screen.getByLabelText('content'), { target: { value: 'just chatting' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith({ content: 'just chatting', type: undefined, targetMessageId: undefined, referencedMessageIds: undefined });
  });
});
