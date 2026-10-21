import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { DurationStats, ReportRow, RoomReport, ToolNameCount } from '../api/types';
import { useI18n } from '../i18n/LocaleProvider';
import { errorText, renderText, type LocalizedText } from '../i18n/types';
import type { MessageKey } from '../i18n/zh';
import type { TFunction } from '../i18n/translate';
import type { Locale } from '../i18n/types';
import { colorForAgent, formatClock, formatDuration, formatNumber, formatPercent, formatTokens } from '../utils/format';

// 任务分析报告弹窗（07-frontend.md §10.3）：打开即请求一次，报告是快照，只有 Regenerate 才重新请求。

type TabId = 'sessions' | 'time' | 'tokens' | 'model' | 'tools';

const TABS: { id: TabId; label: MessageKey }[] = [
  { id: 'sessions', label: 'report.tabSessions' },
  { id: 'time', label: 'report.tabTime' },
  { id: 'tokens', label: 'report.tabTokens' },
  { id: 'model', label: 'report.tabModel' },
  { id: 'tools', label: 'report.tabTools' },
];

interface Fmt {
  t: TFunction;
  locale: Locale;
}

// 任何 null 显示 —，悬浮"无数据"：表格单元格必须占位，否则列会错位。
function Value({ value, t }: { value: string | null; t: TFunction }) {
  if (value == null) return <span className="report__null" title={t('report.noData')}>—</span>;
  return <>{value}</>;
}

const num = (n: number | null, { locale }: Fmt) => (n == null ? null : formatNumber(n, locale));
const tok = (n: number | null) => (n == null ? null : formatTokens(n));
const pct = (r: number | null, { locale }: Fmt) => (r == null ? null : formatPercent(r, locale));
const dur = (ms: number | null) => (ms == null ? null : formatDuration(ms / 1000));
const dec1 = (n: number | null, { locale }: Fmt) =>
  n == null ? null : n.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const maxWithSeq = (stats: DurationStats) => (stats.max == null ? null : `${formatDuration(stats.max / 1000)} #${stats.maxSeq}`);

interface Column {
  label: MessageKey;
  cell: (row: ReportRow, fmt: Fmt) => string | null;
}

const COLUMNS: Record<TabId, Column[]> = {
  sessions: [
    { label: 'report.colSessions', cell: (r, f) => num(r.sessions.total, f) },
    { label: 'report.colCompleted', cell: (r, f) => num(r.sessions.byOutcome.completed, f) },
    { label: 'report.colPassed', cell: (r, f) => num(r.sessions.byOutcome.passed, f) },
    { label: 'report.colError', cell: (r, f) => num(r.sessions.byOutcome.error, f) },
    { label: 'report.colTerminated', cell: (r, f) => num(r.sessions.byOutcome.terminated, f) },
    { label: 'report.colCompletionRate', cell: (r, f) => pct(r.sessions.completionRate, f) },
    { label: 'report.colPassRate', cell: (r, f) => pct(r.sessions.passRate, f) },
    { label: 'report.colErrorRate', cell: (r, f) => pct(r.sessions.errorRate, f) },
    { label: 'report.colRoomFlag', cell: (r, f) => num(r.sessions.byTrigger.room_flag, f) },
    { label: 'report.colDirectedFlag', cell: (r, f) => num(r.sessions.byTrigger.directed_flag, f) },
    { label: 'report.colContinuation', cell: (r, f) => num(r.sessions.byTrigger.continuation, f) },
    { label: 'report.colTurn', cell: (r, f) => num(r.sessions.byTrigger.turn, f) },
    { label: 'report.colUnknown', cell: (r, f) => num(r.sessions.byTrigger.unknown, f) },
  ],
  time: [
    { label: 'report.colTotalExec', cell: (r) => dur(r.time.totalExecMs) },
    { label: 'report.colMean', cell: (r) => dur(r.time.exec.mean) },
    { label: 'report.colMedian', cell: (r) => dur(r.time.exec.median) },
    { label: 'report.colP90', cell: (r) => dur(r.time.exec.p90) },
    { label: 'report.colMax', cell: (r) => maxWithSeq(r.time.exec) },
  ],
  tokens: [
    { label: 'report.colInput', cell: (r) => tok(r.tokens.input) },
    { label: 'report.colOutput', cell: (r) => tok(r.tokens.output) },
    { label: 'report.colCacheRead', cell: (r) => tok(r.tokens.cacheRead) },
    { label: 'report.colCacheWrite', cell: (r) => tok(r.tokens.cacheWrite) },
    { label: 'report.colTotal', cell: (r) => tok(r.tokens.total) },
    { label: 'report.colShare', cell: (r, f) => pct(r.tokens.shareOfRoom, f) },
    { label: 'report.colCacheHitRate', cell: (r, f) => pct(r.tokens.cacheHitRate, f) },
    { label: 'report.colPerSession', cell: (r) => tok(r.tokens.perSession == null ? null : Math.round(r.tokens.perSession)) },
    { label: 'report.colPerCompleted', cell: (r) => tok(r.tokens.perCompletedSession == null ? null : Math.round(r.tokens.perCompletedSession)) },
    { label: 'report.colPerStep', cell: (r) => tok(r.tokens.perStep == null ? null : Math.round(r.tokens.perStep)) },
    { label: 'report.colOutputRate', cell: (r, f) => dec1(r.tokens.outputPerSecond, f) },
  ],
  model: [
    { label: 'report.colSteps', cell: (r, f) => num(r.model.steps, f) },
    { label: 'report.colStepsPerSession', cell: (r, f) => dec1(r.model.stepsPerSession, f) },
    { label: 'report.colFirstResponseMean', cell: (r) => dur(r.model.firstResponse.mean) },
    { label: 'report.colFirstResponseMedian', cell: (r) => dur(r.model.firstResponse.median) },
  ],
  tools: [
    { label: 'report.colToolCalls', cell: (r, f) => num(r.tools.total, f) },
    { label: 'report.colPerSession', cell: (r, f) => dec1(r.tools.perSession, f) },
    { label: 'report.colPerStep', cell: (r, f) => dec1(r.tools.perStep, f) },
    { label: 'report.colFailed', cell: (r, f) => num(r.tools.failed, f) },
    { label: 'report.colSuccessRate', cell: (r, f) => pct(r.tools.successRate, f) },
    { label: 'report.colUnknownOutcome', cell: (r, f) => num(r.tools.unknownOutcomeCalls, f) },
  ],
};

