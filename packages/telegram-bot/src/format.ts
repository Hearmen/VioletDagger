import type {
  AgentInfo, MemoryViewPayload, Message, ReportRow, Room, RoomReport, RoomStatus,
  RoomStatusPayload, RoomSummary, UsageSummaryPayload, UsageTotals,
} from './types';

// 输出格式（11-telegram-bot.md §9）。parse_mode 为 HTML，来自编排器的文本一律先转义；
// 标签不跨行使用（<pre> 除外），切分只按行进行。

export const MESSAGE_LIMIT = 4000;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 硬切点不能落在 &amp; 之类的转义实体中间。
function hardCut(line: string, limit: number): string[] {
  const parts: string[] = [];
  let rest = line;
  while (rest.length > limit) {
    let cut = limit;
    const amp = rest.lastIndexOf('&', cut - 1);
    if (amp !== -1 && amp > cut - 8 && rest.indexOf(';', amp) >= cut) cut = amp;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  parts.push(rest);
  return parts;
}

// 按行切分为不超过 limit 的片段；切分落在 <pre> 内时补全首尾标签。
// 超长行硬切出的后续片段与前一片段之间没有换行，拼接时不能补 \n。
export function splitMessage(html: string, limit = MESSAGE_LIMIT): string[] {
  const reserve = '</pre>'.length;
  const pieces = html.split('\n').flatMap((line) => hardCut(line, limit - reserve - '<pre>'.length)
    .map((text, i) => ({ text, sep: i === 0 ? '\n' : '' })));
  const chunks: string[] = [];
  let current: string | null = null;
  let inPre = false;
  let currentStartsInPre = false;

  for (const piece of pieces) {
    const lastOpen = piece.text.lastIndexOf('<pre>');
    const lastClose = piece.text.lastIndexOf('</pre>');
    const inPreAfter: boolean = lastOpen > lastClose ? true : lastClose > lastOpen ? false : inPre;
    const candidate: string = current === null ? piece.text : `${current}${piece.sep}${piece.text}`;
    const prefix = currentStartsInPre ? '<pre>' : '';
    if (current !== null && (prefix + candidate).length + (inPreAfter ? reserve : 0) > limit) {
      chunks.push(prefix + current + (inPre ? '</pre>' : ''));
      currentStartsInPre = inPre;
      current = piece.text;
    } else {
      current = candidate;
    }
    inPre = inPreAfter;
  }
  chunks.push((currentStartsInPre ? '<pre>' : '') + (current ?? ''));
  return chunks;
}

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

// 当天显示 HH:mm，否则 MM-DD HH:mm（本机时区）。
export function formatTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
  return sameDay ? hm : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm}`;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}m ${total % 60}s`;
}

export function authorName(authorId: string): string {
  if (authorId === 'human') return '人类';
  if (authorId === 'system') return '系统';
  return authorId;
}

const ROOM_STATUS_LABEL: Record<RoomStatus, string> = {
  active: '进行中',
  paused_limit: '已暂停（达到 session 上限）',
  paused_manual: '已暂停（手动）',
  completed: '已结束',
};

export function roomStatusLabel(status: RoomStatus): string {
  return ROOM_STATUS_LABEL[status] ?? status;
}

export function roomTag(roomId: number, name: string): string {
  return `<b>[#${roomId} ${escapeHtml(name)}]</b>`;
}

// 消息标签（§7.3）；type 为 null 时返回 null（不显示标签）。
export function messageLabel(m: Message, goalMessageId: number | null): string | null {
  if (m.type === null) return null;
  let label: string;
  switch (m.type) {
    case 'open_question':
      label = m.questionStatus === 'CLOSED'
        ? `open_question/CLOSED·${m.questionCloseReason ?? ''}`
        : 'open_question/OPEN';
      if (m.id === goalMessageId) label += ' 目标';
      break;
    case 'chain':
      label = `chain/${m.chainStatus ?? ''}`;
      if (m.closesQuestion) label += `·closes→${m.chainResolution ?? ''}`;
      break;
    case 'exploring':
      label = `exploring/${m.exploringStatus ?? ''}`;
      break;
    case 'verify':
      label = m.verifyVerdict ? 'verify/通过' : 'verify/不通过';
      break;
    default:
      label = m.type;
  }
  return label;
}

function messageSummary(m: Message): string {
  return m.summary.trim() !== '' ? m.summary : m.content.slice(0, 200);
}

