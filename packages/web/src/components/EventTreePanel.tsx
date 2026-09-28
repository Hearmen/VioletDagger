import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { EventTreePayload, Message, MessageType, StateTransition } from '../api/types';
import { Panel } from './Panel';
import { MessageTypeBadge } from './MessageTypeBadge';
import { SessionLanes } from './SessionLanes';
import { colorForAgent, formatClock, sessionTagLabel, truncate } from '../utils/format';

const EDGE_COLORS: Partial<Record<MessageType, string>> = {
  challenge: 'var(--danger)',
  verify: 'var(--info)',
  chain: 'var(--accent)',
};

type SessionMeta = EventTreePayload['sessions'][number];

interface Edge {
  key: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
}

// 关联线（07-frontend.md §9）：challenge/verify 连到目标，chain 连到每个引用的依据。
function edgeTargets(message: Message): number[] {
  if (message.type === 'chain') return message.referencedMessageIds;
  if (message.type === 'challenge' || message.type === 'verify') {
    return message.targetMessageId != null ? [message.targetMessageId] : [];
  }
  return [];
}

type EventTreeTab = 'timeline' | 'sessions';

// 当前标签页记在 localStorage（07-frontend.md §9.1），读写失败时只是不记忆，不影响渲染。
const TAB_STORAGE_KEY = 'vd.eventTree.tab';

function readStoredTab(): EventTreeTab {
  try {
    return window.localStorage.getItem(TAB_STORAGE_KEY) === 'sessions' ? 'sessions' : 'timeline';
  } catch {
    return 'timeline';
  }
}

function storeTab(tab: EventTreeTab): void {
  try {
    window.localStorage.setItem(TAB_STORAGE_KEY, tab);
  } catch {
    // 不记忆即可。
  }
}

const TABS: { id: EventTreeTab; label: string }[] = [
  { id: 'timeline', label: '时间线' },
  { id: 'sessions', label: 'Session' },
];

// 时间轴上的条目（07-frontend.md §9）：消息，或 session 的开始/结束边界标记。
export type TreeEntry =
  | { kind: 'message'; key: string; time: string; message: Message }
  | { kind: 'transition'; key: string; time: string; transition: StateTransition }
  | { kind: 'start' | 'end'; key: string; time: string; seq: number; agentId: string; meta: SessionMeta };

// 同一时刻：开始标记在前、消息居中、结束标记在后。
const ENTRY_RANK: Record<TreeEntry['kind'], number> = { start: 0, message: 1, transition: 2, end: 3 };

function entryTieBreak(entry: TreeEntry): number {
  if (entry.kind === 'message') return entry.message.id;
  if (entry.kind === 'transition') return entry.transition.id;
  return entry.seq;
}

// 可见 session = 已加载消息里出现过的 session ∪ running/stopping session；只有可见 session 有边界标记。
// 消息与标记合并成一条按时间升序的序列，两个标签页共用。
function buildEntries(
  messages: Message[],
  sessions: SessionMeta[],
  transitions: Record<number, StateTransition[]> = {},
): TreeEntry[] {
  const visible = new Set<number>();
  for (const message of messages) if (message.sessionSeq != null) visible.add(message.sessionSeq);
  for (const session of sessions) {
    if (session.outcome === 'running' || session.outcome === 'stopping') visible.add(session.seq);
  }

  const entries: TreeEntry[] = messages.map((message) => ({
    kind: 'message', key: `m-${message.id}`, time: message.createdAt, message,
  }));
  for (const history of Object.values(transitions)) {
    for (const transition of history) {
      entries.push({ kind: 'transition', key: `t-${transition.id}`, time: transition.createdAt, transition });
    }
  }
  for (const meta of sessions) {
    if (!visible.has(meta.seq)) continue;
    entries.push({ kind: 'start', key: `s-${meta.seq}`, time: meta.startedAt, seq: meta.seq, agentId: meta.agentId, meta });
    if (meta.endedAt != null) {
      entries.push({ kind: 'end', key: `e-${meta.seq}`, time: meta.endedAt, seq: meta.seq, agentId: meta.agentId, meta });
    }
  }
  return entries.sort((a, b) => {
    if (a.time !== b.time) return a.time < b.time ? -1 : 1;
    if (a.kind !== b.kind) return ENTRY_RANK[a.kind] - ENTRY_RANK[b.kind];
    return entryTieBreak(a) - entryTieBreak(b);
  });
}

