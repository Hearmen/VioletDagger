import { escapeHtml } from './format';
import type { InlineKeyboard } from './telegram';
import type { EventTreePayload, Message, RoomStatus, RoomStatusPayload } from './types';

// 主动提醒（11-telegram-bot.md §6）：只在状态变化的边沿提醒，建立连接时的状态只作为基线。

export interface AlertSnapshot {
  status: RoomStatus;
  dispatchIdle: boolean;
  agents: Record<string, {
    stuck: boolean;                      // getRoomStatus 缺省（sequential 房间）记为 false
    exitWarningSessionId: number | null; // 有 exitWarning 时记其 sessionId，否则 null
  }>;
}

export function snapshotOf(status: RoomStatusPayload): AlertSnapshot {
  const agents: AlertSnapshot['agents'] = {};
  for (const a of status.agents) {
    agents[a.agentId] = {
      stuck: a.stuck === true,
      exitWarningSessionId: a.exitWarning ? (a.sessionId ?? null) : null,
    };
  }
  return { status: status.status, dispatchIdle: status.dispatchIdle, agents };
}

export type StatusAlert =
  | { kind: 'pausedLimit' }
  | { kind: 'stuck'; agentId: string; sessionId: number | null; exploringSummary: string | null }
  | { kind: 'exitWarning'; agentId: string; sessionId: number | null }
  | { kind: 'idleEdge' };

export function diffStatus(prev: AlertSnapshot, status: RoomStatusPayload): StatusAlert[] {
  const alerts: StatusAlert[] = [];
  if (status.status === 'paused_limit' && prev.status !== 'paused_limit') alerts.push({ kind: 'pausedLimit' });
  for (const a of status.agents) {
    const before = prev.agents[a.agentId];
    if (a.stuck === true && !before?.stuck) {
      alerts.push({
        kind: 'stuck', agentId: a.agentId, sessionId: a.sessionId ?? null,
        exploringSummary: a.activeExploringSummary ?? null,
      });
    }
    if (a.exitWarning && (a.sessionId ?? null) !== (before?.exitWarningSessionId ?? null)) {
      alerts.push({ kind: 'exitWarning', agentId: a.agentId, sessionId: a.sessionId ?? null });
    }
  }
  if (status.dispatchIdle && !prev.dispatchIdle) alerts.push({ kind: 'idleEdge' });
  return alerts;
}

export interface AlertMonitorDeps {
  roomId: number;
  call: <T>(method: string, params?: object) => Promise<T>;
  roomTag: () => string;
  notify: (html: string, keyboard?: InlineKeyboard) => void;
  idleNotifyDelayMs: number;
  coalesceMs?: number;
}

// 一个监视连接对应一个 monitor。刷新串行执行，保证快照按推送顺序更新。
export class RoomAlertMonitor {
  private snapshot: AlertSnapshot | null = null;
  private chain: Promise<void> = Promise.resolve();
  private coalesceTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(private readonly deps: AlertMonitorDeps) {}

  // 连接（含重连）成功：重新建立基线，不补发断线期间的提醒。
  onConnected(): void {
    this.snapshot = null;
    this.clearIdleTimer();
    this.enqueueRefresh();
  }

