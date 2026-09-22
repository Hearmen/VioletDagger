import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Room, RoomStatusPayload, RoomStatus, UsageTotals } from '../api/types';
import type { ConnectionState } from '../hooks/useRoomSocket';
import { formatCostUsd, formatTokens } from '../utils/format';

// 房间总用量（07-frontend.md §4，格式同 AgentRail 的用量行）：sessionCount === 0 时不显示；
// costUsd 为 null 时不显示 $ 部分；部分 session 缺费用数据时加 * 提示，不让总数看起来比实际更精确。
function RoomUsageSummary({ usage }: { usage: UsageTotals }) {
  if (usage.sessionCount === 0) return null;
  const title = [
    `输入 ${usage.inputTokens.toLocaleString()}`,
    `输出 ${usage.outputTokens.toLocaleString()}`,
    usage.cacheReadTokens > 0 ? `缓存读 ${usage.cacheReadTokens.toLocaleString()}` : null,
    usage.cacheWriteTokens > 0 ? `缓存写 ${usage.cacheWriteTokens.toLocaleString()}` : null,
  ].filter(Boolean).join(' · ');
  return (
    <span className="mono room-header__usage" title={title}>
      {formatTokens(usage.inputTokens + usage.outputTokens)}
      {usage.costUsd != null && (
        <>
          {' '}· {formatCostUsd(usage.costUsd)}
          {usage.sessionsWithoutCost > 0 && (
            <span title={`${usage.sessionsWithoutCost} 个 session 无费用数据，未计入`}>*</span>
          )}
        </>
      )}
    </span>
  );
}

const STATUS_LABELS: Record<RoomStatus, string> = {
  active: '进行中',
  paused_limit: '已暂停（session 上限）',
  paused_manual: '已暂停（人工）',
  completed: '已结束',
};

export function RoomHeader(props: {
  room: Room;
  status: RoomStatusPayload;
  connectionState: ConnectionState;
  proposeCompletionId?: number | null;
  roomUsage?: UsageTotals;
  onJumpToMessage?: (messageId: number) => void;
  onPause: () => void;
  onResume: (additionalSessions?: number) => void;
  onConfirmCompletion: () => void;
  onDeleteRoom?: () => void;
}) {
  const { room, status, connectionState, proposeCompletionId, onJumpToMessage } = props;
  const readOnly = status.status === 'completed';
  const [dismissedProposeId, setDismissedProposeId] = useState<number | null>(null);
  const [dismissedCaughtUp, setDismissedCaughtUp] = useState(false);

  // completionReason 优先取 getRoomStatus（roomStatus 推送后重拉，最新），初次加载前退回 GET /api/rooms/:id
  // 拿到的 room 快照（见 06-orchestrator-api.md §4、03-orchestrator-core.md §1.4）。
  const completionReason = status.completionReason ?? room.completionReason ?? undefined;
  const completionReferenceMessageId = status.completionReferenceMessageId ?? room.completionReferenceMessageId ?? undefined;

  const showProposeBanner =
    !readOnly && proposeCompletionId != null && proposeCompletionId !== dismissedProposeId;

  // 关闭后直到 allCaughtUp 从 false 变回 true（房间重新活跃过一轮之后再次收敛）前不再出现，
  // 跟 propose_completion 提醒"关闭后等下一条新消息"是同一种去抖动思路（07-frontend.md §4）。
  useEffect(() => {
    if (!status.allCaughtUp) setDismissedCaughtUp(false);
  }, [status.allCaughtUp]);
  const showCaughtUpBanner = status.status === 'active' && status.allCaughtUp && !dismissedCaughtUp;

  function handleResume() {
    if (status.status === 'paused_limit') {
      const raw = window.prompt('additionalSessions (required)');
      if (!raw) return;
      props.onResume(Number(raw));
    } else {
      props.onResume();
    }
  }

  function handleConfirmCompletion() {
    if (window.confirm('确认结束这个房间？结束后转为只读。')) {
      props.onConfirmCompletion();
    }
  }

  function handleDeleteRoom() {
    if (window.confirm('删除这个房间？将级联删除它的 session、记忆、事件树、信息流与磁盘日志，不可恢复。')) {
      props.onDeleteRoom?.();
    }
  }

  return (
    <header className="room-header">
      <div className="room-header__bar">
        <Link to="/" className="room-header__back">
          ← 房间列表
        </Link>
        <h1 className="room-header__name">{room.name}</h1>
        <span className={`status-pill status-pill--${status.status}`}>{STATUS_LABELS[status.status]}</span>
        <span className="mono">{status.currentSessionCount}/{room.maxSessions} sessions</span>
        {props.roomUsage && <RoomUsageSummary usage={props.roomUsage} />}
        {room.workdir && (
          <span className="mono room-header__workdir" title={room.workdir}>
            {room.workdir}
          </span>
        )}
        <span className="room-header__spacer" />
        <span className={`conn-dot conn-dot--${connectionState}`} title={connectionState} />
        {readOnly ? (
          <div className="room-header__controls">
            <span className="room-header__readonly">
              已结束 · 只读
              {completionReason === 'auto_silence' && completionReferenceMessageId != null && (
                <>
                  {' '}· 静默期自动确认（依据{' '}
                  {onJumpToMessage ? (
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => onJumpToMessage(completionReferenceMessageId)}
                    >
                      #{completionReferenceMessageId}
                    </button>
                  ) : (
                    `#${completionReferenceMessageId}`
                  )}
                  ）
                </>
              )}
            </span>
            {props.onDeleteRoom && (
              <button className="danger" onClick={handleDeleteRoom}>
                Delete Room
              </button>
            )}
          </div>
        ) : (
          <div className="room-header__controls">
            {status.status === 'active' && <button onClick={props.onPause}>Pause</button>}
            {status.status !== 'active' && <button onClick={handleResume}>Resume</button>}
            <button className="danger" onClick={handleConfirmCompletion}>
              Confirm Completion
            </button>
          </div>
        )}
      </div>

      <div className="room-header__banners">
        {connectionState === 'disconnected' && (
          <div role="alert" className="banner banner--danger">
            连接已断开，正在重连…
          </div>
        )}
        {showProposeBanner && (
          <div role="alert" className="banner banner--warn">
            有 agent 提议完成这个房间
            {onJumpToMessage && proposeCompletionId != null && (
              <button className="ghost" onClick={() => onJumpToMessage(proposeCompletionId)}>
                查看
              </button>
            )}
            <button className="ghost banner__close" onClick={() => setDismissedProposeId(proposeCompletionId!)}>
              关闭
            </button>
          </div>
        )}
        {showCaughtUpBanner && (
          <div role="alert" className="banner banner--warn">
            所有 agent 都已完成，看起来任务已经收敛
            <button className="ghost banner__close" onClick={() => setDismissedCaughtUp(true)}>
              关闭
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
