import { useEffect, useMemo, useRef, useState } from 'react';
import type { MessageType } from '../api/types';
import { MessageTypeBadge } from './MessageTypeBadge';
import { colorForAgent } from '../utils/format';

const BASE_TYPES: MessageType[] = ['fact', 'hypothesis', 'open_question'];
const REACTION_TYPES: MessageType[] = ['endorse', 'challenge', 'verify'];

export function Composer(props: {
  readOnly: boolean;
  type: MessageType | '';
  onTypeChange: (type: MessageType | '') => void;
  targetMessageId?: number;
  targetMessageType?: MessageType | null;
  onClearTarget: () => void;
  // 房间内可 @ 的 agent 实例标识，按 joinOrder（需求 3.2、3.3.2）；为空则不弹出 @ 候选。
  agentIds: string[];
  onSend: (params: {
    content: string;
    type?: MessageType;
    targetMessageId?: number;
    targetAgentId?: string;
  }) => void;
}) {
  const [content, setContent] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [targetAgentId, setTargetAgentId] = useState<string | undefined>(undefined);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const type = props.type;

  useEffect(() => {
    if (props.targetMessageId != null) setPickerOpen(true);
  }, [props.targetMessageId]);

  const mentionCandidates = useMemo(
    () =>
      mentionQuery == null
        ? []
        : props.agentIds.filter((id) => id.toLowerCase().startsWith(mentionQuery.toLowerCase())),
    [mentionQuery, props.agentIds],
  );

  function handleContentChange(value: string) {
    setContent(value);
    const cursor = textareaRef.current?.selectionStart ?? value.length;
    const beforeCursor = value.slice(0, cursor);
    const match = beforeCursor.match(/(?:^|\s)@([^\s@]*)$/);
    setMentionQuery(props.agentIds.length > 0 && match ? match[1] : null);
  }

  function pickMention(agentId: string) {
    const cursor = textareaRef.current?.selectionStart ?? content.length;
    const beforeCursor = content.slice(0, cursor);
    const replaced = beforeCursor.replace(/@([^\s@]*)$/, `@${agentId} `);
    setContent(replaced + content.slice(cursor));
    setTargetAgentId(agentId);
    setMentionQuery(null);
    textareaRef.current?.focus();
  }

  if (props.readOnly) {
    return <div className="composer__readonly">房间已结束，只读</div>;
  }

  const availableTypes =
    props.targetMessageId != null ? [...BASE_TYPES, ...REACTION_TYPES] : BASE_TYPES;
  const needsTarget = type === 'hypothesis' || REACTION_TYPES.includes(type as MessageType);
  const missingTarget = needsTarget && props.targetMessageId == null;
  const invalidAnswerTarget = (type === 'hypothesis' || type === 'fact') && props.targetMessageId != null && props.targetMessageType !== 'open_question';
  const canSend = content.trim().length > 0 && !missingTarget && !invalidAnswerTarget;

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
      targetAgentId,
    });
    setContent('');
    props.onTypeChange('');
    setPickerOpen(false);
    setTargetAgentId(undefined);
    setMentionQuery(null);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }

  function clearTargetAgent() {
    setTargetAgentId(undefined);
  }

  return (
    <div className="composer">
      {(type === 'hypothesis' && missingTarget || invalidAnswerTarget) && <p role="status">请选择一条 open_question 作为回答目标</p>}
      {(props.targetMessageId != null || targetAgentId != null) && (
        <div className="composer__row">
          {props.targetMessageId != null && (
            <span className="composer__target">
              <span className="ref-chip mono">正在回复 #{props.targetMessageId}</span>
              <button type="button" className="ghost" aria-label="取消回复目标" onClick={props.onClearTarget}>
                ✕
              </button>
            </span>
          )}
          {targetAgentId != null && (
            <span className="composer__target">
              <span className="ref-chip mono" style={{ color: colorForAgent(targetAgentId) }}>
                发送给 @{targetAgentId}
              </span>
              <button type="button" className="ghost" aria-label="取消定向目标" onClick={clearTargetAgent}>
                ✕
              </button>
            </span>
          )}
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

        <div className="composer__textarea-wrap">
          <textarea
            aria-label="content"
            ref={textareaRef}
            value={content}
            placeholder="发送一条消息…（输入 @ 可定向某个 agent）"
            onChange={(e) => {
              handleContentChange(e.target.value);
              autoResize();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && mentionCandidates.length > 0) {
                setMentionQuery(null);
                return;
              }
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canSend) {
                e.preventDefault();
                handleSend();
              }
            }}
          />
          {mentionCandidates.length > 0 && (
            <div className="composer__mention-menu" role="listbox" aria-label="@ 定向某个 agent">
              {mentionCandidates.map((agentId) => (
                <button
                  key={agentId}
                  type="button"
                  role="option"
                  aria-selected={false}
                  className="composer__mention-option"
                  onClick={() => pickMention(agentId)}
                >
                  <span className="composer__mention-dot" style={{ background: colorForAgent(agentId) }} />
                  <span className="mono">@{agentId}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button className="primary" onClick={handleSend} disabled={!canSend}>
          Send
        </button>
      </div>
    </div>
  );
}
