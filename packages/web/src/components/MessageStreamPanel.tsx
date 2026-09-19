import { useEffect, useRef, useState } from 'react';
import type { Message, MessageType } from '../api/types';
import { MessageTypeBadge } from './MessageTypeBadge';
import { Composer } from './Composer';
import { Panel } from './Panel';
import { authorInitial, authorLabel, colorForAgent, formatClock } from '../utils/format';

const NEAR_BOTTOM_PX = 80;
const REACTION_TYPES: MessageType[] = ['endorse', 'challenge', 'verify'];

export function MessageStreamPanel(props: {
  messages: Message[];
  nextCursor: number | null;
  loadingEarlier?: boolean;
  onLoadEarlier: () => void;
  onSend: (params: {
    content: string;
    type?: MessageType;
    targetMessageId?: number;
  }) => void;
  readOnly: boolean;
  jumpToMessageId?: number | null;
  onJumpHandled?: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const prevFirstIdRef = useRef<number | null>(null);
  const prevScrollHeightRef = useRef(0);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const [type, setType] = useState<MessageType | ''>('');
  const [targetMessageId, setTargetMessageId] = useState<number | undefined>(undefined);
  const [newCount, setNewCount] = useState(0);
  const [highlightId, setHighlightId] = useState<number | null>(null);

  function scrollToBottom() {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setNewCount(0);
  }

  function jumpTo(messageId: number) {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
    if (!el) return;
    el.scrollIntoView?.({ block: 'center' });
    setHighlightId(messageId);
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => setHighlightId(null), 1600);
  }

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const firstId = props.messages[0]?.id ?? null;
    if (prevFirstIdRef.current === null) {
      el.scrollTop = el.scrollHeight;
    } else if (firstId !== prevFirstIdRef.current) {
      el.scrollTop = el.scrollHeight - prevScrollHeightRef.current;
    } else if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    } else {
      setNewCount((count) => count + 1);
    }
    prevFirstIdRef.current = firstId;
    prevScrollHeightRef.current = el.scrollHeight;
  }, [props.messages]);

  useEffect(() => {
    if (props.jumpToMessageId == null) return;
    jumpTo(props.jumpToMessageId);
    props.onJumpHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.jumpToMessageId]);

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    };
  }, []);

  function handleScroll() {
    const el = listRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
    if (atBottomRef.current) setNewCount(0);
    if (el.scrollTop <= 0 && props.nextCursor != null && !props.loadingEarlier) {
      props.onLoadEarlier();
    }
  }

  function clearReactionType() {
    setType((current) => (REACTION_TYPES.includes(current as MessageType) ? '' : current));
  }

  function toggleTarget(messageId: number) {
    if (targetMessageId === messageId) {
      setTargetMessageId(undefined);
      clearReactionType();
    } else {
      setTargetMessageId(messageId);
    }
  }

  function avatarClass(message: Message): string {
    if (message.authorId === 'human') return 'message__avatar--human';
    if (message.authorId === 'system') return 'message__avatar--system';
    return '';
  }

  return (
    <Panel
      title="消息流"
      count={props.messages.length}
      className="message-panel"
      bodyClassName="panel__body--messages"
    >
      <div className="message-list" ref={listRef} onScroll={handleScroll} data-testid="message-list">
        {props.messages.length > 0 && props.nextCursor === null && (
          <div className="no-earlier">没有更早的消息了</div>
        )}
        {props.loadingEarlier && <div className="no-earlier">加载中…</div>}
        {props.messages.map((message) => {
          const selected = targetMessageId === message.id;
          const isAgent = message.authorId !== 'human' && message.authorId !== 'system';
          return (
            <div
              key={message.id}
              data-message-id={message.id}
              className={[
                'message',
                selected ? 'message--selected' : '',
                message.type === 'propose_completion' ? 'message--propose' : '',
                highlightId === message.id ? 'message--highlight' : '',
              ].join(' ')}
              onClick={() => toggleTarget(message.id)}
            >
              <div
                className={`message__avatar ${avatarClass(message)}`}
                style={isAgent ? { background: colorForAgent(message.authorId) } : undefined}
              >
                {authorInitial(message.authorId)}
              </div>
              <div className="message__main">
                <div className="message__head">
                  <span
                    className="message__author"
                    style={isAgent ? { color: colorForAgent(message.authorId) } : undefined}
                  >
                    {authorLabel(message.authorId)}
                  </span>
                  {message.type && <MessageTypeBadge type={message.type} />}
                  <span className="message__time">{formatClock(message.createdAt)}</span>
                </div>
                <div className="message__content">{message.content}</div>

                {(message.targetMessageId != null || message.referencedMessageIds.length > 0) && (
                  <div className="message__refs">
                    {message.targetMessageId != null && (
                      <span
                        className="ref-chip ref-chip--link"
                        onClick={(e) => {
                          e.stopPropagation();
                          jumpTo(message.targetMessageId!);
                        }}
                      >
                        ↳ #{message.targetMessageId}
                      </span>
                    )}
                    {message.referencedMessageIds.map((id) => (
                      <span
                        key={id}
                        className="ref-chip ref-chip--link"
                        onClick={(e) => {
                          e.stopPropagation();
                          jumpTo(id);
                        }}
                      >
                        引用 #{id}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {newCount > 0 && (
        <button className="new-messages primary" onClick={scrollToBottom}>
          ↓ {newCount} 条新消息
        </button>
      )}

      <Composer
        readOnly={props.readOnly}
        type={type}
        onTypeChange={setType}
        targetMessageId={targetMessageId}
        targetMessageType={props.messages.find(message => message.id === targetMessageId)?.type}
        onClearTarget={() => {
          setTargetMessageId(undefined);
          clearReactionType();
        }}
        onSend={(params) => {
          props.onSend(params);
          setTargetMessageId(undefined);
        }}
      />
    </Panel>
  );
}
