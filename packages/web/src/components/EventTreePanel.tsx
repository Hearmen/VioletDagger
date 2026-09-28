import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { EventTreePayload, Message, MessageType } from '../api/types';
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

interface EventTreeProps {
  sessions: EventTreePayload['sessions'];
  messages: Message[];
  onOpenSession: (seq: number) => void;
  onJumpToMessage?: (messageId: number) => void;
}

export function EventTreePanel(props: EventTreeProps) {
  const [tab, setTab] = useState<EventTreeTab>(readStoredTab);

  // 主轴就是真实发生时间：不存在独立的 session 节点，每条消息各自一行（见需求 3.5）。
  // 两个标签页共用同一份排序（07-frontend.md §9.3）。
  const items = useMemo(
    () => [...props.messages].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id - b.id)),
    [props.messages],
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
      count={items.length}
      actions={tabs}
      className="event-tree-panel"
      bodyClassName={tab === 'timeline' ? 'event-tree-body' : 'session-lanes-body'}
    >
      {tab === 'timeline' ? (
        <EventTimeline {...props} items={items} />
      ) : (
        <SessionLanes
          sessions={props.sessions}
          items={items}
          onOpenSession={props.onOpenSession}
          onJumpToMessage={props.onJumpToMessage}
        />
      )}
    </Panel>
  );
}

function EventTimeline(props: EventTreeProps & { items: Message[] }) {
  const { items } = props;
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
  }, [props.messages, props.sessions]);

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

      {items.length === 0 && <p className="placeholder">还没有任何事件</p>}

      {items.map((message) => {
        const isHuman = message.sessionSeq == null;
        const meta = message.sessionSeq != null ? sessionBySeq.get(message.sessionSeq) : undefined;
        const agentId = meta?.agentId ?? message.authorId;
        return (
          <div
            key={message.id}
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

export { edgeTargets };
