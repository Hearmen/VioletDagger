import WebSocket from 'ws';
import type {
  AgentInfo, CreateRoomBody, NativeDeleteFailure, Room, RoomSummary,
} from './types';

// 编排器客户端（11-telegram-bot.md §5）。错误文案直接回复给人类。
export const UNREACHABLE = '编排器不可达';

export class ApiError extends Error {
  // status：REST 的 HTTP 状态码；WS 升级被拒为 404；其余为 undefined。
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export class RestClient {
  constructor(private readonly baseUrl: string, private readonly fetchImpl: typeof fetch = fetch) {}

  listRooms(): Promise<RoomSummary[]> {
    return this.request('GET', '/api/rooms');
  }

  getRoom(roomId: number): Promise<Room> {
    return this.request('GET', `/api/rooms/${roomId}`);
  }

  createRoom(body: CreateRoomBody): Promise<Room> {
    return this.request('POST', '/api/rooms', body);
  }

  deleteRoom(roomId: number): Promise<{ ok: true; nativeDeleteFailures: NativeDeleteFailure[] }> {
    return this.request('DELETE', `/api/rooms/${roomId}`);
  }

  listAgents(): Promise<AgentInfo[]> {
    return this.request('GET', '/api/agents');
  }

  private async request<T>(method: string, pathname: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(UNREACHABLE);
    }
    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      // 非 JSON 响应体：成功时不应出现，失败时退回 HTTP 状态码文案。
    }
    if (!res.ok) {
      const message = (payload as { error?: { message?: unknown } } | null)?.error?.message;
      throw new ApiError(typeof message === 'string' ? message : `HTTP ${res.status}`, res.status);
    }
    return payload as T;
  }
}

export interface RoomConnectionHandlers {
  onOpen?: () => void;
  onPush?: (event: string, data: unknown) => void;
  // WS 升级被拒绝（HTTP 404）：房间不存在，之后不再重连。
  onGone?: () => void;
}

export interface RoomConnectionOptions {
  watch: boolean;
  handlers?: RoomConnectionHandlers;
  rpcTimeoutMs?: number;
  idleCloseMs?: number;
  maxBackoffMs?: number;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

// 一个房间的 WS：承载 RPC 与推送（§5.2）。监视连接断线后退避重连；临时连接空闲后关闭，下次调用再建立。
export class RoomConnection {
  private ws: WebSocket | null = null;
  private opened = false;
  private openWaiters: { resolve: () => void; reject: (err: Error) => void }[] = [];
  private pending = new Map<string, PendingCall>();
  private nextId = 1;
  private inFlight = 0;
  private backoffAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private gone = false;
  private watch: boolean;
  private readonly handlers: RoomConnectionHandlers;
  private readonly rpcTimeoutMs: number;
  private readonly idleCloseMs: number;
  private readonly maxBackoffMs: number;

  constructor(private readonly wsBaseUrl: string, readonly roomId: number, options: RoomConnectionOptions) {
    this.watch = options.watch;
    this.handlers = options.handlers ?? {};
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? 15_000;
    this.idleCloseMs = options.idleCloseMs ?? 60_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
    if (this.watch) this.connect();
  }

  get isGone(): boolean {
    return this.gone;
  }

  async call<T>(method: string, params?: object): Promise<T> {
    if (this.closed || this.gone) throw new ApiError('房间不存在', 404);
    this.clearIdleTimer();
    this.inFlight += 1;
    try {
      await this.ensureOpen();
      return await this.send<T>(method, params);
    } finally {
      this.inFlight -= 1;
      this.scheduleIdleClose();
    }
  }

  // 房间结束后转为临时连接，未结束（或新出现）的房间转为监视连接。
  setWatch(watch: boolean): void {
    if (this.watch === watch) return;
    this.watch = watch;
    if (watch) {
      this.clearIdleTimer();
      if (!this.ws) this.connect();
    } else {
      this.clearReconnectTimer();
      this.scheduleIdleClose();
    }
  }

  close(): void {
    this.closed = true;
    this.clearReconnectTimer();
    this.clearIdleTimer();
    this.ws?.close();
    this.ws = null;
  }

  private ensureOpen(): Promise<void> {
    if (this.ws && this.opened) return Promise.resolve();
    if (!this.ws) this.connect();
    return new Promise((resolve, reject) => this.openWaiters.push({ resolve, reject }));
  }

  private connect(): void {
    if (this.closed || this.gone) return;
    this.clearReconnectTimer();
    const ws = new WebSocket(`${this.wsBaseUrl}/api/rooms/${this.roomId}/ws`);
    this.ws = ws;
    this.opened = false;

    ws.on('unexpected-response', (req, res) => {
      req.destroy();
      if (res.statusCode === 404) {
        this.gone = true;
        this.failOpenWaiters(new ApiError('房间不存在', 404));
        this.handlers.onGone?.();
      }
      // 其他状态码按普通连接失败处理，close 后按退避重连。
      if (this.ws === ws) this.handleClose(ws);
    });

    ws.on('open', () => {
      if (this.ws !== ws) return;
      this.opened = true;
      this.backoffAttempt = 0;
      const waiters = this.openWaiters;
      this.openWaiters = [];
      waiters.forEach((w) => w.resolve());
      if (this.watch) this.handlers.onOpen?.();
    });

    ws.on('message', (raw) => {
      if (this.ws !== ws) return;
      let frame: { id?: string; result?: unknown; error?: { message?: string }; event?: string; data?: unknown };
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (typeof frame.id === 'string') {
        const call = this.pending.get(frame.id);
        if (!call) return;
        this.pending.delete(frame.id);
        clearTimeout(call.timer);
        if (frame.error) call.reject(new ApiError(frame.error.message ?? 'RPC error'));
        else call.resolve(frame.result);
      } else if (typeof frame.event === 'string') {
        this.handlers.onPush?.(frame.event, frame.data);
      }
    });

    ws.on('error', () => {
      // close 事件随后到达，统一在那里处理。
    });

    ws.on('close', () => {
      if (this.ws === ws) this.handleClose(ws);
    });
  }

  private handleClose(ws: WebSocket): void {
    if (this.ws !== ws) return;
    this.ws = null;
    const wasOpen = this.opened;
    this.opened = false;
    this.failOpenWaiters(new ApiError(this.gone ? '房间不存在' : UNREACHABLE, this.gone ? 404 : undefined));
    for (const [id, call] of this.pending) {
      clearTimeout(call.timer);
      call.reject(new ApiError('连接断开'));
      this.pending.delete(id);
    }
    if (this.closed || this.gone || !this.watch) return;
    if (wasOpen) this.backoffAttempt = 0;
    const delay = Math.min(this.maxBackoffMs, 1000 * 2 ** this.backoffAttempt);
    this.backoffAttempt += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private send<T>(method: string, params?: object): Promise<T> {
    const ws = this.ws;
    if (!ws || !this.opened) return Promise.reject(new ApiError('连接断开'));
    const id = String(this.nextId++);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ApiError(`${method} 超时`));
      }, this.rpcTimeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      ws.send(JSON.stringify(params === undefined ? { id, method } : { id, method, params }));
    });
  }

  private failOpenWaiters(err: Error): void {
    const waiters = this.openWaiters;
    this.openWaiters = [];
    waiters.forEach((w) => w.reject(err));
  }

  private scheduleIdleClose(): void {
    if (this.watch || this.closed || this.inFlight > 0) return;
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.watch || this.inFlight > 0) return;
      const ws = this.ws;
      this.ws = null;
      this.opened = false;
      ws?.close();
    }, this.idleCloseMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}
