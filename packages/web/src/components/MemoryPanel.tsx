import { useState } from 'react';
import type { MemoryViewPayload, Message, MessageType } from '../api/types';
import { Panel } from './Panel';
import { MessageTypeBadge } from './MessageTypeBadge';
import { colorForAgent, formatClock } from '../utils/format';

type GroupKey = 'facts' | 'hypotheses' | 'chains' | 'boundaries' | 'openQuestions' | 'exploring';

const GROUP_ORDER: { key: GroupKey; label: string; type: MessageType }[] = [
  { key: 'facts', label: 'facts', type: 'fact' },
  { key: 'hypotheses', label: 'hypotheses', type: 'hypothesis' },
  { key: 'chains', label: 'chains', type: 'chain' },
  { key: 'boundaries', label: 'boundaries', type: 'boundary' },
  { key: 'openQuestions', label: 'open questions', type: 'open_question' },
  { key: 'exploring', label: 'exploring', type: 'exploring' },
];

function groupByAuthor(messages: Message[]): [string, Message[]][] {
  const groups = new Map<string, Message[]>();
  for (const message of messages) {
    const list = groups.get(message.authorId);
    if (list) list.push(message);
    else groups.set(message.authorId, [message]);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }
  return Array.from(groups.entries());
}

// 记忆面板：总线（类别索引 + 计数，默认折叠）+ 逐级下钻（类别 -> 条目 -> 全文/注解）。
// 数据仍只来自 getMemoryView()，这里纯粹是展示层的渐进式组织（docs/design/07-frontend.md 第 8 节）。
export function MemoryPanel(props: { memory: MemoryViewPayload; onJumpToMessage?: (messageId: number) => void }) {
  const [expandedGroups, setExpandedGroups] = useState<Set<GroupKey>>(new Set());
  const [expandedItems, setExpandedItems] = useState<Set<number>>(new Set());

  const total = GROUP_ORDER.reduce((sum, group) => sum + props.memory[group.key].length, 0);

  function toggleGroup(key: GroupKey) {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleItem(id: number) {
    setExpandedItems((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function groupCountLabel(key: GroupKey): string {
    if (key !== 'exploring') return String(props.memory[key].length);
    const active = props.memory.exploring.filter((m) => m.exploringStatus === 'active').length;
    const completed = props.memory.exploring.filter((m) => m.exploringStatus === 'completed').length;
    return `${active}/${completed}`;
  }

  function renderItem(message: Message) {
    const completed = message.exploringStatus === 'completed';
    const isAgent = message.authorId !== 'human' && message.authorId !== 'system';
    const isOpen = expandedItems.has(message.id);
    return (
      <div
        key={message.id}
        className={[
          'memory-item',
          completed ? 'memory-item--completed' : '',
          message.type === 'exploring' && message.exploringStatus === 'active' ? 'memory-item--active' : '',
        ].join(' ')}
      >
        <button
          type="button"
          className="memory-item__row"
          aria-expanded={isOpen}
          aria-label={`memory item ${message.id}`}
          onClick={() => toggleItem(message.id)}
        >
          <span className="memory-item__chevron">{isOpen ? '▾' : '▸'}</span>
          {message.type && <MessageTypeBadge type={message.type} />}
          <span
            className="memory-item__author"
            style={isAgent ? { color: colorForAgent(message.authorId) } : undefined}
          >
            {message.authorId}
          </span>
          <span className="mono memory-item__time">{formatClock(message.createdAt)}</span>
          <span className="memory-item__summary">{message.summary}</span>
        </button>

        {isOpen && (
          <div className="memory-item__detail">
            <div className="memory-item__content">{message.content}</div>
            <div className="memory-item__meta">
              {message.targetMessageId != null && (
                <span
                  className="ref-chip ref-chip--link"
                  onClick={() => props.onJumpToMessage?.(message.targetMessageId!)}
                >
                  ↳ #{message.targetMessageId}
                </span>
              )}
              {message.referencedMessageIds.length > 0 && (
                <span className="memory-item__refs">
                  引用：{message.referencedMessageIds.map((id) => `#${id}`).join(' ')}
                </span>
              )}
              {completed && (
                <em className="memory-item__note">
                  已完成{message.exploringNote ? `：${message.exploringNote}` : ''}
                </em>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <Panel title="记忆" count={total} className="memory-panel" bodyClassName="memory-view">
      <div className="memory-bus">
        {GROUP_ORDER.map((group) => {
          const expanded = expandedGroups.has(group.key);
          const count = props.memory[group.key].length;
          return (
            <button
              key={group.key}
              type="button"
              className={`memory-bus__chip ${expanded ? 'is-open' : ''} ${count === 0 ? 'is-empty' : ''}`}
              aria-expanded={expanded}
              aria-label={`memory group ${group.key}`}
              disabled={count === 0}
              onClick={() => toggleGroup(group.key)}
            >
              <span className="memory-bus__label">{group.label}</span>
              <span className="panel__count mono">{groupCountLabel(group.key)}</span>
            </button>
          );
        })}
      </div>

      {total === 0 && <p className="placeholder">还没有结构化记忆</p>}

      {GROUP_ORDER.map((group) => {
        if (!expandedGroups.has(group.key)) return null;
        const messages = props.memory[group.key];
        if (messages.length === 0) return null;
        return (
          <div key={group.key} className="memory-group">
            {group.key !== 'exploring'
              ? messages.map(renderItem)
              : groupByAuthor(messages).map(([authorId, list]) => (
                  <div key={authorId}>
                    <div className="exploring-author">{authorId}</div>
                    {list.map(renderItem)}
                  </div>
                ))}
          </div>
        );
      })}
    </Panel>
  );
}
