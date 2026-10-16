import { useEffect } from 'react';
import type { Message, SessionDetailPayload, SessionEventKind } from '../api/types';
import { useSessionLog } from '../hooks/useSessionLog';
import { useI18n } from '../i18n/LocaleProvider';
import type { MessageKey } from '../i18n/zh';
import {
  authorInitial, authorLabel, colorForAgent, formatClock, formatCostUsd, formatDuration, formatNumber, outcomeLabel,
} from '../utils/format';
import { MessageTypeBadge } from './MessageTypeBadge';
import { SessionLogView } from './SessionLogView';

const LIFECYCLE_LABELS: Record<SessionEventKind, MessageKey> = {
  cleanup_started: 'session.lifecycle.cleanup_started',
  sigterm_sent: 'session.lifecycle.sigterm_sent',
  sigkill_sent: 'session.lifecycle.sigkill_sent',
  cleanup_failed: 'session.lifecycle.cleanup_failed',
  terminate_requested: 'session.lifecycle.terminate_requested',
  process_exited: 'session.lifecycle.process_exited',
  terminated: 'session.lifecycle.terminated',
  native_session_failed: 'session.lifecycle.native_session_failed',
};

// 复盘入口（事件树 session 节点）：元数据 + 该 session 的消息列表 + 生命周期记录 + 只读日志回放。
// 交互入口是 LiveSessionModal（AgentRail），两者内容刻意不同（见 docs/design/07-frontend.md §10.2）。
export function SessionDetailModal(props: {
  roomId: number;
  detail: SessionDetailPayload | null;
  onClose: () => void;
}) {
  const { detail, roomId, onClose } = props;
  const { t, locale } = useI18n();
  const log = useSessionLog(roomId, detail?.sessionId ?? 0, 'replay');

  useEffect(() => {
    if (!detail) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [detail, onClose]);

  if (!detail) return null;

  const running = detail.outcome === 'running' || detail.outcome === 'stopping';
  const duration =
    detail.endedAt != null
      ? formatDuration((new Date(detail.endedAt).getTime() - new Date(detail.startedAt).getTime()) / 1000)
      : t('session.outcomeRunning');

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal modal--session-detail"
        role="dialog"
        aria-modal="true"
        aria-label={t('session.detailLabel')}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal__head">
          <span className="mono" style={{ color: colorForAgent(detail.agentId) }}>{detail.agentId}</span>
          <span className="mono">#{detail.sessionId}</span>
          <span className="tree-node__meta">{outcomeLabel(detail.outcome, t)}</span>
          <span className="tree-node__meta">{running ? t('session.notEndedSnapshot') : t('session.endedReadonly')}</span>
          <span className="mono">
            {formatClock(detail.startedAt)} → {detail.endedAt ? formatClock(detail.endedAt) : '…'} （{duration}）
          </span>
          {detail.exitCode != null && <span className="tree-node__meta">exit {detail.exitCode}</span>}
          {detail.exitSignal && <span className="tree-node__meta">signal {detail.exitSignal}</span>}
          {detail.exitCause && <span className="tree-node__meta">{detail.exitCause}</span>}
          <span className="modal__spacer" />
          <button aria-label={t('session.closeLabel')} onClick={onClose}>{t('common.close')}</button>
        </div>
        {detail.inputTokens != null && detail.outputTokens != null && (
          <div className="session-detail__usage mono" data-testid="session-usage">
            <span>{t('session.inputTokens', { n: formatNumber(detail.inputTokens, locale) })}</span>
            <span>· {t('session.outputTokens', { n: formatNumber(detail.outputTokens, locale) })}</span>
            {detail.cacheReadTokens != null && (
              <span>· {t('session.cacheReadTokens', { n: formatNumber(detail.cacheReadTokens, locale) })}</span>
            )}
            {detail.cacheWriteTokens != null && (
              <span>· {t('session.cacheWriteTokens', { n: formatNumber(detail.cacheWriteTokens, locale) })}</span>
            )}
            {detail.costUsd != null && <span>· ≈ {formatCostUsd(detail.costUsd)}</span>}
          </div>
        )}
        <div className="modal__body modal__body--session-detail">
          <div className="session-detail__messages" data-testid="session-messages">
            {detail.messages.length === 0 && <p className="placeholder">{t('session.noMessages')}</p>}
            {detail.messages.map((message) => (
              <SessionMessageRow key={message.id} message={message} />
            ))}
          </div>
          <div className="session-detail__side">
            <div className="session-detail__lifecycle" data-testid="session-lifecycle">
              <h3 className="session-detail__heading">{t('session.lifecycle')}</h3>
              {detail.lifecycleEvents.length === 0 && <p className="placeholder">{t('session.noLifecycle')}</p>}
              <ul>
                {detail.lifecycleEvents.map((event) => (
                  <li key={event.id} className="mono">
                    <span className="tree-node__meta">{formatClock(event.createdAt)}</span>
                    {' '}{LIFECYCLE_LABELS[event.kind] ? t(LIFECYCLE_LABELS[event.kind]) : event.kind}
                    {/* native_session_failed 的 attemptId 是失败步骤（locate/archive/analyze），见 01 session_events */}
                    {event.kind === 'native_session_failed' && event.attemptId ? ` · ${event.attemptId}` : ''}
                    {event.detail ? ` · ${event.detail}` : ''}
                  </li>
                ))}
              </ul>
            </div>
            <div className="session-detail__log">
              <SessionLogView log={log} resetKey={`${roomId}:${detail.sessionId}:replay`} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SessionMessageRow({ message }: { message: Message }) {
  const { t } = useI18n();
  const isAgent = message.authorId !== 'human' && message.authorId !== 'system';
  const avatarClass =
    message.authorId === 'human' ? 'message__avatar--human' : message.authorId === 'system' ? 'message__avatar--system' : '';
  return (
    <div className="message" data-message-id={message.id}>
      <div
        className={`message__avatar ${avatarClass}`}
        style={isAgent ? { background: colorForAgent(message.authorId) } : undefined}
      >
        {authorInitial(message.authorId, t)}
      </div>
      <div className="message__main">
        <div className="message__head">
          <span className="message__author" style={isAgent ? { color: colorForAgent(message.authorId) } : undefined}>
            {authorLabel(message.authorId, t)}
          </span>
          {message.type && <MessageTypeBadge type={message.type} />}
          <span className="message__time">{formatClock(message.createdAt)}</span>
        </div>
        <div className="message__content">{message.content}</div>
        {(message.targetMessageId != null || message.referencedMessageIds.length > 0) && (
          <div className="message__refs">
            {message.targetMessageId != null && <span className="ref-chip">↳ #{message.targetMessageId}</span>}
            {message.referencedMessageIds.map((id) => (
              <span key={id} className="ref-chip">{t('messages.reference', { id })}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
