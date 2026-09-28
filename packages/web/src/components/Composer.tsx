import { useEffect, useMemo, useRef, useState } from 'react';
import type { CloseReason, HumanMessageParams, Message, MessageType } from '../api/types';
import { MessageTypeBadge } from './MessageTypeBadge';
import { colorForAgent, isTriggeringNewMessageType } from '../utils/format';

// 不需要目标的类型（07-frontend.md §7）：fact/boundary 未选目标时即为不挂在问题下的知识。
// 人类不发送 exploring（需求 3.5），任何情况下都不提供入口。
const BASE_TYPES: MessageType[] = ['open_question', 'fact', 'boundary', 'propose_completion'];

// 发送要求提示（07-frontend.md §7）：文案取自 04 §2.1 记忆类型表的"发送要求"列，只做提示、不阻止发送。
export const SEND_REQUIREMENTS: Partial<Record<MessageType, string>> = {
  open_question: '应描述一个具体、可继续探索的问题',
  hypothesis: '针对所选问题的候选答案；存在依据但仍需验证的判断写成 hypothesis',
  fact: '必须有明确证据；直接回答某个问题时请先选中该问题',
  boundary: '必须说明为什么不可行、成立的条件和范围；单次尝试失败不能写成 boundary',
  chain: '一条从输入到输出的完整链路或答案；只有新路径或实质变化才发新 chain；认为足以关闭问题时勾选"关闭该问题"',
  challenge: '写明质疑点和依据',
  verify: '必须采用独立且有实质差异的方法，并给出结论',
  propose_completion: '只有 goal 已得到充分回答、且没有明显其他方向时发送',
};
// 只有选中目标后才会出现的类型；取消目标时已选中的这些类型一并清空。
export const TARGET_ONLY_TYPES: MessageType[] = ['hypothesis', 'chain', 'challenge', 'verify'];

// 按目标的当前 type 与状态追加可选类型，规则与服务端写入校验一致（03-orchestrator-core.md §1.4）。
export function typesForTarget(target: Pick<Message, 'type' | 'chainStatus'> | undefined): MessageType[] {
  if (!target) return [];
  switch (target.type) {
    case 'open_question':
      return ['hypothesis', 'fact', 'boundary', 'chain'];
    case 'fact':
    case 'boundary':
      return ['challenge'];
    case 'hypothesis':
      return ['verify'];
    case 'chain':
      if (target.chainStatus === 'CANDIDATE') return ['verify', 'challenge'];
      if (target.chainStatus === 'CHALLENGED') return ['verify'];
      return ['challenge'];
    default:
      return [];
  }
}

// 这条消息要不要带上 targetMessageId：open_question/propose_completion/无 type 不允许目标；
// fact/boundary 只有目标是问题时才算"回答它"，否则按不挂在问题下的知识发送。
function sendsTarget(type: MessageType | '', target: Pick<Message, 'type'> | undefined): boolean {
  if (!target) return false;
  if (type === 'fact' || type === 'boundary') return target.type === 'open_question';
  return TARGET_ONLY_TYPES.includes(type as MessageType);
}