  onRoomStatus(): void {
    if (this.coalesceTimer) return;
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = null;
      this.enqueueRefresh();
    }, this.deps.coalesceMs ?? 300);
  }

  onNewMessage(message: Message): void {
    if (this.disposed) return;
    this.handleMessage(message).catch((err) => {
      console.error(`Room ${this.deps.roomId}: failed to evaluate message #${message.id} for alerts:`, err);
    });
  }

  dispose(): void {
    this.disposed = true;
    if (this.coalesceTimer) clearTimeout(this.coalesceTimer);
    this.coalesceTimer = null;
    this.clearIdleTimer();
  }

  // 供测试等待串行刷新完成。
  idle(): Promise<void> {
    return this.chain;
  }

  private enqueueRefresh(): void {
    this.chain = this.chain.then(() => this.refresh()).catch((err) => {
      console.error(`Room ${this.deps.roomId}: failed to refresh status for alerts:`, err);
    });
  }

  private async refresh(): Promise<void> {
    if (this.disposed) return;
    const status = await this.deps.call<RoomStatusPayload>('getRoomStatus');
    if (this.disposed) return;
    const prev = this.snapshot;
    this.snapshot = snapshotOf(status);
    if (!status.dispatchIdle) this.clearIdleTimer();
    if (!prev) return;
    for (const alert of diffStatus(prev, status)) this.emitStatusAlert(alert);
  }

  private emitStatusAlert(alert: StatusAlert): void {
    const tag = this.deps.roomTag();
    switch (alert.kind) {
      case 'pausedLimit':
        this.deps.notify(`${tag} 已达 session 上限并暂停。追加额度恢复：/resume &lt;n&gt;`);
        break;
      case 'stuck': {
        const lines = [`${tag} ${escapeHtml(alert.agentId)} 可能卡住${alert.sessionId !== null ? `（session #${alert.sessionId}）` : ''}`];
        if (alert.exploringSummary) lines.push(`探索：${escapeHtml(alert.exploringSummary.replace(/\s*\n\s*/g, ' '))}`);
        if (alert.sessionId !== null) lines.push(`终止：/terminate ${alert.sessionId}`);
        this.deps.notify(lines.join('\n'));
        break;
      }
      case 'exitWarning':
        this.deps.notify(alert.sessionId !== null
          ? `${tag} ${escapeHtml(alert.agentId)} 的 session #${alert.sessionId} 清理未确认，重试：/terminate ${alert.sessionId}`
          : `${tag} ${escapeHtml(alert.agentId)} 的 session 清理未确认`);
        break;
      case 'idleEdge':
        this.startIdleTimer();
        break;
    }
  }

  // 无任务可派发的稳定等待：到期复查仍为 true 才提醒。
  private startIdleTimer(): void {
    if (this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.chain = this.chain.then(async () => {
        if (this.disposed) return;
        const status = await this.deps.call<RoomStatusPayload>('getRoomStatus');
        if (this.disposed || !status.dispatchIdle) return;
        const disabled = status.disabledAgentCount > 0 ? `（${status.disabledAgentCount} 个 agent 已停用派发）` : '';
        this.deps.notify(`${this.deps.roomTag()} 当前没有任务可派发${disabled}。可以补充消息、启用 agent 或 /confirm 确认完成`);
      }).catch((err) => {
        console.error(`Room ${this.deps.roomId}: failed to recheck dispatchIdle:`, err);
      });
    }, this.deps.idleNotifyDelayMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private async handleMessage(message: Message): Promise<void> {
    const tag = this.deps.roomTag();
    if (message.authorId === 'system') {
      this.deps.notify(`${tag} 系统消息 #${message.id}\n${escapeHtml(message.content)}`);
      return;
    }
    if (message.type === 'propose_completion') {
      this.deps.notify(
        `${tag} ${escapeHtml(message.authorId)} 提议完成（#${message.id}）\n${escapeHtml(message.content)}`,
        [[{ text: '确认完成…', callback_data: `ask:${this.deps.roomId}` }]],
      );
      return;
    }
    // session 报错的占位消息：无 type、有 sessionSeq、作者是 agent 实例标识（03 §2）。
    if (message.type !== null || message.sessionSeq === null || message.authorId === 'human') return;
    const tree = await this.deps.call<EventTreePayload>('getEventTree');
    const session = tree.sessions.find((s) => s.seq === message.sessionSeq);
    if (!session || session.outcome !== 'error' || this.disposed) return;
    const status = await this.deps.call<RoomStatusPayload>('getRoomStatus');
    const agent = status.agents.find((a) => a.agentId === message.authorId);
    const lines = [
      `${tag} ${escapeHtml(message.authorId)} 的 session #${message.sessionSeq} 异常退出`,
      escapeHtml(message.content),
    ];
    if (agent && !agent.enabled) {
      lines.push(`已因连续失败被停用派发，/enable ${escapeHtml(message.authorId)}`);
    }
    this.deps.notify(lines.join('\n'));
  }
}
