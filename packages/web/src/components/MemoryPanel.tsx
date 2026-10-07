import { useState } from 'react';
import type { MemoryViewPayload, Message, StateTransition } from '../api/types';
import { Panel } from './Panel';
import { MessageTypeBadge } from './MessageTypeBadge';
import { MessageStatusBadge } from './MessageStatusBadge';
import { useI18n } from '../i18n/LocaleProvider';
import type { MessageKey } from '../i18n/zh';
import { colorForAgent, formatClock } from '../utils/format';

// 分组展示顺序固定（07-frontend.md §8）。
const GROUPS: readonly (readonly [GroupKey, MessageKey])[] = [
  ['openQuestions', 'memory.group.openQuestions'], ['hypotheses', 'memory.group.hypotheses'], ['facts', 'memory.group.facts'],
  ['boundaries', 'memory.group.boundaries'], ['chains', 'memory.group.chains'], ['exploring', 'memory.group.exploring'],
  ['completionProposals', 'memory.group.completionProposals'], ['challenges', 'memory.group.challenges'], ['verifies', 'memory.group.verifies'],
];

type GroupKey =
  | 'openQuestions' | 'hypotheses' | 'facts' | 'boundaries' | 'chains'
  | 'exploring' | 'completionProposals' | 'challenges' | 'verifies';

const END_REASON_LABELS: Record<string, MessageKey> = {
  explicit: 'memory.endReason.explicit',
  human_terminated: 'memory.endReason.humanTerminated',
};

function transitionText(tr: StateTransition): string {
  return tr.fromType != null || tr.toType != null ? `${tr.fromType}→${tr.toType}` : `${tr.fromStatus}→${tr.toStatus}`;
}