// 结束标记文案：session 标签在 "agentId #seq" 之后插入 "结束"。
export function endMarkerLabel(meta: SessionMeta, agentId: string, seq: number): string {
  const base = `${agentId} #${seq}`;
  return `${base} 结束${sessionTagLabel(meta, agentId, seq).slice(base.length)}`;
}

interface EventTreeProps {
  sessions: EventTreePayload['sessions'];
  messages: Message[];
  transitions?: Record<number, StateTransition[]>;
  onOpenSession: (seq: number) => void;
  onJumpToMessage?: (messageId: number) => void;
}

export function EventTreePanel(props: EventTreeProps) {
  const [tab, setTab] = useState<EventTreeTab>(readStoredTab);

  // 主轴就是真实发生时间：每条消息各自一行，session 只以开始/结束标记出现（见需求 3.5）。
  const entries = useMemo(
    () => buildEntries(props.messages, props.sessions, props.transitions),
    [props.messages, props.sessions, props.transitions],
  );
  const sessionEntries = entries.filter(
    (entry): entry is Exclude<TreeEntry, { kind: 'transition' }> => entry.kind !== 'transition',
  );

  function selectTab(next: EventTreeTab) {
    setTab(next);
    storeTab(next);
  }

  const tabs = (
    <div className="panel-tabs" role="tablist" aria-label="事件树视图">
      {TABS.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={tab === item.id}
          className={`panel-tab${tab === item.id ? ' panel-tab--active' : ''}`}
          onClick={() => selectTab(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );

  // 未选中的那一页不渲染（07-frontend.md §9.1），切回时重新挂载。
  return (
    <Panel
      title="事件树"
      count={props.messages.length}
      actions={tabs}
      className="event-tree-panel"
      bodyClassName={tab === 'timeline' ? 'event-tree-body' : 'session-lanes-body'}
    >
      {tab === 'timeline' ? (
        <EventTimeline {...props} entries={entries} />
      ) : (
        <SessionLanes
          entries={sessionEntries}
          onOpenSession={props.onOpenSession}
          onJumpToMessage={props.onJumpToMessage}
        />
      )}
    </Panel>
  );
}

function EventTimeline(props: EventTreeProps & { entries: TreeEntry[] }) {
  const { entries } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<Edge[]>([]);

  const sessionBySeq = useMemo(() => {
    const map = new Map<number, SessionMeta>();
    for (const session of props.sessions) map.set(session.seq, session);
    return map;
  }, [props.sessions]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    function measure() {
      if (!container) return;
      const base = container.getBoundingClientRect();
      const positions = new Map<number, DOMRect>();
      container.querySelectorAll<HTMLElement>('[data-message-id]').forEach((el) => {
        positions.set(Number(el.dataset.messageId), el.getBoundingClientRect());
      });

      const next: Edge[] = [];
      container.querySelectorAll<HTMLElement>('[data-edge-from]').forEach((el) => {
        const from = Number(el.dataset.edgeFrom);
        const source = positions.get(from);
        if (!source) return;
        const color = el.dataset.edgeColor ?? 'var(--border-strong)';
        for (const raw of (el.dataset.edgeTo ?? '').split(',')) {
          if (!raw) continue;
          const target = positions.get(Number(raw));
          if (!target) continue;
          // 锚点落在行自己的左边框（--tree-color 描边）上，曲线的隆起段完全落在
          // .event-tree 左侧留出的走线带（44px，见 dashboard.css）里，不会跟行内容重叠。
          next.push({
            key: `${from}-${raw}`,
            x1: source.left - base.left,
            y1: source.top + source.height / 2 - base.top,
            x2: target.left - base.left,
            y2: target.top + target.height / 2 - base.top,
            color,
          });
        }
      });
      setEdges(next);
    }

    measure();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (observer) observer.observe(container);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [props.messages, props.sessions, props.transitions]);

  return (
    <div className="event-tree" ref={containerRef}>
      <svg className="tree-connectors" aria-hidden="true">
        {edges.map((edge) => (
          <path
            key={edge.key}
            d={`M ${edge.x1} ${edge.y1} C ${edge.x1 - 32} ${edge.y1}, ${edge.x2 - 32} ${edge.y2}, ${edge.x2} ${edge.y2}`}
            fill="none"
            stroke={edge.color}
            strokeWidth={1.5}
            opacity={0.55}
          />
        ))}
      </svg>

      {entries.length === 0 && <p className="placeholder">还没有任何事件</p>}

      {entries.map((entry) => {
        if (entry.kind === 'transition') {
          return <TransitionMarkerRow key={entry.key} entry={entry} onJumpToMessage={props.onJumpToMessage} />;
        }
        if (entry.kind !== 'message') {
          return <BoundaryMarkerRow key={entry.key} entry={entry} onOpenSession={props.onOpenSession} />;
        }
        const { message } = entry;
        const isHuman = message.sessionSeq == null;
        const meta = message.sessionSeq != null ? sessionBySeq.get(message.sessionSeq) : undefined;
        const agentId = meta?.agentId ?? message.authorId;
        return (
          <div
            key={entry.key}
            className={`tree-row${isHuman ? ' tree-row--human' : ''}`}
            data-message-id={message.id}
            data-edge-from={message.id}
            data-edge-to={edgeTargets(message).join(',')}
            data-edge-color={message.type ? EDGE_COLORS[message.type] : undefined}
            style={!isHuman ? { ['--tree-color' as string]: colorForAgent(agentId) } : undefined}
          >
            <button
              type="button"
              className="tree-row__time"
              onClick={() => props.onJumpToMessage?.(message.id)}
              title="定位到消息流"
            >
              {formatClock(message.createdAt)}
            </button>
            <div className="tree-row__body">
              <div className="tree-row__top">
                {message.type && <MessageTypeBadge type={message.type} />}
                {isHuman ? (
                  <span className="tree-tag tree-tag--human">人类</span>
                ) : (
                  <button
                    type="button"
                    className={`tree-tag tree-tag--${meta?.outcome ?? 'running'}`}
                    style={{ ['--tree-color' as string]: colorForAgent(agentId) }}
                    onClick={() => props.onOpenSession(message.sessionSeq!)}
                    title="打开 session 详情"
                  >
                    {sessionTagLabel(meta, agentId, message.sessionSeq!)}
                  </button>
                )}
              </div>
              <div className="tree-row__content" onClick={() => props.onJumpToMessage?.(message.id)}>
                {truncate(message.content, 160)}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TransitionMarkerRow(props: {
  entry: Extract<TreeEntry, { kind: 'transition' }>;
  onJumpToMessage?: (messageId: number) => void;
}) {
  const { transition } = props.entry;
  const changes: string[] = [];
  if (transition.fromType != null || transition.toType != null) {
    changes.push(`类型 ${transition.fromType ?? '—'} → ${transition.toType ?? '—'}`);
  }
  if (transition.fromStatus != null || transition.toStatus != null) {
    changes.push(`状态 ${transition.fromStatus ?? '—'} → ${transition.toStatus ?? '—'}`);
  }
  return (
    <div className="tree-marker tree-marker--transition" data-transition-id={transition.id}>
      <span className="tree-marker__time">{formatClock(props.entry.time)}</span>
      <span className="tree-transition__label">状态转化</span>
      <button
        type="button"
        className="tree-transition__link"
        onClick={() => props.onJumpToMessage?.(transition.messageId)}
        title="定位到状态发生变化的消息"
      >
        #{transition.messageId}
      </button>
      <span className="tree-transition__change">{changes.join('；')}</span>
      <span className="tree-transition__trigger">
        触发于{' '}
        <button
          type="button"
          className="tree-transition__link"
          onClick={() => props.onJumpToMessage?.(transition.triggerMessageId)}
          title="定位到触发转换的消息"
        >
          #{transition.triggerMessageId}
        </button>
      </span>
    </div>
  );
}

// 边界标记行（07-frontend.md §9.2）：虚线左边框、只占一行、无内容区；session 文案点击打开详情。
function BoundaryMarkerRow(props: {
  entry: Extract<TreeEntry, { kind: 'start' | 'end' }>;
  onOpenSession: (seq: number) => void;
}) {
  const { entry } = props;
  const isEnd = entry.kind === 'end';
  return (
    <div
      className={`tree-marker tree-marker--${entry.kind}`}
      data-marker={`${entry.kind}-${entry.seq}`}
      style={{ ['--tree-color' as string]: colorForAgent(entry.agentId) }}
    >
      <span className="tree-marker__time">{formatClock(entry.time)}</span>
      <button
        type="button"
        className={`tree-marker__tag${isEnd ? ` outcome-text--${entry.meta.outcome}` : ''}`}
        onClick={() => props.onOpenSession(entry.seq)}
        title="打开 session 详情"
      >
        {isEnd ? `■ ${endMarkerLabel(entry.meta, entry.agentId, entry.seq)}` : `▶ ${entry.agentId} #${entry.seq} 开始`}
      </button>
    </div>
  );
}

export { edgeTargets };
