import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Room, RoomStatusPayload, RoomStatus } from '../api/types';
import type { ConnectionState } from '../hooks/useRoomSocket';

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
  onJumpToMessage?: (messageId: number) => void;
  onPause: () => void;
  onResume: (additionalSessions?: number) => void;
  onConfirmCompletion: () => void;
  onDeleteRoom?: () => void;
}) {
  const { room, status, connectionState, proposeCompletionId, onJumpToMessage } = props;
  const readOnly = status.status === 'completed';
  const [dismissedProposeId, setDismissedProposeId] = useState<number | null>(null);

  const showProposeBanner =
    !readOnly && proposeCompletionId != null && proposeCompletionId !== dismissedProposeId;

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
        {room.workdir && (
          <span className="mono room-header__workdir" title={room.workdir}>
            {room.workdir}
          </span>
        )}
        <span className="room-header__spacer" />
        <span className={`conn-dot conn-dot--${connectionState}`} title={connectionState} />
        {readOnly ? (
          <div className="room-header__controls">
            <span className="room-header__readonly">已结束 · 只读</span>
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
      </div>
    </header>
  );
}
