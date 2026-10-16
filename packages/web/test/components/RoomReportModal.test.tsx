import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

const ready = () => screen.findByTestId('card-report.cardTotalTokens');
import { RoomReportModal } from '../../src/components/RoomReportModal';
import type { ReportRow, RoomReport } from '../../src/api/types';

// 任务分析报告弹窗（07-frontend.md §10.3）。

function row(agentId: string | null, overrides: Partial<ReportRow> = {}): ReportRow {
  return {
    agentId, registryKey: agentId,
    sessions: {
      total: 4, byOutcome: { completed: 3, passed: 1, error: 0, terminated: 0 },
      completionRate: 0.75, passRate: 0.25, errorRate: 0,
      byTrigger: { room_flag: 2, directed_flag: 1, continuation: 1, unknown: 0 },
    },
    time: { totalExecMs: 120_000, exec: { mean: 30_000, median: 30_000, p90: 40_000, max: 40_000, maxSeq: 7 } },
    tokens: {
      input: 1000, output: 500, cacheRead: 2000, cacheWrite: null, total: 3500,
      shareOfRoom: agentId ? 0.5 : null, cacheHitRate: 0.6667, perSession: 875, perCompletedSession: 1166.7,
      perStep: 100, outputPerSecond: 4.17, missingSessions: 0,
    },
    model: { steps: 35, stepsPerSession: 8.75, firstResponse: { mean: 2000, median: 1500, missingSessions: 0 }, missingSessions: 0 },
    tools: { total: 20, perSession: 5, perStep: 0.57, failed: 1, successRate: 0.9444, unknownOutcomeCalls: 2, missingSessions: 0 },
    ...overrides,
  };
}

function report(overrides: Partial<RoomReport> = {}): RoomReport {
  return {
    roomId: 1,
    generatedAt: '2026-10-13T08:00:00.000Z',
    runningSessions: 1,
    room: { ...row(null), maxSessions: 20, sessionsCreated: 9, sessionUsageRate: 0.45, roomDurationMs: 3_600_000 },
    agents: [
      row('codex', { model: { steps: null, stepsPerSession: null, firstResponse: { mean: null, median: null, missingSessions: 2 }, missingSessions: 2 } }),
      row('kimi'),
    ],
    toolNames: {
      room: [
        { name: 'post_message', isRoomMcp: true, count: 12, failed: 1 },
        { name: 'Bash', isRoomMcp: false, count: 8, failed: null },
      ],
      byAgent: { codex: [{ name: 'CommandExecution', isRoomMcp: false, count: 3, failed: 0 }], kimi: [] },
    },
    ...overrides,
  };
}

function renderModal(load: () => Promise<RoomReport>, roomCompleted = false) {
  const onClose = vi.fn();
  render(<RoomReportModal load={load} roomCompleted={roomCompleted} onClose={onClose} />);
  return { onClose };
}

describe('RoomReportModal', () => {
  it('requests once on open, shows loading, then the key cards and session usage', async () => {
    const load = vi.fn().mockResolvedValue(report());
    renderModal(load);
    expect(screen.getByText('正在生成报告…')).toBeInTheDocument();
    expect(await ready()).toHaveTextContent('3.5k tok');
    expect(load).toHaveBeenCalledTimes(1);
    expect(screen.getByText('1 个运行中的 session 未计入')).toBeInTheDocument();
    expect(screen.getByText('进行中')).toBeInTheDocument();
    expect(screen.getByText('2 次调用成败未知')).toBeInTheDocument();
    expect(screen.getByText('已用 9 / 20（45.0%）')).toBeInTheDocument();
  });

  it('regenerates on demand', async () => {
    const load = vi.fn().mockResolvedValue(report());
    renderModal(load);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('shows the error with a retry button without closing', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('room not found')).mockResolvedValueOnce(report());
    const { onClose } = renderModal(load);
    expect(await screen.findByRole('alert')).toHaveTextContent('room not found');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await ready()).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('defaults to the Token tab with agent rows and a bold total row, and switches tabs', async () => {
    renderModal(vi.fn().mockResolvedValue(report()), true);
    await ready();
    expect(screen.getByRole('tab', { name: 'Token' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('columnheader', { name: '缓存命中率' })).toBeInTheDocument();
    const total = screen.getByText('合计').closest('tr')!;
    expect(total).toHaveClass('report__total-row');
    expect(screen.queryByText('进行中')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: '时间' }));
    expect(screen.getByRole('columnheader', { name: 'P90' })).toBeInTheDocument();
    expect(within(total).getAllByText('00:40 #7').length).toBeGreaterThan(0);
  });

  it('renders null values as — with a "no data" title and lists missing-data footnotes', async () => {
    renderModal(vi.fn().mockResolvedValue(report()));
    await ready();
    fireEvent.click(screen.getByRole('tab', { name: '模型' }));
    const codexRow = screen.getAllByText('codex')[0].closest('tr')!;
    const dashes = within(codexRow).getAllByText('—');
    expect(dashes.length).toBe(4);
    expect(dashes[0]).toHaveAttribute('title', '无数据');
    const notes = screen.getByTestId('report-notes');
    expect(notes).toHaveTextContent('codex：2 个 session 缺步数数据');
    expect(notes).toHaveTextContent('codex：2 个 session 缺首次响应数据');
  });

  it('switches the tool-name scope between room and agents', async () => {
    renderModal(vi.fn().mockResolvedValue(report()));
    await ready();
    const tools = screen.getByTestId('tool-names');
    expect(within(tools).getByText('post_message')).toBeInTheDocument();
    expect(within(tools).getByText('MCP')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('范围'), { target: { value: 'codex' } });
    expect(screen.getByText('CommandExecution')).toBeInTheDocument();
    expect(screen.queryByText('post_message')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('范围'), { target: { value: 'kimi' } });
    expect(screen.getByText('没有工具调用数据')).toBeInTheDocument();
  });
});