export function MemoryPanel(props: { memory: MemoryViewPayload; onJumpToMessage?: (messageId: number) => void }) {
  const { memory } = props;
  const { t } = useI18n();
  const [groups, setGroups] = useState<Set<string>>(new Set());
  const [items, setItems] = useState<Set<number>>(new Set());
  const all = GROUPS.flatMap(([key]) => memory[key] ?? []);
  const byId = new Map(all.map((m) => [m.id, m]));
  const transitions = memory.transitions ?? {};
  const toggleGroup = (key: string) => setGroups((current) => { const next = new Set(current); next.has(key) ? next.delete(key) : next.add(key); return next; });
  const toggleItem = (id: number) => setItems((current) => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; });

  const pointingAt = (list: Message[], id: number) => list.filter((m) => m.targetMessageId === id);
  const referencedBy = (id: number) => all.filter((m) => m.referencedMessageIds.includes(id)).map((m) => m.id);

  function reference(id: number) {
    return <button key={id} className="ref-chip ref-chip--link" onClick={() => props.onJumpToMessage?.(id)}>#{id}</button>;
  }

  function linked(m: Message) {
    return (
      <div key={m.id} className="memory-item__refs">
        {reference(m.id)}
        {m.type && <MessageTypeBadge type={m.type} />}
        <MessageStatusBadge message={m} targetType={m.targetMessageId != null ? byId.get(m.targetMessageId)?.type : undefined} />
        <span className="memory-item__summary">{m.summary}</span>
      </div>
    );
  }

  function renderDetail(message: Message) {
    const history = transitions[message.id] ?? [];
    const challenges = pointingAt(memory.challenges ?? [], message.id);
    const verifies = pointingAt(memory.verifies ?? [], message.id);
    const reverse = referencedBy(message.id);
    const answerGroups: [string, Message[]][] = message.type === 'open_question'
      ? [
        ['hypothesis', pointingAt(memory.hypotheses ?? [], message.id)],
        ['fact', pointingAt(memory.facts ?? [], message.id)],
        ['boundary', pointingAt(memory.boundaries ?? [], message.id)],
        ['chain', pointingAt(memory.chains ?? [], message.id)],
      ]
      : [];
    const completed = message.exploringStatus === 'completed';
    return (
      <div className="memory-item__detail">
        <div className="memory-item__content">{message.content}</div>
        {message.targetMessageId != null && <div>↳ {reference(message.targetMessageId)}</div>}
        {message.targetAgentId != null && (
          <div className="ref-chip mono" style={{ color: colorForAgent(message.targetAgentId) }}>→ @{message.targetAgentId}</div>
        )}
        {message.type === 'chain' && message.closesQuestion && (
          <div>{t('memory.closeIntent', { reason: t(message.chainResolution === 'RESOLVED' ? 'composer.resolved' : 'composer.unresolved'), value: message.chainResolution ?? '' })}</div>
        )}
        {completed && (
          <div className="memory-item__note">
            {t('memory.completedPrefix', { reason: t(END_REASON_LABELS[message.exploringEndReason ?? ''] ?? 'memory.endReason.unknown') })}
            {message.exploringResultSummary ?? t('memory.noResult')}
            {message.exploringNote ? t('memory.note', { note: message.exploringNote }) : ''}
            {(message.exploringResultMessageIds ?? []).length > 0 && <> {t('memory.resultRefs')}{message.exploringResultMessageIds.map(reference)}</>}
          </div>
        )}
        {history.length > 0 && (
          <div aria-label={t('memory.history')}>
            {t('memory.historyPrefix')}
            {history.map((tr) => (
              <div key={tr.id} className="memory-item__meta">
                {transitionText(tr)} · {t('memory.by')} {reference(tr.triggerMessageId)} · {formatClock(tr.createdAt)}
              </div>
            ))}
          </div>
        )}
        {answerGroups.map(([label, answers]) => answers.length > 0 && (
          <div key={label}>{t('memory.answers', { type: label })}{answers.map(linked)}</div>
        ))}
        {challenges.length > 0 && <div>{t('memory.challenges')}{challenges.map(linked)}</div>}
        {verifies.length > 0 && <div>{t('memory.verifies')}{verifies.map(linked)}</div>}
        {message.referencedMessageIds.length > 0 && <div>{t('memory.references')}{message.referencedMessageIds.map(reference)}</div>}
        {reverse.length > 0 && <div>{t('memory.referencedBy')}{reverse.map(reference)}</div>}
      </div>
    );
  }

  function renderItem(message: Message) {
    const completed = message.exploringStatus === 'completed';
    return (
      <div key={message.id} className={`memory-item ${completed ? 'memory-item--completed' : ''} ${message.exploringStatus === 'active' ? 'memory-item--active' : ''}`}>
        <button className="memory-item__row" aria-label={t('memory.itemLabel', { id: message.id })} aria-expanded={items.has(message.id)} onClick={() => toggleItem(message.id)}>
          <span>{items.has(message.id) ? '▾' : '▸'}</span>
          {message.type && <MessageTypeBadge type={message.type} />}
          <MessageStatusBadge message={message} targetType={message.targetMessageId != null ? byId.get(message.targetMessageId)?.type : undefined} />
          {completed && <span className="memory-item__note">{t('memory.completed')}</span>}
          {memory.goalMessageId === message.id && <span className="goal-tag">{t('messages.goalTag')}</span>}
          <span>#{message.id}</span><span className="memory-item__summary">{message.summary}</span>
        </button>
        {items.has(message.id) && renderDetail(message)}
      </div>
    );
  }

  function groupMessages(key: GroupKey): Message[] {
    const messages = memory[key] ?? [];
    if (key !== 'openQuestions' || memory.goalMessageId == null) return messages;
    // goal 在 openQuestions 中置顶。
    return [...messages.filter((m) => m.id === memory.goalMessageId), ...messages.filter((m) => m.id !== memory.goalMessageId)];
  }

  function chipCount(key: GroupKey, messages: Message[]): string {
    if (key === 'exploring') {
      return `${messages.filter((m) => m.exploringStatus === 'active').length}/${messages.filter((m) => m.exploringStatus === 'completed').length}`;
    }
    if (key === 'openQuestions') return `${messages.length} · OPEN ${messages.filter((m) => m.questionStatus === 'OPEN').length}`;
    if (key === 'chains') return `${messages.length} · VERIFIED ${messages.filter((m) => m.chainStatus === 'VERIFIED').length}`;
    return String(messages.length);
  }

  return (
    <Panel title={t('memory.title')} count={all.length} className="memory-panel" bodyClassName="memory-view">
      <div className="memory-bus">
        {GROUPS.map(([key, label]) => {
          const messages = memory[key] ?? [];
          return (
            <button
              key={key}
              className={`memory-bus__chip ${groups.has(key) ? 'is-open' : ''} ${messages.length ? '' : 'is-empty'}`}
              aria-label={t('memory.groupLabel', { key })}
              aria-expanded={groups.has(key)}
              disabled={!messages.length}
              onClick={() => toggleGroup(key)}
            >
              <span className="memory-bus__label">{t(label)}</span>
              <span className="panel__count mono">{chipCount(key, messages)}</span>
            </button>
          );
        })}
      </div>
      {!all.length && <p className="placeholder">{t('memory.empty')}</p>}
      {GROUPS.map(([key]) => groups.has(key) && (
        <div className="memory-group" key={key}>{groupMessages(key).map(renderItem)}</div>
      ))}
    </Panel>
  );
}
