import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Room, RoomStatusPayload, RoomStatus, UsageTotals } from '../api/types';
import type { ConnectionState } from '../hooks/useRoomSocket';
import { useI18n } from '../i18n/LocaleProvider';
import type { MessageKey } from '../i18n/zh';
import { formatCostUsd, formatTokens, formatUsageParts } from '../utils/format';
import { LocaleToggle } from './LocaleToggle';

// 房间总用量（07-frontend.md §4，格式同 AgentRail 的用量行）：sessionCount === 0 时不显示；
// costUsd 为 null 时不显示 $ 部分；部分 session 缺费用数据时加 * 提示，不让总数看起来比实际更精确。
function RoomUsageSummary({ usage }: { usage: UsageTotals }) {
  const { t, locale } = useI18n();
  if (usage.sessionCount === 0) return null;
  const title = formatUsageParts(usage, t, locale).join(' · ');
  return (
    <span className="mono room-header__usage" title={title}>
      {formatTokens(usage.inputTokens + usage.outputTokens)}
      {usage.costUsd != null && (
        <>
          {' '}· {formatCostUsd(usage.costUsd)}
          {usage.sessionsWithoutCost > 0 && (
            <span title={t('format.sessionsWithoutCost', { count: usage.sessionsWithoutCost })}>*</span>
          )}
        </>
      )}
    </span>
  );
}

export const ROOM_STATUS_LABELS: Record<RoomStatus, MessageKey> = {
  active: 'header.statusActive',
  paused_limit: 'header.statusPausedLimit',
  paused_manual: 'header.statusPausedManual',
  completed: 'header.statusCompleted',
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
  onOpenReport?: () => void;
}) {
  const { room, status, connectionState, proposeCompletionId, onJumpToMessage } = props;
  const { t } = useI18n();
  const readOnly = status.status === 'completed';
  const [dismissedProposeId, setDismissedProposeId] = useState<number | null>(null);

  const showProposeBanner =
    !readOnly && proposeCompletionId != null && proposeCompletionId !== dismissedProposeId;

  // 无任务派发提醒（07-frontend.md §4）：关闭后要等 dispatchIdle 先变回 false、再变为 true 才再次出现。
  const [dismissedIdle, setDismissedIdle] = useState(false);
  useEffect(() => {
    if (!status.dispatchIdle) setDismissedIdle(false);
  }, [status.dispatchIdle]);
  const showIdleBanner = status.dispatchIdle && !dismissedIdle;

  function handleResume() {
    if (status.status === 'paused_limit') {
      const raw = window.prompt(t('header.resumePrompt'));
      if (!raw) return;
      props.onResume(Number(raw));
    } else {
      props.onResume();
    }
  }

  function handleConfirmCompletion() {
    if (window.confirm(t('header.confirmCompletionPrompt'))) {
      props.onConfirmCompletion();
    }
  }

  function handleDeleteRoom() {
    if (window.confirm(t('header.deleteRoomPrompt'))) {
      props.onDeleteRoom?.();
    }
  }

  return (
    <header className="room-header">
      <div className="room-header__bar">
        <Link to="/" className="room-header__back">
          {t('header.backToRooms')}
        </Link>
        <h1 className="room-header__name">{room.name}</h1>
        <span className={`status-pill status-pill--${status.status}`}>{t(ROOM_STATUS_LABELS[status.status])}</span>
        <span className="mono">{t('header.sessionCount', { current: status.currentSessionCount, max: room.maxSessions })}</span>
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
            <span className="room-header__readonly">{t('header.readonly')}</span>
            {props.onDeleteRoom && (
              <button className="danger" onClick={handleDeleteRoom}>
                {t('header.deleteRoom')}
              </button>
            )}
          </div>
        ) : (
          <div className="room-header__controls">
            {status.status === 'active' && <button onClick={props.onPause}>{t('header.pause')}</button>}
            {status.status !== 'active' && <button onClick={handleResume}>{t('header.resume')}</button>}
            <button className="danger" onClick={handleConfirmCompletion}>
              {t('header.confirmCompletion')}
            </button>
          </div>
        )}
        {props.onOpenReport && (
          <button onClick={props.onOpenReport} title={t('header.reportTitle')}>
            {t('header.report')}
          </button>
        )}
        <LocaleToggle />
      </div>

      <div className="room-header__banners">
        {connectionState === 'disconnected' && (
          <div role="alert" className="banner banner--danger">
            {t('header.disconnected')}
          </div>
        )}
        {showProposeBanner && (
          <div role="alert" className="banner banner--warn">
            {t('header.proposeCompletion')}
            {onJumpToMessage && proposeCompletionId != null && (
              <button className="ghost" onClick={() => onJumpToMessage(proposeCompletionId)}>
                {t('header.view')}
              </button>
            )}
            <button className="ghost banner__close" onClick={() => setDismissedProposeId(proposeCompletionId!)}>
              {t('common.close')}
            </button>
          </div>
        )}
        {showIdleBanner && (
          <div role="alert" className="banner banner--warn">
            {t('header.dispatchIdle')}
            {status.disabledAgentCount > 0 && t('header.disabledAgents', { count: status.disabledAgentCount })}
            <button className="ghost banner__close" onClick={() => setDismissedIdle(true)}>
              {t('common.close')}
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
