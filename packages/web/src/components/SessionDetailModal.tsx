import { useEffect } from 'react';
import type { Message, SessionDetailPayload, SessionEventKind } from '../api/types';
import { useSessionLog } from '../hooks/useSessionLog';
import { authorInitial, authorLabel, colorForAgent, formatClock, formatDuration } from '../utils/format';
import { MessageTypeBadge } from './MessageTypeBadge';
import { SessionLogView } from './SessionLogView';

const OUTCOME_LABELS: Record<SessionDetailPayload['outcome'], string> = {
  running: '运行中',
  stopping: 'stopping',
  completed: 'completed',
  passed: 'passed',
  error: 'error',
  terminated: 'terminated',
};

const LIFECYCLE_LABELS: Record<SessionEventKind, string> = {
  cleanup_started: '开始清理',
  sigterm_sent: '发送 SIGTERM',
  sigkill_sent: '发送 SIGKILL',
  cleanup_failed: '清理失败',
  terminate_requested: '请求人工终止',
  process_exited: '进程退出',
  terminated: '确认终止',
};

// 复盘入口（事件树 session 节点）：元数据 + 该 session 的消息列表 + 生命周期记录 + 只读日志回放。
// 交互入口是 LiveSessionModal（AgentRail），两者内容刻意不同（见 docs/design/07-frontend.md §10.2）。
export function SessionDetailModal(props: {
  roomId: number;
  detail: SessionDetailPayload | null;
  onClose: () => void;
}) {
  const { detail, roomId, onClose } = props;
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
      : '运行中';

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal modal--session-detail"
        role="dialog"
        aria-modal="true"
        aria-label="session detail"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal__head">
          <span className="mono" style={{ color: colorForAgent(detail.agentId) }}>{detail.agentId}</span>
          <span className="mono">#{detail.sessionId}</span>
          <span className="tree-node__meta">{OUTCOME_LABELS[detail.outcome]}</span>
          <span className="tree-node__meta">{running ? '尚未结束 · 日志快照' : '已结束 · 只读'}</span>
          <span className="mono">
            {formatClock(detail.startedAt)} → {detail.endedAt ? formatClock(detail.endedAt) : '…'} （{duration}）
          </span>
          {detail.exitCode != null && <span className="tree-node__meta">exit {detail.exitCode}</span>}
          {detail.exitSignal && <span className="tree-node__meta">signal {detail.exitSignal}</span>}
          {detail.exitCause && <span className="tree-node__meta">{detail.exitCause}</span>}
          <span className="modal__spacer" />
          <button aria-label="Close" onClick={onClose}>关闭</button>
        </div>
        <div className="modal__body modal__body--session-detail">
          <div className="session-detail__messages" data-testid="session-messages">
            {detail.messages.length === 0 && <p className="placeholder">这次 session 没有产出消息</p>}
            {detail.messages.map((message) => (
              <SessionMessageRow key={message.id} message={message} />
            ))}
          </div>
          <div className="session-detail__side">
            <div className="session-detail__lifecycle" data-testid="session-lifecycle">
              <h3 className="session-detail__heading">生命周期</h3>
              {detail.lifecycleEvents.length === 0 && <p className="placeholder">无生命周期事件</p>}
              <ul>
                {detail.lifecycleEvents.map((event) => (
                  <li key={event.id} className="mono">
                    <span className="tree-node__meta">{formatClock(event.createdAt)}</span>
                    {' '}{LIFECYCLE_LABELS[event.kind] ?? event.kind}
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
  const isAgent = message.authorId !== 'human' && message.authorId !== 'system';
  const avatarClass =
    message.authorId === 'human' ? 'message__avatar--human' : message.authorId === 'system' ? 'message__avatar--system' : '';
  return (
    <div className="message" data-message-id={message.id}>
      <div
        className={`message__avatar ${avatarClass}`}
        style={isAgent ? { background: colorForAgent(message.authorId) } : undefined}
      >
        {authorInitial(message.authorId)}
      </div>
      <div className="message__main">
        <div className="message__head">
          <span className="message__author" style={isAgent ? { color: colorForAgent(message.authorId) } : undefined}>
            {authorLabel(message.authorId)}
          </span>
          {message.type && <MessageTypeBadge type={message.type} />}
          <span className="message__time">{formatClock(message.createdAt)}</span>
        </div>
        <div className="message__content">{message.content}</div>
        {(message.targetMessageId != null || message.referencedMessageIds.length > 0) && (
          <div className="message__refs">
            {message.targetMessageId != null && <span className="ref-chip">↳ #{message.targetMessageId}</span>}
            {message.referencedMessageIds.map((id) => (
              <span key={id} className="ref-chip">引用 #{id}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
