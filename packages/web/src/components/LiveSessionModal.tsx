import { useEffect, useState } from 'react';
import type { SessionExitCause, SessionOutcome } from '../api/types';
import { useI18n } from '../i18n/LocaleProvider';
import { errorText, renderText, type LocalizedText } from '../i18n/types';
import { useSessionLog } from '../hooks/useSessionLog';
import { colorForAgent, formatElapsed, outcomeLabel } from '../utils/format';
import { SessionLogView } from './SessionLogView';

export interface LiveSessionTarget {
  roomId: number;
  sessionId: number;
  agentId: string;
  startedAt?: string;
}

export interface LiveSessionSnapshot {
  outcome: SessionOutcome;
  endedAt: string | null;
  exitCode: number | null;
  exitCause: SessionExitCause | null;
  exitWarning?: string;
}

// AgentRail 入口：固定目标的实时只读日志（08）。无终端输入/resize，关闭仅释放日志订阅。
export function LiveSessionModal(props: {
  target: LiveSessionTarget;
  snapshot: LiveSessionSnapshot | null;
  roomConnected: boolean;
  onTerminate: (sessionId: number) => Promise<void>;
  onClose: () => void;
}) {
  const { target, snapshot, roomConnected, onTerminate, onClose } = props;
  const { t } = useI18n();
  const log = useSessionLog(target.roomId, target.sessionId, 'live');
  const [now, setNow] = useState(() => Date.now());
  const [pending, setPending] = useState(false);
  const [terminateError, setTerminateError] = useState<LocalizedText | null>(null);

  const frozen = snapshot?.endedAt != null || snapshot?.outcome === 'terminated'
    || snapshot?.outcome === 'completed' || snapshot?.outcome === 'passed' || snapshot?.outcome === 'error';

  useEffect(() => {
    setNow(Date.now());
    setPending(false);
    setTerminateError(null);
  }, [target.roomId, target.sessionId]);

  useEffect(() => {
    if (frozen) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [frozen]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const canTerminate = roomConnected && !pending
    && (snapshot?.outcome === 'running' || snapshot?.outcome === 'stopping');

  async function handleTerminate() {
    setPending(true);
    setTerminateError(null);
    try {
      await onTerminate(target.sessionId);
    } catch (err) {
      setTerminateError(err instanceof Error ? errorText(err) : { kind: 'key', key: 'session.terminateFailed' });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal modal--session-log"
        role="dialog"
        aria-modal="true"
        aria-label={t('session.liveLogLabel')}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal__head">
          <span className="mono" style={{ color: colorForAgent(target.agentId) }}>{target.agentId}</span>
          <span className="mono">#{target.sessionId}</span>
          <span className="tree-node__meta">{snapshot ? outcomeLabel(snapshot.outcome, t) : '…'}</span>
          <span className="tree-node__meta">
            {log.source === 'live' ? t('session.sourceLive') : log.source === 'snapshot' ? t('session.sourceSnapshot') : t('session.sourceConnecting')}
          </span>
          {target.startedAt && (
            <span className="mono">
              {t('agentRail.elapsed', {
                elapsed: formatElapsed(target.startedAt, frozen && snapshot?.endedAt ? new Date(snapshot.endedAt).getTime() : now),
              })}
            </span>
          )}
          {snapshot?.exitCode != null && <span className="tree-node__meta">exit {snapshot.exitCode}</span>}
          <span className="modal__spacer" />
          <button
            className="danger"
            disabled={!canTerminate}
            onClick={() => void handleTerminate()}
          >
            {t('agentRail.terminate')}
          </button>
          <button aria-label={t('session.closeLabel')} onClick={onClose}>{t('common.close')}</button>
        </div>
        <div className="modal__body modal__body--session-log">
          {snapshot?.exitWarning && <p role="alert" className="session-log__notice">{snapshot.exitWarning}</p>}
          {!roomConnected && <p role="alert" className="session-log__notice">{t('session.roomDisconnected')}</p>}
          {terminateError && <p role="alert" className="session-log__notice">{renderText(terminateError, t)}</p>}
          <SessionLogView
            log={log}
            resetKey={`${target.roomId}:${target.sessionId}:live`}
          />
        </div>
      </div>
    </div>
  );
}