export function Composer(props: {
  readOnly: boolean;
  // 房间还没有任何消息：这条就是任务目标，由服务端强制写为 open_question（03 §1.4）。
  isFirstMessage: boolean;
  type: MessageType | '';
  onTypeChange: (type: MessageType | '') => void;
  target?: Message;
  onClearTarget: () => void;
  // 房间内可 @ 的 agent 实例标识，按 joinOrder（需求 3.2、3.3.2）；为空则不弹出 @ 候选。
  agentIds: string[];
  // 返回的 Promise 失败时保留输入（错误由调用方 toast 展示），成功后才清空。
  onSend: (params: HumanMessageParams) => Promise<unknown> | void;
}) {
  const [content, setContent] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [targetAgentId, setTargetAgentId] = useState<string | undefined>(undefined);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [verifyVerdict, setVerifyVerdict] = useState<boolean | undefined>(undefined);
  const [closesQuestion, setClosesQuestion] = useState(false);
  const [chainResolution, setChainResolution] = useState<CloseReason | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { type, target, isFirstMessage } = props;
  const targetMessageId = target?.id;

  useEffect(() => {
    if (targetMessageId != null) setPickerOpen(true);
  }, [targetMessageId]);

  // 切换类型/目标时重置附加字段，避免把上一次的 verify 结论或关闭意图带到新消息上。
  useEffect(() => {
    setVerifyVerdict(undefined);
    setClosesQuestion(false);
    setChainResolution(undefined);
  }, [type, targetMessageId]);

  const mentionCandidates = useMemo(
    () =>
      mentionQuery == null || isFirstMessage
        ? []
        : props.agentIds.filter((id) => id.toLowerCase().startsWith(mentionQuery.toLowerCase())),
    [mentionQuery, props.agentIds, isFirstMessage],
  );

  function handleContentChange(value: string) {
    setContent(value);
    if (targetAgentId != null && !value.includes(`@${targetAgentId}`)) setTargetAgentId(undefined);
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

  const availableTypes = [...new Set([...BASE_TYPES, ...typesForTarget(target)])];
  const verdictMissing = type === 'verify' && verifyVerdict == null;
  const resolutionMissing = type === 'chain' && closesQuestion && chainResolution == null;
  const canSend = content.trim().length > 0 && !verdictMissing && !resolutionMissing && !sending;
  const verifyOnChain = target?.type === 'chain';

  function autoResize() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 170)}px`;
  }

  function reset() {
    setContent('');
    props.onTypeChange('');
    setPickerOpen(false);
    setTargetAgentId(undefined);
    setMentionQuery(null);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }

  function handleSend() {
    const params: HumanMessageParams = { content };
    if (!isFirstMessage) {
      if (type) params.type = type;
      if (sendsTarget(type, target)) params.targetMessageId = targetMessageId;
      if (type === 'verify') params.verifyVerdict = verifyVerdict;
      if (type === 'chain' && closesQuestion) {
        params.closesQuestion = true;
        params.chainResolution = chainResolution;
      }
      if (targetAgentId != null) params.targetAgentId = targetAgentId;
    }
    setSending(true);
    Promise.resolve(props.onSend(params))
      .then(reset, () => {})
      .finally(() => setSending(false));
  }

  return (
    <div className="composer">
      {isFirstMessage && <p role="status" className="composer__hint">第一条消息就是任务目标</p>}
      {!isFirstMessage && type && SEND_REQUIREMENTS[type] && (
        <p className="composer__requirement" aria-label="发送要求">发送要求：{SEND_REQUIREMENTS[type]}</p>
      )}
      {!isFirstMessage && (targetMessageId != null || targetAgentId != null) && (
        <div className="composer__row">
          {targetMessageId != null && (
            <span className="composer__target">
              <span className="ref-chip mono">正在回复 #{targetMessageId}</span>
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
              <button type="button" className="ghost" aria-label="取消定向目标" onClick={() => setTargetAgentId(undefined)}>
                ✕
              </button>
              {!isTriggeringNewMessageType(type) && (
                <span className="composer__note">这条消息不会唤醒 @{targetAgentId}</span>
              )}
            </span>
          )}
        </div>
      )}

      {!isFirstMessage && type === 'verify' && (
        <div className="composer__row" role="radiogroup" aria-label="验证结论">
          <label>
            <input type="radio" name="verify-verdict" checked={verifyVerdict === true} onChange={() => setVerifyVerdict(true)} />
            {verifyOnChain ? '通过' : '成立 → fact'}
          </label>
          <label>
            <input type="radio" name="verify-verdict" checked={verifyVerdict === false} onChange={() => setVerifyVerdict(false)} />
            {verifyOnChain ? '驳回' : '不成立 → boundary'}
          </label>
        </div>
      )}

      {!isFirstMessage && type === 'chain' && (
        <div className="composer__row">
          <label>
            <input type="checkbox" checked={closesQuestion} onChange={(e) => setClosesQuestion(e.target.checked)} />
            关闭该问题
          </label>
          {closesQuestion && (
            <span role="radiogroup" aria-label="关闭原因">
              <label>
                <input type="radio" name="chain-resolution" checked={chainResolution === 'RESOLVED'} onChange={() => setChainResolution('RESOLVED')} />
                已解决
              </label>
              <label>
                <input type="radio" name="chain-resolution" checked={chainResolution === 'UNRESOLVED'} onChange={() => setChainResolution('UNRESOLVED')} />
                无法解决
              </label>
            </span>
          )}
        </div>
      )}

      {!isFirstMessage && pickerOpen && type === '' && (
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
        {isFirstMessage ? (
          <span className="composer__type-selected">
            <MessageTypeBadge type="open_question" />
          </span>
        ) : type ? (
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
            placeholder={isFirstMessage ? '描述这个房间要完成的任务…' : '发送一条消息…（输入 @ 可定向某个 agent）'}
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
