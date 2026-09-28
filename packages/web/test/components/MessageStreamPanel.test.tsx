import type { ComponentProps } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MessageStreamPanel } from '../../src/components/MessageStreamPanel';
import type { Message } from '../../src/api/types';

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 1, roomId: 1, sessionSeq: null, authorId: 'human', type: null, content: 'hello',
    summary: 'hello', targetMessageId: null, targetAgentId: null, referencedMessageIds: [],
    questionStatus: null, questionCloseReason: null, questionClosedBy: null,
    chainStatus: null, closesQuestion: false, chainResolution: null, verifyVerdict: null,
    exploringStatus: null, exploringNote: null, exploringEndReason: null,
    exploringResultSummary: null, exploringResultMessageIds: [], createdAt: 'now', ...overrides,
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
      agentIds={[]}
      {...props}
    />,
  );
}

describe('MessageStreamPanel', () => {
  it('shows each message row its own #id, not just referenced ones', () => {
    renderPanel({
      messages: [makeMessage({ id: 12, content: 'chat' })],
    });
    expect(screen.getByText('#12')).toBeInTheDocument();
  });

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

  it('keeps the type picker collapsed and offers only target-free types without a target', () => {
    renderPanel();
    expect(screen.queryByRole('option')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '选择消息类型' }));
    expect(screen.getByRole('option', { name: 'open_question' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'fact' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'boundary' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '提议完成' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'hypothesis' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'exploring' })).not.toBeInTheDocument();
  });

  it('never offers exploring, even with a question or hypothesis target', () => {
    renderPanel({
      messages: [
        makeMessage({ id: 1, type: 'open_question', questionStatus: 'OPEN', content: 'q' }),
        makeMessage({ id: 2, type: 'hypothesis', content: 'h' }),
      ],
    });
    fireEvent.click(screen.getByText('q'));
    expect(screen.queryByRole('option', { name: 'exploring' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('h'));
    expect(screen.queryByRole('option', { name: 'exploring' })).not.toBeInTheDocument();
  });

  it('shows the send requirement of the selected type', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '选择消息类型' }));
    fireEvent.click(screen.getByRole('option', { name: 'boundary' }));
    expect(screen.getByLabelText('发送要求')).toHaveTextContent('单次尝试失败不能写成 boundary');
    fireEvent.click(screen.getByRole('button', { name: '清除类型' }));
    expect(screen.queryByLabelText('发送要求')).not.toBeInTheDocument();
  });

  it('sends propose_completion without a target', () => {
    const onSend = vi.fn();
    renderPanel({ onSend });
    fireEvent.click(screen.getByRole('button', { name: '选择消息类型' }));
    fireEvent.click(screen.getByRole('option', { name: '提议完成' }));
    fireEvent.change(screen.getByLabelText('content'), { target: { value: 'we are done' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith({ content: 'we are done', type: 'propose_completion' });
  });

  it('shows the first-message hint and sends without a type when the room is empty', () => {
    const onSend = vi.fn();
    renderPanel({ onSend, isFirstMessage: true, agentIds: ['codex'] });
    expect(screen.getByText('第一条消息就是任务目标')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '选择消息类型' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('content'), { target: { value: 'build X @' } });
    expect(screen.queryByRole('listbox', { name: '@ 定向某个 agent' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith({ content: 'build X @' });
  });

  it('labels the goal message and shows status badges', () => {
    renderPanel({
      goalMessageId: 1,
      messages: [
        makeMessage({ id: 1, type: 'open_question', questionStatus: 'OPEN', content: 'goal' }),
        makeMessage({ id: 2, type: 'chain', chainStatus: 'CHALLENGED', targetMessageId: 1, content: 'plan' }),
        makeMessage({ id: 3, type: 'verify', verifyVerdict: false, targetMessageId: 2, content: 'nope' }),
      ],
    });
    expect(screen.getByText('goal', { selector: '.goal-tag' })).toBeInTheDocument();
    expect(screen.getByText('OPEN')).toBeInTheDocument();
    expect(screen.getByText('CHALLENGED')).toBeInTheDocument();
    expect(screen.getByText('驳回')).toBeInTheDocument();
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

  it('offers answer types for a question target and clears them when the target is cancelled', () => {
    const onSend = vi.fn();
    renderPanel({ onSend, messages: [makeMessage({ id: 5, type: 'open_question', questionStatus: 'OPEN', content: 'the question' })] });

    fireEvent.click(screen.getByText('the question'));
    for (const name of ['hypothesis', 'fact', 'boundary', 'chain']) {
      expect(screen.getByRole('option', { name })).toBeInTheDocument();
    }
    expect(screen.queryByRole('option', { name: 'verify' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('option', { name: 'hypothesis' }));
    fireEvent.click(screen.getByRole('button', { name: '取消回复目标' }));
    expect(screen.queryByRole('button', { name: '清除类型' })).not.toBeInTheDocument();
  });

  it('offers challenge/verify according to the target current state', () => {
    renderPanel({
      messages: [
        makeMessage({ id: 1, type: 'fact', content: 'a fact' }),
        makeMessage({ id: 2, type: 'chain', chainStatus: 'CHALLENGED', content: 'a chain' }),
      ],
    });
    fireEvent.click(screen.getByText('a fact'));
    expect(screen.getByRole('option', { name: 'challenge' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'verify' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('a chain'));
    expect(screen.getByRole('option', { name: 'verify' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'challenge' })).not.toBeInTheDocument();
  });

  it('requires a verdict before sending a verify and sends it with the target', () => {
    const onSend = vi.fn();
    renderPanel({ onSend, messages: [makeMessage({ id: 4, type: 'hypothesis', content: 'a guess' })] });
    fireEvent.click(screen.getByText('a guess'));
    fireEvent.click(screen.getByRole('option', { name: 'verify' }));
    fireEvent.change(screen.getByLabelText('content'), { target: { value: 'checked' } });
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    fireEvent.click(screen.getByLabelText('不成立 → boundary'));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith({ content: 'checked', type: 'verify', targetMessageId: 4, verifyVerdict: false });
  });

  it('requires a resolution when a chain closes its question', () => {
    const onSend = vi.fn();
    renderPanel({ onSend, messages: [makeMessage({ id: 1, type: 'open_question', questionStatus: 'OPEN', content: 'q' })] });
    fireEvent.click(screen.getByText('q'));
    fireEvent.click(screen.getByRole('option', { name: 'chain' }));
    fireEvent.change(screen.getByLabelText('content'), { target: { value: 'end to end' } });
    fireEvent.click(screen.getByLabelText('关闭该问题'));
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    fireEvent.click(screen.getByLabelText('已解决'));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith({
      content: 'end to end', type: 'chain', targetMessageId: 1, closesQuestion: true, chainResolution: 'RESOLVED',
    });
  });

  it('does not send a target for an untyped reply, and keeps the input when sending fails', async () => {
    const onSend = vi.fn().mockRejectedValue(new Error('rejected'));
    renderPanel({ onSend, messages: [makeMessage({ id: 9, content: 'some chat' })] });
    fireEvent.click(screen.getByText('some chat'));
    fireEvent.change(screen.getByLabelText('content'), { target: { value: 'reply' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith({ content: 'reply' });
    await Promise.resolve();
    await Promise.resolve();
    expect((screen.getByLabelText('content') as HTMLTextAreaElement).value).toBe('reply');
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

  it('shows a "→ @agentId" badge on a directed message', () => {
    renderPanel({ messages: [makeMessage({ id: 3, content: 'psst', targetAgentId: 'claude' })] });
    expect(screen.getByText('→ @claude')).toBeInTheDocument();
  });

  // @ 定向消息（需求 3.3.2）
  describe('@ 定向某个 agent', () => {
    it('does not open the mention menu when the room has no agents', () => {
      renderPanel({ agentIds: [] });
      fireEvent.change(screen.getByLabelText('content'), { target: { value: '@' } });
      expect(screen.queryByRole('listbox', { name: '@ 定向某个 agent' })).not.toBeInTheDocument();
    });

    it('opens a candidate menu on "@", and picking one sets targetAgentId and inserts the token', () => {
      const onSend = vi.fn();
      renderPanel({ onSend, agentIds: ['codex', 'claude'] });

      fireEvent.change(screen.getByLabelText('content'), { target: { value: 'hey @cl' } });
      expect(screen.getByRole('option', { name: '@claude' })).toBeInTheDocument();
      expect(screen.queryByRole('option', { name: '@codex' })).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('option', { name: '@claude' }));
      expect(screen.getByText('发送给 @claude')).toBeInTheDocument();
      expect((screen.getByLabelText('content') as HTMLTextAreaElement).value).toBe('hey @claude ');

      expect(screen.getByText('这条消息不会唤醒 @claude')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      expect(onSend).toHaveBeenCalledWith({ content: 'hey @claude ', targetAgentId: 'claude' });
    });

    it('drops the directed target when the @token is deleted from the input', () => {
      renderPanel({ agentIds: ['claude'] });
      fireEvent.change(screen.getByLabelText('content'), { target: { value: '@cl' } });
      fireEvent.click(screen.getByRole('option', { name: '@claude' }));
      fireEvent.change(screen.getByLabelText('content'), { target: { value: 'hello' } });
      expect(screen.queryByText('发送给 @claude')).not.toBeInTheDocument();
    });

    it('clears the directed target via its ✕ button without touching the reply target', () => {
      renderPanel({ agentIds: ['claude'] });
      fireEvent.change(screen.getByLabelText('content'), { target: { value: '@claude' } });
      fireEvent.click(screen.getByRole('option', { name: '@claude' }));
      expect(screen.getByText('发送给 @claude')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: '取消定向目标' }));
      expect(screen.queryByText('发送给 @claude')).not.toBeInTheDocument();
    });
  });
});