// 各标签页底部的缺失数据脚注：取各 agent 行的 missingSessions（合计行不重复列出）。
const MISSING: Record<TabId, { count: (row: ReportRow) => number; note: MessageKey }[]> = {
  sessions: [],
  time: [],
  tokens: [{ count: (r) => r.tokens.missingSessions, note: 'report.missingTokensNote' }],
  model: [
    { count: (r) => r.model.missingSessions, note: 'report.missingStepsNote' },
    { count: (r) => r.model.firstResponse.missingSessions, note: 'report.missingFirstResponseNote' },
  ],
  tools: [{ count: (r) => r.tools.missingSessions, note: 'report.missingToolsNote' }],
};

export function RoomReportModal(props: {
  load: () => Promise<RoomReport>;
  roomCompleted: boolean; // 房间未结束时房间总时长卡片注明"进行中"
  onClose: () => void;
}) {
  const { load, roomCompleted, onClose } = props;
  const { t, locale } = useI18n();
  const [report, setReport] = useState<RoomReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LocalizedText | null>(null);
  const [tab, setTab] = useState<TabId>('tokens');
  const [scope, setScope] = useState<string>('');

  const generate = useCallback(() => {
    setLoading(true);
    setError(null);
    load()
      .then((next) => setReport(next))
      .catch((err) => setError(errorText(err)))
      .finally(() => setLoading(false));
  }, [load]);

  useEffect(() => {
    generate();
    // 只在打开时请求一次；之后只有 Regenerate 才重新请求。
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const fmt: Fmt = { t, locale };
  let body: ReactNode;
  if (loading && !report) {
    body = <p className="placeholder">{t('report.generating')}</p>;
  } else if (error) {
    body = (
      <div role="alert" className="report__error">
        <span>{renderText(error, t)}</span>
        <button onClick={generate}>{t('report.retry')}</button>
      </div>
    );
  } else if (report) {
    body = <ReportBody report={report} roomCompleted={roomCompleted} fmt={fmt} tab={tab} onTab={setTab} scope={scope} onScope={setScope} />;
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal modal--report"
        role="dialog"
        aria-modal="true"
        aria-label={t('report.label')}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal__head">
          <span className="modal__title">{t('report.title')}</span>
          {report && <span className="tree-node__meta">{t('report.generatedAt', { time: formatClock(report.generatedAt) })}</span>}
          {report && report.runningSessions > 0 && (
            <span className="report__muted">{t('report.runningExcluded', { count: report.runningSessions })}</span>
          )}
          <span className="modal__spacer" />
          <button onClick={generate} disabled={loading}>{t('report.regenerate')}</button>
          <button onClick={onClose}>{t('common.close')}</button>
        </div>
        <div className="modal__body report">{body}</div>
      </div>
    </div>
  );
}

function ReportBody(props: {
  report: RoomReport;
  roomCompleted: boolean;
  fmt: Fmt;
  tab: TabId;
  onTab: (tab: TabId) => void;
  scope: string;
  onScope: (scope: string) => void;
}) {
  const { report, fmt, tab, scope } = props;
  const { t } = fmt;
  const room = report.room;

  const cards: { label: MessageKey; value: string | null; note?: string }[] = [
    {
      label: 'report.cardTotalTokens',
      value: tok(room.tokens.total),
      note: room.tokens.missingSessions > 0 ? t('report.missingTokens', { count: room.tokens.missingSessions }) : undefined,
    },
    { label: 'report.cardRoomDuration', value: dur(room.roomDurationMs), note: props.roomCompleted ? undefined : t('report.roomInProgress') },
    {
      label: 'report.cardCompletionRate',
      value: pct(room.sessions.completionRate, fmt),
      note: `${num(room.sessions.byOutcome.completed, fmt)} / ${num(room.sessions.total, fmt)}`,
    },
    { label: 'report.cardCacheHitRate', value: pct(room.tokens.cacheHitRate, fmt) },
    { label: 'report.cardToolCalls', value: num(room.tools.total, fmt) },
    {
      label: 'report.cardToolSuccessRate',
      value: pct(room.tools.successRate, fmt),
      note: room.tools.unknownOutcomeCalls > 0 ? t('report.unknownOutcomeCalls', { count: room.tools.unknownOutcomeCalls }) : undefined,
    },
  ];

  const columns = COLUMNS[tab];
  const notes = MISSING[tab].flatMap(({ count, note }) =>
    report.agents
      .filter((row) => count(row) > 0)
      .map((row) => t(note, { agentId: row.agentId ?? '', count: count(row) })),
  );
  const toolRows: ToolNameCount[] = scope ? report.toolNames.byAgent[scope] ?? [] : report.toolNames.room;

  return (
    <>
      <div className="report__cards">
        {cards.map((card) => (
          <div key={card.label} className="report__card" data-testid={`card-${card.label}`}>
            <span className="report__card-label">{t(card.label)}</span>
            <span className="report__card-value mono"><Value value={card.value} t={t} /></span>
            {card.note && <span className="report__muted">{card.note}</span>}
          </div>
        ))}
      </div>
      <p className="report__muted mono">
        {t('report.sessionUsage', {
          created: num(room.sessionsCreated, fmt) ?? '',
          max: num(room.maxSessions, fmt) ?? '',
          rate: pct(room.sessionUsageRate, fmt) ?? '—',
        })}
      </p>

      <div className="report__tabs" role="tablist">
        {TABS.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={tab === item.id}
            className={`report__tab ${tab === item.id ? 'report__tab--active' : ''}`}
            onClick={() => props.onTab(item.id)}
          >
            {t(item.label)}
          </button>
        ))}
      </div>
      <div className="report__table-wrap">
        <table className="report__table">
          <thead>
            <tr>
              <th>{t('report.agent')}</th>
              {columns.map((column) => <th key={column.label}>{t(column.label)}</th>)}
            </tr>
          </thead>
          <tbody>
            {report.agents.map((row) => (
              <tr key={row.agentId}>
                <td>
                  <span className="report__swatch" style={{ background: colorForAgent(row.agentId ?? '') }} />
                  <span className="mono">{row.agentId}</span>
                </td>
                {columns.map((column) => (
                  <td key={column.label} className="mono"><Value value={column.cell(row, fmt)} t={t} /></td>
                ))}
              </tr>
            ))}
            <tr className="report__total-row">
              <td>{t('report.total')}</td>
              {columns.map((column) => (
                <td key={column.label} className="mono"><Value value={column.cell(room, fmt)} t={t} /></td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      {notes.length > 0 && (
        <ul className="report__notes" data-testid="report-notes">
          {notes.map((note) => <li key={note} className="report__muted">{note}</li>)}
        </ul>
      )}

      <div className="report__tools-head">
        <h3 className="session-detail__heading">{t('report.toolNames')}</h3>
        <label className="report__muted">
          {t('report.scope')}{' '}
          <select aria-label={t('report.scope')} value={scope} onChange={(event) => props.onScope(event.target.value)}>
            <option value="">{t('report.scopeRoom')}</option>
            {report.agents.map((row) => <option key={row.agentId} value={row.agentId ?? ''}>{row.agentId}</option>)}
          </select>
        </label>
      </div>
      {toolRows.length === 0 ? (
        <p className="placeholder">{t('report.noTools')}</p>
      ) : (
        <table className="report__table" data-testid="tool-names">
          <thead>
            <tr>
              <th>{t('report.colToolName')}</th>
              <th>{t('report.colCount')}</th>
              <th>{t('report.colFailedCount')}</th>
            </tr>
          </thead>
          <tbody>
            {toolRows.map((row) => (
              <tr key={`${row.isRoomMcp}:${row.name}`}>
                <td className="mono">
                  {row.name}
                  {row.isRoomMcp && <span className="report__mcp-badge">MCP</span>}
                </td>
                <td className="mono">{formatNumber(row.count, fmt.locale)}</td>
                <td className="mono"><Value value={num(row.failed, fmt)} t={t} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
