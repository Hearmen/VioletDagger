import type { EventTreePayload, MessageType, UsageTotals } from '../api/types';
import type { TFunction } from '../i18n/translate';
import type { Locale } from '../i18n/types';

type SessionMeta = EventTreePayload['sessions'][number];

const AGENT_COLORS: Record<string, string> = {};

export function colorForAgent(agentId: string): string {
  const cached = AGENT_COLORS[agentId];
  if (cached) return cached;
  let hash = 0;
  for (let i = 0; i < agentId.length; i += 1) {
    hash = (hash * 31 + agentId.charCodeAt(i)) % 360;
  }
  const color = `hsl(${hash} 65% 62%)`;
  AGENT_COLORS[agentId] = color;
  return color;
}

export function authorLabel(authorId: string, t: TFunction): string {
  if (authorId === 'human') return t('format.authorHuman');
  if (authorId === 'system') return t('format.authorSystem');
  return authorId;
}

export function authorInitial(authorId: string, t: TFunction): string {
  if (authorId === 'human') return t('format.initialHuman');
  if (authorId === 'system') return t('format.initialSystem');
  return authorId.slice(0, 1).toUpperCase();
}

function parse(iso: string): Date | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function formatClock(iso: string): string {
  const date = parse(iso);
  if (!date) return '';
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function formatDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function formatElapsed(fromIso: string, now: number): string {
  const date = parse(fromIso);
  if (!date) return '00:00';
  return formatDuration((now - date.getTime()) / 1000);
}

export function formatRelative(iso: string, t: TFunction): string {
  const date = parse(iso);
  if (!date) return '';
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return t('format.justNow');
  if (seconds < 3600) return t('format.minutesAgo', { n: Math.floor(seconds / 60) });
  if (seconds < 86400) return t('format.hoursAgo', { n: Math.floor(seconds / 3600) });
  return t('format.daysAgo', { n: Math.floor(seconds / 86400) });
}

// 类型徽标文案：只有 propose_completion 是界面文案，其余就是协议标识符本身（09-frontend-i18n.md §5.2）。
export function typeLabel(type: MessageType, t: TFunction): string {
  return type === 'propose_completion' ? t('format.typeProposeCompletion') : type;
}

export function formatNumber(n: number, locale: Locale): string {
  return n.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US');
}

// RoomHeader 与 AgentRail 共用的用量明细（悬浮 title）：缓存项 > 0 才出现。
export function formatUsageParts(usage: UsageTotals, t: TFunction, locale: Locale): string[] {
  const parts = [
    t('format.usageInput', { n: formatNumber(usage.inputTokens, locale) }),
    t('format.usageOutput', { n: formatNumber(usage.outputTokens, locale) }),
  ];
  if (usage.cacheReadTokens > 0) parts.push(t('format.usageCacheRead', { n: formatNumber(usage.cacheReadTokens, locale) }));
  if (usage.cacheWriteTokens > 0) parts.push(t('format.usageCacheWrite', { n: formatNumber(usage.cacheWriteTokens, locale) }));
  return parts;
}

// 当前属于触发型的人类新消息类型（03-orchestrator-core.md §1.1）：新写入的 open_question 为 OPEN、
// chain 为 CANDIDATE，所以只看 type 即可。供 Composer 提示"这条消息不会唤醒 @agentId"。
export function isTriggeringNewMessageType(type: MessageType | '' | undefined): boolean {
  return type === 'open_question' || type === 'hypothesis' || type === 'chain' || type === 'challenge';
}

export function truncate(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// 用量展示（07-frontend.md §9/§5/§4）：调用方负责在 token/costUsd 为 null 时完全不渲染，
// 这两个函数只管把已知的数字格式化成紧凑文案，不处理"没有数据"的情况。
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m tok`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k tok`;
  return `${n} tok`;
}

export function formatCostUsd(n: number): string {
  if (n === 0) return '$0';
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

// session 结果未揭晓（running/stopping）时标签只显示 agentId #seq；到达终态后追加结果
// （见需求 3.5、07-frontend.md §9.2）。展示文案与底层 outcome 值不是同一个词：'completed' 显示为
// 'done'，避免和房间级 status === 'completed'（房间头部状态徽标、房间列表卡片）撞语义。
export const OUTCOME_LABELS: Partial<Record<SessionMeta['outcome'], string>> = {
  completed: 'done',
};

// 运行时长后缀（07-frontend.md §9.2）：只对已结束（endedAt 非 null）的 session 显示 endedAt − startedAt；
// 任一时间戳无法解析时不追加。running 的实时时长只在 AgentRail 展示。
// session outcome 展示：只有 running 是界面文案，其余原样显示 outcome 值（09-frontend-i18n.md §5.3）。
export function outcomeLabel(outcome: SessionMeta['outcome'], t: TFunction): string {
  return outcome === 'running' ? t('session.outcomeRunning') : outcome;
}

function sessionDuration(meta: SessionMeta): string | null {
  if (meta.endedAt == null) return null;
  const start = Date.parse(meta.startedAt);
  const end = Date.parse(meta.endedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return formatDuration((end - start) / 1000);
}

// 用量后缀（07-frontend.md §9.2）：时间线页的 session 标签与 Session 页的列头（§9.3）共用本函数。
// inputTokens/outputTokens 都非 null 才追加，只要有一个是 null
// （如 kimi）就什么都不追加，不摆占位符；费用不放进这个标签，太挤，见 SessionDetailModal。
export function sessionTagLabel(meta: SessionMeta | undefined, agentId: string, seq: number): string {
  const base = `${agentId} #${seq}`;
  if (!meta || meta.outcome === 'running' || meta.outcome === 'stopping') return base;
  const parts = [base, OUTCOME_LABELS[meta.outcome] ?? meta.outcome];
  const duration = sessionDuration(meta);
  if (duration != null) parts.push(duration);
  if (meta.inputTokens != null && meta.outputTokens != null) {
    parts.push(formatTokens(meta.inputTokens + meta.outputTokens));
  }
  return parts.join(' · ');
}
