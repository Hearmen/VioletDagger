import { useEffect, useState } from 'react';
import type { RoomStatusPayload, UsageTotals } from '../api/types';
import { useI18n } from '../i18n/LocaleProvider';
import { colorForAgent, formatCostUsd, formatElapsed, formatTokens, formatUsageParts, totalTokens } from '../utils/format';

// 用量行（07-frontend.md §5）：sessionCount === 0（这个 agent 在本房间还没跑完过一次）时不显示；
// cacheRead/cacheWrite 只放悬浮 title，不占卡片空间；costUsd 为 null 时（如 kimi）不显示 $ 部分；
// 部分 session 有费用、部分没有时加一个 * 提示"未计入"，不让总数看起来比实际更精确。
function AgentUsageLine({ usage }: { usage: UsageTotals }) {
  const { t, locale } = useI18n();
  if (usage.sessionCount === 0) return null;
  const title = formatUsageParts(usage, t, locale).join(' · ');
  return (
    <p className="agent-card__usage mono" title={title}>
      {formatTokens(totalTokens(usage))}
      {usage.costUsd != null && (
        <>
          {' '}· {formatCostUsd(usage.costUsd)}
          {usage.sessionsWithoutCost > 0 && (
            <span title={t('format.sessionsWithoutCost', { count: usage.sessionsWithoutCost })}>*</span>
          )}
        </>
      )}
    </p>
  );
}

export function AgentRail(props: {
  agents: RoomStatusPayload['agents'];
  usageByAgent?: Record<string, UsageTotals>;
  onTerminate: (sessionId: number) => void;
  onOpenSession: (sessionId: number) => void;
  onSetAgentEnabled: (agentId: string, enabled: boolean) => void;
}) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="agent-rail">
      {props.agents.length === 0 && <p className="placeholder">{t('agentRail.empty')}</p>}
      {props.agents.map((agent) => {
        const active = agent.state === 'running' || agent.state === 'stopping';
        const enabled = agent.enabled !== false;
        return (
          <div
            key={agent.agentId}
            data-testid={`agent-${agent.agentId}`}
            className={`agent-card ${agent.stuck ? 'agent-card--stuck' : ''} ${enabled ? '' : 'agent-card--disabled'}`}
            style={{ ['--agent-color' as string]: colorForAgent(agent.agentId) }}
          >
            <div className="agent-card__top">
              <span className={`agent-card__dot ${agent.state === 'idle' ? 'agent-card__dot--idle' : ''}`} />
              <span className="agent-card__name">{agent.agentId}</span>
              <span className="agent-card__state">{agent.state}</span>
              {agent.stuck && (
                <span className="stuck-flag" title={t('agentRail.stuck')}>⚠</span>
              )}
            </div>

            <div className="agent-card__meta">
              {active && agent.sessionId != null && (
                <button className="session-link" onClick={() => props.onOpenSession(agent.sessionId!)}>
                  session #{agent.sessionId}
                </button>
              )}
              {active && agent.sessionStartedAt && (
                <span className="mono">{t('agentRail.elapsed', { elapsed: formatElapsed(agent.sessionStartedAt, now) })}</span>
              )}
            </div>

            {!enabled && (
              <p className="agent-card__disabled">
                {t('agentRail.disabled')}
                {(agent.failureCount ?? 0) > 0 ? t('agentRail.failureCount', { count: agent.failureCount ?? 0 }) : ''}
              </p>
            )}

            {agent.activeExploringSummary && (
              <p className="agent-card__exploring" title={agent.activeExploringSummary}>
                {t('agentRail.exploring', { summary: agent.activeExploringSummary })}
              </p>
            )}

            {props.usageByAgent?.[agent.agentId] && <AgentUsageLine usage={props.usageByAgent[agent.agentId]} />}

            <div className="agent-card__actions">
              {active && agent.sessionId != null && (
                <button className="danger" onClick={() => props.onTerminate(agent.sessionId!)}>
                  {t('agentRail.terminate')}
                </button>
              )}
              <button
                className={enabled ? 'ghost' : 'primary'}
                onClick={() => props.onSetAgentEnabled(agent.agentId, !enabled)}
              >
                {enabled ? t('agentRail.disable') : t('agentRail.enable')}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