// 一行：#id 作者 [标签] 摘要（摘要压成单行，保证标签不跨行）。
export function messageLine(m: Message, goalMessageId: number | null): string {
  const label = messageLabel(m, goalMessageId);
  const summary = messageSummary(m).replace(/\s*\n\s*/g, ' ');
  return `<b>#${m.id}</b> ${escapeHtml(authorName(m.authorId))}${label ? ` [${escapeHtml(label)}]` : ''} ${escapeHtml(summary)}`;
}

export function formatMessageFull(m: Message, goalMessageId: number | null, now: Date = new Date()): string {
  const label = messageLabel(m, goalMessageId);
  const lines = [
    `<b>#${m.id}</b> ${escapeHtml(authorName(m.authorId))} · ${formatTime(m.createdAt, now)}${m.sessionSeq !== null ? ` · session #${m.sessionSeq}` : ''}`,
  ];
  if (label) lines.push(`类型：${escapeHtml(label)}`);
  if (m.targetMessageId !== null) lines.push(`目标：#${m.targetMessageId}`);
  if (m.referencedMessageIds.length > 0) lines.push(`引用：${m.referencedMessageIds.map((id) => `#${id}`).join(', ')}`);
  if (m.targetAgentId !== null) lines.push(`定向：@${escapeHtml(m.targetAgentId)}`);
  if (m.summary.trim() !== '') lines.push(`摘要：${escapeHtml(m.summary.replace(/\s*\n\s*/g, ' '))}`);
  lines.push('', escapeHtml(m.content));
  return lines.join('\n');
}

export function formatRooms(rooms: RoomSummary[]): { text: string; ordered: RoomSummary[] } {
  const ordered = [...rooms].sort((a, b) => {
    const ac = a.status === 'completed' ? 1 : 0;
    const bc = b.status === 'completed' ? 1 : 0;
    return ac - bc || b.id - a.id;
  });
  if (ordered.length === 0) return { text: '还没有房间，用 /newroom 创建', ordered };
  const lines = ['<b>房间</b>', ...ordered.map((r) => `#${r.id} ${escapeHtml(r.name)} · ${roomStatusLabel(r.status)}`)];
  return { text: lines.join('\n'), ordered };
}

export function formatRoomHeader(room: Room): string {
  return [
    `<b>#${room.id} ${escapeHtml(room.name)}</b>`,
    `状态：${roomStatusLabel(room.status)}`,
    `调度模式：${room.schedulingMode}`,
    `session 上限：${room.maxSessions}`,
    `工作目录：<code>${escapeHtml(room.workdir || '（服务端默认）')}</code>`,
  ].join('\n');
}

export function formatAgents(agents: AgentInfo[]): string {
  if (agents.length === 0) return '注册表中没有 agent';
  return ['<b>agent 注册表</b>', ...agents.map((a) => (a.available
    ? `${escapeHtml(a.agentId)} · 可用`
    : `${escapeHtml(a.agentId)} · 不可用：${escapeHtml(a.unavailableReason ?? '')}`))].join('\n');
}

export function formatStatus(room: Room, status: RoomStatusPayload, now: Date = new Date()): string {
  const lines = [
    `<b>#${room.id} ${escapeHtml(room.name)}</b>`,
    `状态：${roomStatusLabel(status.status)}`,
    `session：${status.currentSessionCount}/${room.maxSessions}`,
    `调度模式：${room.schedulingMode}`,
  ];
  if (room.schedulingMode === 'sequential') {
    lines.push(`下一轮：${status.nextTurnAgentId ? escapeHtml(status.nextTurnAgentId) : '—'}`);
  }
  if (status.dispatchIdle) {
    lines.push(`当前没有任务可派发${status.disabledAgentCount > 0 ? `（${status.disabledAgentCount} 个 agent 已停用派发）` : ''}`);
  }
  lines.push('');
  for (const a of status.agents) {
    const parts = [`<b>${escapeHtml(a.agentId)}</b> ${a.state}`];
    if (a.sessionId !== undefined) parts.push(`session #${a.sessionId}`);
    if (a.sessionStartedAt) parts.push(`已运行 ${formatDuration(now.getTime() - new Date(a.sessionStartedAt).getTime())}`);
    if (a.stopIntent === 'terminate') parts.push('终止中');
    parts.push(a.enabled ? '派发启用' : '派发已停用');
    if (a.failureCount > 0) parts.push(`连续失败 ${a.failureCount}`);
    if (a.stuck) parts.push('⚠ 可能卡住');
    lines.push(parts.join(' · '));
    if (a.activeExploringSummary) lines.push(`  探索：${escapeHtml(a.activeExploringSummary.replace(/\s*\n\s*/g, ' '))}`);
    if (a.exitWarning) lines.push(`  ⚠ ${escapeHtml(a.exitWarning)}`);
  }
  return lines.join('\n');
}

// /memory 类别参数到 MemoryViewPayload 分组的映射（§7.3）。
export const MEMORY_CATEGORIES = {
  questions: 'openQuestions',
  hypotheses: 'hypotheses',
  facts: 'facts',
  boundaries: 'boundaries',
  chains: 'chains',
  exploring: 'exploring',
  proposals: 'completionProposals',
  challenges: 'challenges',
  verifies: 'verifies',
} as const satisfies Record<string, keyof MemoryViewPayload>;

export type MemoryCategory = keyof typeof MEMORY_CATEGORIES;

export function isMemoryCategory(value: string): value is MemoryCategory {
  return Object.prototype.hasOwnProperty.call(MEMORY_CATEGORIES, value);
}

export function formatMemory(view: MemoryViewPayload, category?: MemoryCategory): string {
  if (category) {
    const group = view[MEMORY_CATEGORIES[category]];
    if (group.length === 0) return `${category}：没有条目`;
    return [`<b>${category}</b>（${group.length}）`, ...group.map((m) => messageLine(m, view.goalMessageId))].join('\n');
  }
  const lines = ['<b>记忆</b>'];
  for (const [name, key] of Object.entries(MEMORY_CATEGORIES)) {
    const group = view[key];
    let extra = '';
    if (name === 'questions' && view.goalMessageId !== null) extra = '（其中目标 1）';
    if (name === 'exploring') {
      const active = group.filter((m) => m.exploringStatus === 'active').length;
      extra = `（active ${active} / completed ${group.length - active}）`;
    }
    lines.push(`${name}：${group.length}${extra}`);
  }
  lines.push('', '用 /memory &lt;category&gt; 查看条目');
  return lines.join('\n');
}

function num(n: number): string {
  return n.toLocaleString('en-US');
}

function usageLine(name: string, u: UsageTotals): string {
  const cost = u.costUsd === null ? '无费用数据' : `$${u.costUsd.toFixed(4)}`;
  const missing: string[] = [];
  if (u.sessionsWithoutTokens > 0) missing.push(`缺 token 数据 ${u.sessionsWithoutTokens}`);
  if (u.sessionsWithoutCost > 0) missing.push(`缺费用数据 ${u.sessionsWithoutCost}`);
  return `<b>${escapeHtml(name)}</b>：输入 ${num(u.inputTokens)} / 输出 ${num(u.outputTokens)} / 缓存读 ${num(u.cacheReadTokens)} / 缓存写 ${num(u.cacheWriteTokens)} · ${cost} · session ${u.sessionCount}${missing.length > 0 ? `（${missing.join('，')}）` : ''}`;
}

export function formatUsage(summary: UsageSummaryPayload): string {
  return [
    '<b>用量</b>',
    ...Object.entries(summary.byAgent).map(([agentId, u]) => usageLine(agentId, u)),
    usageLine('房间合计', summary.room),
  ].join('\n');
}

function pct(r: number | null): string {
  return r === null ? '—' : `${(r * 100).toFixed(1)}%`;
}

function orDash(n: number | null, render: (v: number) => string = num): string {
  return n === null ? '—' : render(n);
}

function reportRowLines(title: string, row: ReportRow): string[] {
  const s = row.sessions;
  return [
    `<b>${escapeHtml(title)}</b>`,
    `session ${s.total}（完成 ${s.byOutcome.completed} / 通过 ${s.byOutcome.passed} / 报错 ${s.byOutcome.error} / 终止 ${s.byOutcome.terminated}）· 完成率 ${pct(s.completionRate)} · 错误率 ${pct(s.errorRate)}`,
    `执行时长 ${orDash(row.time.totalExecMs, formatDuration)} · token ${orDash(row.tokens.total)} · 缓存命中率 ${pct(row.tokens.cacheHitRate)}`,
    `步数 ${orDash(row.model.steps)} · 工具调用 ${orDash(row.tools.total)} · 成功率 ${pct(row.tools.successRate)}`,
  ];
}

export function formatReport(report: RoomReport): string {
  const lines = [
    '<b>任务分析报告</b>',
    `已创建 session ${report.room.sessionsCreated}/${report.room.maxSessions}${report.runningSessions > 0 ? `（${report.runningSessions} 个运行中未计入）` : ''}`,
    '',
    ...reportRowLines('房间合计', report.room),
  ];
  for (const row of report.agents) {
    lines.push('', ...reportRowLines(row.agentId ?? '—', row));
  }
  return lines.join('\n');
}
