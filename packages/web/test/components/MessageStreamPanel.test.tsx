import type { ComponentProps } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MessageStreamPanel } from '../../src/components/MessageStreamPanel';
import type { Message } from '../../src/api/types';

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 1, roomId: 1, sessionSeq: null, authorId: 'human', type: null, content: 'hello',
    summary: 'hello', targetMessageId: null, referencedMessageIds: [], exploringStatus: null,
    exploringNote: null, createdAt: 'now', ...overrides,
  };
}

function renderPanel(props: Partial<ComponentProps<typeof MessageStreamPanel>> = {}) {
  return render(
    <MessageStreamPanel
      messages={[]}
      nextCursor={null}
      onLoadEarlier={vi.fn()}
      onSend={vi.fn()}
      readOnly={false}
      {...props}
    />,
  );
}

describe('MessageStreamPanel', () => {
  it('renders messages and highlights propose_completion', () => {
    renderPanel({
      messages: [
        makeMessage({ id: 1, content: 'chat' }),
        makeMessage({ id: 2, type: 'propose_completion', content: 'done?' }),
      ],
    });
    expect(screen.getByText('chat')).toBeInTheDocument();
    expect(screen.getByText('提议完成')).toBeInTheDocument();
  });

  it('keeps the type picker collapsed and offers only base types without a target', () => {
    renderPanel();
    expect(screen.queryByRole('option')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '选择消息类型' }));
    expect(screen.getByRole('option', { name: 'fact' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'hypothesis' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'open_question' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'endorse' })).not.toBeInTheDocument();
  });

  it('sends a plain chat message with no type', () => {
    const onSend = vi.fn();
    renderPanel({ onSend });
    fireEvent.change(screen.getByLabelText('content'), { target: { value: 'just chatting' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith({
      content: 'just chatting', type: undefined, targetMessageId: undefined,
    });
  });

  it('sends a fact without needing a target', () => {
    const onSend = vi.fn();
    renderPanel({ onSend });

    fireEvent.click(screen.getByRole('button', { name: '选择消息类型' }));
    fireEvent.click(screen.getByRole('option', { name: 'fact' }));
    fireEvent.change(screen.getByLabelText('content'), { target: { value: 'the sky is blue' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(onSend).toHaveBeenCalledWith({
      content: 'the sky is blue', type: 'fact', targetMessageId: undefined,
    });
  });

  it('reveals reaction options after selecting a target and clears the reaction on cancel', () => {
    renderPanel({ messages: [makeMessage({ id: 5, content: 'the target' })] });
    expect(screen.queryByRole('option', { name: 'endorse' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('the target'));
    expect(screen.getByRole('option', { name: 'endorse' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'challenge' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'verify' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('option', { name: 'endorse' }));
    expect(screen.getByRole('button', { name: '清除类型' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '取消回复目标' }));
    expect(screen.queryByRole('button', { name: '清除类型' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'endorse' })).not.toBeInTheDocument();
  });

  it('loads earlier messages when scrolled to the top and a cursor exists', () => {
    const onLoadEarlier = vi.fn();
    renderPanel({ messages: [makeMessage({ id: 2 })], nextCursor: 1, onLoadEarlier });
    fireEvent.scroll(screen.getByTestId('message-list'), { target: { scrollTop: 0 } });
    expect(onLoadEarlier).toHaveBeenCalled();
  });

  it('replaces the composer with a read-only notice when the room is completed', () => {
    renderPanel({ readOnly: true });
    expect(screen.getByText('房间已结束，只读')).toBeInTheDocument();
    expect(screen.queryByLabelText('content')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
  });
});
