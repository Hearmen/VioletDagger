import { useState } from 'react';
import type { MemoryViewPayload, Message } from '../api/types';
import { Panel } from './Panel';
import { MessageTypeBadge } from './MessageTypeBadge';

const GROUPS = [
  ['facts', 'facts'], ['hypotheses', 'hypotheses'], ['chains', 'chains'],
  ['boundaries', 'boundaries'], ['openQuestions', 'open questions'],
  ['exploring', 'exploring'], ['completionProposals', '完成提议'], ['contextMessages', '关联上下文'],
] as const;

export function MemoryPanel(props: { memory: MemoryViewPayload; onJumpToMessage?: (messageId: number) => void }) {
  const [groups, setGroups] = useState<Set<string>>(new Set());
  const [items, setItems] = useState<Set<number>>(new Set());
  const [focusedId, setFocusedId] = useState<number | null>(null);
  const all = [...GROUPS.flatMap(([key]) => props.memory[key] ?? []), ...(props.memory.reactions ?? [])];
  const byId = new Map(all.map(m => [m.id, m]));
  const relations = props.memory.relations ?? {};
  const toggleGroup = (key: string) => setGroups(current => { const next = new Set(current); next.has(key) ? next.delete(key) : next.add(key); return next; });
  const toggleItem = (id: number) => setItems(current => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; });
  function reference(id: number) {
    return <button key={id} className="ref-chip ref-chip--link" onClick={() => props.onJumpToMessage?.(id)}>#{id}</button>;
  }
  function related(id: number) {
    const message = byId.get(id);
    return <div key={id}>{reference(id)} {message?.type && <MessageTypeBadge type={message.type} />}
      {message && <button onClick={() => { setFocusedId(id); setItems(current => new Set([...current, id])); }}>展开关联 #{id}</button>}
      <span style={{ whiteSpace: 'pre-wrap' }}>{message?.content ?? '未找到关联消息'}</span>
      {message?.referencedMessageIds.length ? <div>依据：{message.referencedMessageIds.map(reference)}</div> : null}
      {(relations[id]?.annotationIds ?? []).map(childId => <div key={childId}>后续注解：{reference(childId)} {byId.get(childId)?.content}</div>)}
    </div>;
  }
  function renderItem(message: Message) {
    const completed = message.exploringStatus === 'completed';
    const rel = relations[message.id];
    return <div key={message.id} className={`memory-item ${completed ? 'memory-item--completed' : ''} ${message.exploringStatus === 'active' ? 'memory-item--active' : ''}`}>
      <button className="memory-item__row" aria-label={`memory item ${message.id}`} aria-expanded={items.has(message.id)} onClick={() => toggleItem(message.id)}>
        <span>{items.has(message.id) ? '▾' : '▸'}</span>
        {message.type && <MessageTypeBadge type={message.type} />}
        <span>#{message.id}</span><span className="memory-item__summary">{message.summary}</span>
      </button>
      {items.has(message.id) && <div className="memory-item__detail">
        <div className="memory-item__content">{message.content}</div>
        {message.targetMessageId != null && <div>目标：{reference(message.targetMessageId)}</div>}
        {!!message.referencedMessageIds.length && <div>引用：{message.referencedMessageIds.map(reference)}</div>}
        {completed && <div className="memory-item__note">已完成：{({ explicit: '主动完成', superseded: '被新方向顶替', human_terminated: '人类终止' } as Record<string, string>)[message.exploringEndReason ?? ''] ?? '结束原因未记录'}；{message.exploringResultSummary ?? '未记录结果'} {message.exploringNote}
          {(message.exploringResultMessageIds ?? []).map(reference)}
        </div>}
        {!!rel?.answerIds.length && <div>已有回答：{rel.answerIds.map(related)}</div>}
        {!!rel?.annotationIds.length && <div>注解：{rel.annotationIds.map(related)}</div>}
        {!!rel?.referencedByIds.length && <div>被引用：{rel.referencedByIds.map(reference)}</div>}
      </div>}
    </div>;
  }
  const orphanReactions = (props.memory.reactions ?? []).filter(m => m.targetMessageId == null || !byId.has(m.targetMessageId));
  return <Panel title="记忆" count={all.length} className="memory-panel" bodyClassName="memory-view">
    <div className="memory-bus">{GROUPS.map(([key, label]) => {
      const messages = props.memory[key] ?? [];
      const count = key === 'exploring' ? `${messages.filter(m => m.exploringStatus === 'active').length}/${messages.filter(m => m.exploringStatus === 'completed').length}` : messages.length;
      return <button key={key} className="memory-bus__chip" aria-label={`memory group ${key}`} aria-expanded={groups.has(key)} disabled={!messages.length} onClick={() => toggleGroup(key)}>
        <span className="memory-bus__label">{label}</span><span className="panel__count mono">{count}</span>
      </button>;
    })}</div>
    {!all.length && <p className="placeholder">还没有结构化记忆</p>}
    {GROUPS.map(([key]) => groups.has(key) && <div className="memory-group" key={key}>{(props.memory[key] ?? []).map(renderItem)}</div>)}
    {orphanReactions.map(renderItem)}
    {focusedId != null && byId.has(focusedId) && <section aria-label="关联消息详情">
      <button onClick={() => setFocusedId(null)}>关闭关联详情</button>
      {renderItem(byId.get(focusedId)!)}
    </section>}
  </Panel>;
}
