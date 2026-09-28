import { useLayoutEffect, useMemo, useRef } from 'react';
import type { EventTreePayload, Message } from '../api/types';
import { MessageTypeBadge } from './MessageTypeBadge';
import { colorForAgent, formatClock, sessionTagLabel } from '../utils/format';

type SessionMeta = EventTreePayload['sessions'][number];

// 距底这么近就算"在底部"，新事件到来时自动贴底（07-frontend.md §9.3）。
const NEAR_BOTTOM_PX = 24;
const TIME_COL_W = 64;
const LANE_W = 120;
// 人类列用和时间线页人类行相同的 human 色。
const HUMAN_COLOR = 'var(--accent)';

interface Lane {
  // null 表示人类列。
  seq: number | null;
  color: string;
  meta?: SessionMeta;
  agentId?: string;
}

// 列的组成（07-frontend.md §9.3）：有人类消息才出现人类列；session 列取已加载消息里出现过的
// session 与 running/stopping session 的并集，按 seq 升序。
function buildLanes(items: Message[], sessions: SessionMeta[]): Lane[] {
  const metaBySeq = new Map<number, SessionMeta>();
  for (const session of sessions) metaBySeq.set(session.seq, session);

  let hasHuman = false;
  const authorBySeq = new Map<number, string>();
  for (const message of items) {
    if (message.sessionSeq == null) hasHuman = true;
    else if (!authorBySeq.has(message.sessionSeq)) authorBySeq.set(message.sessionSeq, message.authorId);
  }
  const seqs = new Set(authorBySeq.keys());
  for (const session of sessions) {
    if (session.outcome === 'running' || session.outcome === 'stopping') seqs.add(session.seq);
  }

  const lanes: Lane[] = hasHuman ? [{ seq: null, color: HUMAN_COLOR }] : [];
  for (const seq of [...seqs].sort((a, b) => a - b)) {
    const meta = metaBySeq.get(seq);
    const agentId = meta?.agentId ?? authorBySeq.get(seq)!;
    lanes.push({ seq, meta, agentId, color: colorForAgent(agentId) });
  }
  return lanes;
}

export function SessionLanes(props: {
  sessions: EventTreePayload['sessions'];
  // 已按时间排好序的消息（与时间线页同一份排序）。
  items: Message[];
  onOpenSession: (seq: number) => void;
  onJumpToMessage?: (messageId: number) => void;
}) {
  const { items } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  const lanes = useMemo(() => buildLanes(items, props.sessions), [items, props.sessions]);
  const columnOf = useMemo(() => {
    const map = new Map<number | null, number>();
    lanes.forEach((lane, index) => map.set(lane.seq, index + 2));
    return map;
  }, [lanes]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [items, lanes]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
  }

  if (items.length === 0 && lanes.length === 0) {
    return <p className="placeholder">还没有任何事件</p>;
  }

  const columns = { ['--lane-cols' as string]: `${TIME_COL_W}px repeat(${lanes.length}, ${LANE_W}px)` };

  return (
    <div className="session-lanes" ref={scrollRef} onScroll={handleScroll}>
      <div className="session-lanes__grid" style={columns}>
        <div className="lane-row lane-row--head">
          <div className="lane-time lane-time--head" />
          {lanes.map((lane) =>
            lane.seq == null ? (
              <div key="human" className="lane-head">
                <span className="tree-tag tree-tag--human lane-head__tag">人类</span>
              </div>
            ) : (
              <div key={lane.seq} className="lane-head">
                <button
                  type="button"
                  className={`tree-tag tree-tag--${lane.meta?.outcome ?? 'running'} lane-head__tag`}
                  style={{ ['--tree-color' as string]: lane.color }}
                  onClick={() => props.onOpenSession(lane.seq!)}
                  title={sessionTagLabel(lane.meta, lane.agentId!, lane.seq)}
                >
                  {sessionTagLabel(lane.meta, lane.agentId!, lane.seq)}
                </button>
              </div>
            ),
          )}
        </div>

        {items.length === 0 && <p className="placeholder">还没有任何事件</p>}

        {items.map((message) => {
          const column = columnOf.get(message.sessionSeq) ?? 2;
          const lane = lanes[column - 2];
          return (
            <div key={message.id} className="lane-row" data-lane-message-id={message.id}>
              <div className="lane-time">{formatClock(message.createdAt)}</div>
              <button
                type="button"
                className="lane-event"
                style={{ gridColumn: column, ['--tree-color' as string]: lane?.color }}
                onClick={() => props.onJumpToMessage?.(message.id)}
                title="定位到消息流"
              >
                {message.type ? (
                  <MessageTypeBadge type={message.type} />
                ) : (
                  <span className="type-badge type-badge--none">消息</span>
                )}
                <span className="lane-event__id">#{message.id}</span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
