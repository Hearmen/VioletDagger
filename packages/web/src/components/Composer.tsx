import { useEffect, useMemo, useRef, useState } from 'react';
import type { CloseReason, HumanMessageParams, Message, MessageType } from '../api/types';
import { MessageTypeBadge } from './MessageTypeBadge';
import { useI18n } from '../i18n/LocaleProvider';
import type { MessageKey } from '../i18n/zh';
import { colorForAgent, isTriggeringNewMessageType } from '../utils/format';

// 不需要目标的类型（07-frontend.md §7）：fact/boundary 未选目标时即为不挂在问题下的知识。
// 人类不发送 exploring（需求 3.5），任何情况下都不提供入口。
const BASE_TYPES: MessageType[] = ['open_question', 'fact', 'boundary', 'propose_completion'];

// 发送要求提示（07-frontend.md §7）：文案取自 04 §2.1 记忆类型表的"发送要求"列，只做提示、不阻止发送。
export const SEND_REQUIREMENTS: Partial<Record<MessageType, MessageKey>> = {
  open_question: 'composer.requirement.open_question',
  hypothesis: 'composer.requirement.hypothesis',
  fact: 'composer.requirement.fact',
  boundary: 'composer.requirement.boundary',
  chain: 'composer.requirement.chain',
  challenge: 'composer.requirement.challenge',
  verify: 'composer.requirement.verify',
  propose_completion: 'composer.requirement.propose_completion',
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
  const { t } = useI18n();
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
    return <div className="composer__readonly">{t('composer.readonly')}</div>;
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
      {isFirstMessage && <p role="status" className="composer__hint">{t('composer.firstMessageHint')}</p>}
      {!isFirstMessage && type && SEND_REQUIREMENTS[type] && (
        <p className="composer__requirement" aria-label={t('composer.requirementLabel')}>
          {t('composer.requirement', { text: t(SEND_REQUIREMENTS[type]!) })}
        </p>
      )}
      {!isFirstMessage && (targetMessageId != null || targetAgentId != null) && (
        <div className="composer__row">
          {targetMessageId != null && (
            <span className="composer__target">
              <span className="ref-chip mono">{t('composer.replyingTo', { id: targetMessageId })}</span>
              <button type="button" className="ghost" aria-label={t('composer.clearReplyTarget')} onClick={props.onClearTarget}>
                ✕
              </button>
            </span>
          )}
          {targetAgentId != null && (
            <span className="composer__target">
              <span className="ref-chip mono" style={{ color: colorForAgent(targetAgentId) }}>
                {t('composer.sendTo', { agentId: targetAgentId })}
              </span>
              <button type="button" className="ghost" aria-label={t('composer.clearAgentTarget')} onClick={() => setTargetAgentId(undefined)}>
                ✕
              </button>
              {!isTriggeringNewMessageType(type) && (
                <span className="composer__note">{t('composer.willNotWake', { agentId: targetAgentId })}</span>
              )}
            </span>
          )}
        </div>
      )}

      {!isFirstMessage && type === 'verify' && (
        <div className="composer__row" role="radiogroup" aria-label={t('composer.verifyVerdict')}>
          <label>
            <input type="radio" name="verify-verdict" checked={verifyVerdict === true} onChange={() => setVerifyVerdict(true)} />
            {verifyOnChain ? t('composer.verifyPass') : t('composer.verifyHolds')}
          </label>
          <label>
            <input type="radio" name="verify-verdict" checked={verifyVerdict === false} onChange={() => setVerifyVerdict(false)} />
            {verifyOnChain ? t('composer.verifyReject') : t('composer.verifyNotHolds')}
          </label>
        </div>
      )}

      {!isFirstMessage && type === 'chain' && (
        <div className="composer__row">
          <label>
            <input type="checkbox" checked={closesQuestion} onChange={(e) => setClosesQuestion(e.target.checked)} />
            {t('composer.closesQuestion')}
          </label>
          {closesQuestion && (
            <span role="radiogroup" aria-label={t('composer.closeReason')}>
              <label>
                <input type="radio" name="chain-resolution" checked={chainResolution === 'RESOLVED'} onChange={() => setChainResolution('RESOLVED')} />
                {t('composer.resolved')}
              </label>
              <label>
                <input type="radio" name="chain-resolution" checked={chainResolution === 'UNRESOLVED'} onChange={() => setChainResolution('UNRESOLVED')} />
                {t('composer.unresolved')}
              </label>
            </span>
          )}
        </div>
      )}

      {!isFirstMessage && pickerOpen && type === '' && (
        <div className="composer__type-menu" role="listbox" aria-label={t('composer.typeMenu')}>
          {availableTypes.map((option) => (
            <button
              key={option}
              type="button"
              role="option"
              aria-selected={false}
              className="composer__type-option"
              onClick={() => {
                props.onTypeChange(option);
                setPickerOpen(false);
              }}
            >
              <MessageTypeBadge type={option} />
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
            <button type="button" className="ghost" aria-label={t('composer.clearType')} onClick={() => props.onTypeChange('')}>
              ✕
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="ghost composer__type-trigger"
            aria-label={t('composer.pickType')}
            onClick={() => setPickerOpen((open) => !open)}
          >
            {t('composer.typeTrigger')}
          </button>
        )}

        <div className="composer__textarea-wrap">
          <textarea
            aria-label={t('composer.content')}
            ref={textareaRef}
            value={content}
            placeholder={isFirstMessage ? t('composer.goalPlaceholder') : t('composer.placeholder')}
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
            <div className="composer__mention-menu" role="listbox" aria-label={t('composer.mentionMenu')}>
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
          {t('composer.send')}
        </button>
      </div>
    </div>
  );
}
