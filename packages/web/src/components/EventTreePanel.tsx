import { useLayoutEffect, useRef, useState } from 'react';
import type { EventTreePayload, Message, MessageType, SessionOutcome } from '../api/types';
import { Panel } from './Panel';
import { MessageTypeBadge } from './MessageTypeBadge';
import { colorForAgent, formatClock, truncate } from '../utils/format';

const OUTCOME_COLORS: Record<SessionOutcome, string> = {
  completed: 'var(--ok)',
  passed: 'var(--warn)',
  error: 'var(--danger)',
  terminated: 'var(--accent)',
  running: 'var(--info)',
  stopping: 'var(--warn)',
};

const EDGE_COLORS: Partial<Record<MessageType, string>> = {
  endorse: 'var(--ok)',
  challenge: 'var(--danger)',
  verify: 'var(--info)',
  chain: 'var(--accent)',
  open_question: 'var(--warn)',
};

type SessionItem = { kind: 'session'; session: EventTreePayload['sessions'][number] };
type HumanItem = { kind: 'human'; message: Message };
type Item = SessionItem | HumanItem;

interface Edge {
  key: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
}

function edgeTargets(message: Message): number[] {
  if (message.type === 'chain') return message.referencedMessageIds;
  if (message.type === 'endorse' || message.type === 'challenge' || message.type === 'verify') {
    return message.targetMessageId != null ? [message.targetMessageId] : [];
  }
  if (message.type === 'open_question') {
    return message.targetMessageId != null ? [message.targetMessageId] : [];
  }
  return [];
}

function buildItems(sessions: EventTreePayload['sessions'], humanMessages: Message[]): Item[] {
  const sortedSessions = [...sessions].sort((a, b) => a.seq - b.seq);
  const sortedHumans = [...humanMessages].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  const items: Item[] = [];
  let s = 0;
  let h = 0;
  while (s < sortedSessions.length || h < sortedHumans.length) {
    if (s >= sortedSessions.length) {
      items.push({ kind: 'human', message: sortedHumans[h++] });
    } else if (h >= sortedHumans.length) {
      items.push({ kind: 'session', session: sortedSessions[s++] });
    } else if (sortedHumans[h].createdAt <= sortedSessions[s].startedAt) {
      items.push({ kind: 'human', message: sortedHumans[h++] });
    } else {
      items.push({ kind: 'session', session: sortedSessions[s++] });
    }
  }
  return items;
}

export function EventTreePanel(props: {
  sessions: EventTreePayload['sessions'];
  humanMessages: Message[];
  onOpenSession: (seq: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<Edge[]>([]);
  const items = buildItems(props.sessions, props.humanMessages);

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
          next.push({
            key: `${from}-${raw}`,
            x1: source.right - base.left,
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
  }, [props.sessions, props.humanMessages]);

  return (
    <Panel title="事件树" count={props.sessions.length} className="event-tree-panel" bodyClassName="event-tree-body">
      <div className="event-tree" ref={containerRef}>
        <svg className="tree-connectors" aria-hidden="true">
          {edges.map((edge) => (
            <path
              key={edge.key}
              d={`M ${edge.x1} ${edge.y1} C ${edge.x1 + 40} ${edge.y1}, ${edge.x2 - 40} ${edge.y2}, ${edge.x2} ${edge.y2}`}
              fill="none"
              stroke={edge.color}
              strokeWidth={1.5}
              opacity={0.55}
            />
          ))}
        </svg>

        {items.length === 0 && <p className="placeholder">还没有任何 session</p>}

        {items.map((item) =>
          item.kind === 'session' ? (
            <div
              key={`s-${item.session.seq}`}
              className="tree-node"
              style={{ ['--tree-color' as string]: OUTCOME_COLORS[item.session.outcome] }}
            >
              <button className="tree-node__head" onClick={() => props.onOpenSession(item.session.seq)}>
                <span className="tree-node__title">#{item.session.seq}</span>
                <span className="tree-node__title" style={{ color: colorForAgent(item.session.agentId) }}>
                  {item.session.agentId}
                </span>
                <span className="tree-node__meta">{item.session.outcome}</span>
                <span className="tree-node__meta">
                  {formatClock(item.session.startedAt)} → {item.session.endedAt ? formatClock(item.session.endedAt) : '…'}
                </span>
              </button>
              <div className="tree-node__messages">
                {item.session.messages.map((message) => (
                  <div
                    key={message.id}
                    className="tree-msg"
                    data-message-id={message.id}
                    data-edge-from={message.id}
                    data-edge-to={edgeTargets(message).join(',')}
                    data-edge-color={message.type ? EDGE_COLORS[message.type] : undefined}
                  >
                    {message.type && <MessageTypeBadge type={message.type} />}
                    <span className="tree-msg__content">{truncate(message.content, 160)}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div key={`h-${item.message.id}`} className="tree-node tree-node--human">
              <div className="tree-node__head">
                <span className="tree-node__title">人类</span>
                <span className="tree-node__meta">{formatClock(item.message.createdAt)}</span>
              </div>
              <div className="tree-node__messages">
                <div
                  className="tree-msg"
                  data-message-id={item.message.id}
                  data-edge-from={item.message.id}
                  data-edge-to={edgeTargets(item.message).join(',')}
                  data-edge-color={item.message.type ? EDGE_COLORS[item.message.type] : undefined}
                >
                  {item.message.type && <MessageTypeBadge type={item.message.type} />}
                  <span className="tree-msg__content">{truncate(item.message.content, 160)}</span>
                </div>
              </div>
            </div>
          ),
        )}
      </div>
    </Panel>
  );
}

export { edgeTargets };
