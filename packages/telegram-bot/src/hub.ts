import { RoomAlertMonitor } from './alerts';
import { RestClient, RoomConnection } from './api';
import { roomTag } from './format';
import type { InlineKeyboard } from './telegram';
import type { Message, RoomSummary } from './types';

// 房间集合与连接管理（11-telegram-bot.md §5.2）：未结束的房间常驻监视连接并挂提醒，
// completed 房间只按需建立临时连接。
export interface RoomHubDeps {
  rest: RestClient;
  wsBaseUrl: string;
  idleNotifyDelayMs: number;
  notify: (html: string, keyboard?: InlineKeyboard) => void;
  onRoomGone: (roomId: number) => void;
  syncIntervalMs?: number;
}

export class RoomHub {
  private rooms = new Map<number, RoomSummary>();
  private conns = new Map<number, RoomConnection>();
  private monitors = new Map<number, RoomAlertMonitor>();
  private syncTimer: NodeJS.Timeout | null = null;
  private syncing: Promise<void> | null = null;

  constructor(private readonly deps: RoomHubDeps) {}

  async start(): Promise<void> {
    await this.sync().catch((err) => console.error('Initial room sync failed:', err.message));
    this.syncTimer = setInterval(() => {
      this.sync().catch((err) => console.error('Room sync failed:', err.message));
    }, this.deps.syncIntervalMs ?? 60_000);
  }

  stop(): void {
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = null;
    for (const id of [...this.conns.keys()]) this.drop(id);
  }

  roomName(roomId: number): string {
    return this.rooms.get(roomId)?.name ?? '';
  }

  call<T>(roomId: number, method: string, params?: object): Promise<T> {
    return this.connection(roomId).call<T>(method, params);
  }

  // 并发触发时合并为一次同步。
  sync(): Promise<void> {
    if (!this.syncing) {
      this.syncing = this.doSync().finally(() => {
        this.syncing = null;
      });
    }
    return this.syncing;
  }

  // 房间已不存在（roomDeleted 推送、WS 404、REST 404）：关闭连接并移出集合。
  forget(roomId: number): void {
    this.rooms.delete(roomId);
    this.drop(roomId);
    this.deps.onRoomGone(roomId);
  }

  private async doSync(): Promise<void> {
    const list = await this.deps.rest.listRooms();
    const seen = new Set<number>();
    for (const room of list) {
      seen.add(room.id);
      this.rooms.set(room.id, room);
      const watch = room.status !== 'completed';
      const existing = this.conns.get(room.id);
      if (existing) {
        existing.setWatch(watch);
        if (!watch) this.disposeMonitor(room.id);
        else if (!this.monitors.has(room.id)) this.ensureMonitor(room.id);
      } else if (watch) {
        this.connection(room.id);
      }
    }
    for (const id of [...this.rooms.keys()]) {
      if (!seen.has(id)) this.forget(id);
    }
  }

  private connection(roomId: number): RoomConnection {
    const existing = this.conns.get(roomId);
    if (existing && !existing.isGone) return existing;
    const watch = this.rooms.has(roomId) && this.rooms.get(roomId)!.status !== 'completed';
    const conn = new RoomConnection(this.deps.wsBaseUrl, roomId, {
      watch,
      handlers: {
        onOpen: () => this.monitors.get(roomId)?.onConnected(),
        onPush: (event, data) => this.handlePush(roomId, event, data),
        onGone: () => {
          if (this.conns.get(roomId) === conn) this.forget(roomId);
        },
      },
    });
    this.conns.set(roomId, conn);
    if (watch) this.ensureMonitor(roomId);
    return conn;
  }

  private ensureMonitor(roomId: number): void {
    if (this.monitors.has(roomId)) return;
    this.monitors.set(roomId, new RoomAlertMonitor({
      roomId,
      call: (method, params) => this.connection(roomId).call(method, params),
      roomTag: () => roomTag(roomId, this.roomName(roomId)),
      notify: this.deps.notify,
      idleNotifyDelayMs: this.deps.idleNotifyDelayMs,
    }));
  }

  private disposeMonitor(roomId: number): void {
    this.monitors.get(roomId)?.dispose();
    this.monitors.delete(roomId);
  }

  private handlePush(roomId: number, event: string, data: unknown): void {
    const monitor = this.monitors.get(roomId);
    switch (event) {
      case 'roomStatus':
        monitor?.onRoomStatus();
        break;
      case 'newMessage':
        monitor?.onNewMessage(data as Message);
        break;
      case 'roomDeleted':
        this.forget(roomId);
        break;
      default:
        break; // memoryUpdate 忽略
    }
  }

  private drop(roomId: number): void {
    this.disposeMonitor(roomId);
    this.conns.get(roomId)?.close();
    this.conns.delete(roomId);
  }
}
