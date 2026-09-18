import { useEffect, useRef, useState } from 'react';
import type { MessageType } from '../api/types';
import { MessageTypeBadge } from './MessageTypeBadge';

const BASE_TYPES: MessageType[] = ['fact', 'hypothesis', 'open_question'];
const REACTION_TYPES: MessageType[] = ['endorse', 'challenge', 'verify'];

export function Composer(props: {
  readOnly: boolean;
  type: MessageType | '';
  onTypeChange: (type: MessageType | '') => void;
  targetMessageId?: number;
  onClearTarget: () => void;
  onSend: (params: {
    content: string;
    type?: MessageType;
    targetMessageId?: number;
  }) => void;
}) {
  const [content, setContent] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const type = props.type;

  useEffect(() => {
    if (props.targetMessageId != null) setPickerOpen(true);
  }, [props.targetMessageId]);

  if (props.readOnly) {
    return <div className="composer__readonly">房间已结束，只读</div>;
  }

  const availableTypes =
    props.targetMessageId != null ? [...BASE_TYPES, ...REACTION_TYPES] : BASE_TYPES;
  const needsTarget = REACTION_TYPES.includes(type as MessageType);
  const missingTarget = needsTarget && props.targetMessageId == null;
  const canSend = content.trim().length > 0 && !missingTarget;

  function autoResize() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 170)}px`;
  }

  function handleSend() {
    props.onSend({
      content,
      type: type || undefined,
      targetMessageId: props.targetMessageId,
    });
    setContent('');
    props.onTypeChange('');
    setPickerOpen(false);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }

  return (
    <div className="composer">
      {props.targetMessageId != null && (
        <div className="composer__row">
          <span className="composer__target">
            <span className="ref-chip mono">正在回复 #{props.targetMessageId}</span>
            <button type="button" className="ghost" aria-label="取消回复目标" onClick={props.onClearTarget}>
              ✕
            </button>
          </span>
        </div>
      )}

      {pickerOpen && type === '' && (
        <div className="composer__type-menu" role="listbox" aria-label="message type">
          {availableTypes.map((t) => (
            <button
              key={t}
              type="button"
              role="option"
              aria-selected={false}
              className="composer__type-option"
              onClick={() => {
                props.onTypeChange(t);
                setPickerOpen(false);
              }}
            >
              <MessageTypeBadge type={t} />
            </button>
          ))}
        </div>
      )}

      <div className="composer__row composer__row--bottom">
        {type ? (
          <span className="composer__type-selected">
            <MessageTypeBadge type={type} />
            <button type="button" className="ghost" aria-label="清除类型" onClick={() => props.onTypeChange('')}>
              ✕
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="ghost composer__type-trigger"
            aria-label="选择消息类型"
            onClick={() => setPickerOpen((open) => !open)}
          >
            ＋ 类型
          </button>
        )}

        <textarea
          aria-label="content"
          ref={textareaRef}
          value={content}
          placeholder="发送一条消息…"
          onChange={(e) => {
            setContent(e.target.value);
            autoResize();
          }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canSend) {
              e.preventDefault();
              handleSend();
            }
          }}
        />
        <button className="primary" onClick={handleSend} disabled={!canSend}>
          Send
        </button>
      </div>
    </div>
  );
}
