import { useLayoutEffect, useMemo, useRef } from 'react';
import type { EventTreePayload } from '../api/types';
import type { TreeEntry } from './EventTreePanel';
import { MessageTypeBadge } from './MessageTypeBadge';
import { colorForAgent, formatClock, OUTCOME_LABELS, sessionTagLabel } from '../utils/format';

type SessionMeta = EventTreePayload['sessions'][number];
type SessionTreeEntry = Exclude<TreeEntry, { kind: 'transition' }>;

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
  // 运行区间（07-frontend.md §9.3）：开始标记行到结束标记行；缺结束标记（running/stopping）时延伸到最后一行。
  firstRow: number;
  lastRow: number;
}

// 列的组成（07-frontend.md §9.3）：有人类消息才出现人类列；session 列就是条目里出现过的 session
// （即可见 session，见 EventTreePanel 的 buildEntries），按 seq 升序。
function buildLanes(entries: SessionTreeEntry[]): Lane[] {
  let hasHuman = false;
  const infoBySeq = new Map<number, { agentId: string; meta?: SessionMeta; start?: number; end?: number }>();
  entries.forEach((entry, row) => {
    if (entry.kind === 'message') {
      const seq = entry.message.sessionSeq;
      if (seq == null) {
        hasHuman = true;
        return;
      }
      if (!infoBySeq.has(seq)) infoBySeq.set(seq, { agentId: entry.message.authorId });
      return;
    }
    const info = infoBySeq.get(entry.seq) ?? { agentId: entry.agentId };
    info.agentId = entry.agentId;
    info.meta = entry.meta;
    if (entry.kind === 'start') info.start = row;
    else info.end = row;
    infoBySeq.set(entry.seq, info);
  });

  const lastRow = entries.length - 1;
  const lanes: Lane[] = hasHuman ? [{ seq: null, color: HUMAN_COLOR, firstRow: -1, lastRow: -2 }] : [];
  for (const seq of [...infoBySeq.keys()].sort((a, b) => a - b)) {
    const info = infoBySeq.get(seq)!;
    lanes.push({
      seq,
      meta: info.meta,
      agentId: info.agentId,
      color: colorForAgent(info.agentId),
      firstRow: info.start ?? 0,
      lastRow: info.end ?? lastRow,
    });
  }
  return lanes;
}

function entrySeq(entry: SessionTreeEntry): number | null {
  return entry.kind === 'message' ? entry.message.sessionSeq : entry.seq;
}

export function SessionLanes(props: {
  // 已按时间合并排好序的消息与边界标记（与时间线页同一份）。
  entries: SessionTreeEntry[];
  onOpenSession: (seq: number) => void;
  onJumpToMessage?: (messageId: number) => void;
}) {
  const { entries } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  const lanes = useMemo(() => buildLanes(entries), [entries]);
  const columnOf = useMemo(() => {
    const map = new Map<number | null, number>();
    lanes.forEach((lane, index) => map.set(lane.seq, index + 2));
    return map;
  }, [lanes]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [entries, lanes]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
  }

  if (entries.length === 0) {
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

        {entries.map((entry, row) => {
          const column = columnOf.get(entrySeq(entry)) ?? 2;
          const lane = lanes[column - 2];
          const laneStyle = { gridColumn: column, ['--tree-color' as string]: lane?.color };
          return (
            <div
              key={entry.key}
              className="lane-row"
              data-lane-message-id={entry.kind === 'message' ? entry.message.id : undefined}
              data-lane-marker={entry.kind === 'message' ? undefined : `${entry.kind}-${entry.seq}`}
            >
              <div className="lane-time">{formatClock(entry.time)}</div>
              {lanes.map((active, index) =>
                active.seq != null && row >= active.firstRow && row <= active.lastRow ? (
                  <span
                    key={`rail-${active.seq}`}
                    className={`lane-rail${row === active.firstRow && entries[row].kind === 'start' ? ' lane-rail--start' : ''}${
                      row === active.lastRow && entries[row].kind === 'end' ? ' lane-rail--end' : ''
                    }`}
                    style={{ gridColumn: index + 2, ['--tree-color' as string]: active.color }}
                    aria-hidden="true"
                  />
                ) : null,
              )}
              {entry.kind === 'message' ? (
                <button
                  type="button"
                  className="lane-event"
                  style={laneStyle}
                  onClick={() => props.onJumpToMessage?.(entry.message.id)}
                  title="定位到消息流"
                >
                  {entry.message.type ? (
                    <MessageTypeBadge type={entry.message.type} />
                  ) : (
                    <span className="type-badge type-badge--none">消息</span>
                  )}
                  <span className="lane-event__id">#{entry.message.id}</span>
                </button>
              ) : (
                <button
                  type="button"
                  className={`lane-event lane-marker${entry.kind === 'end' ? ` outcome-text--${entry.meta.outcome}` : ''}`}
                  style={laneStyle}
                  onClick={() => props.onOpenSession(entry.seq)}
                  title={sessionTagLabel(entry.meta, entry.agentId, entry.seq)}
                >
                  {entry.kind === 'start' ? '▶ 开始' : `■ ${OUTCOME_LABELS[entry.meta.outcome] ?? entry.meta.outcome}`}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
