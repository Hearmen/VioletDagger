import { ApiError, type RestClient } from './api';
import {
  ArgError, parseNewRoomArgs, parsePlainText, parsePositiveIntArg, parsePostArgs,
} from './args';
import {
  escapeHtml, formatAgents, formatMemory, formatMessageFull, formatReport, formatRoomHeader,
  formatRooms, formatStatus, formatUsage, isMemoryCategory, MEMORY_CATEGORIES, messageLine,
} from './format';
import type { RoomHub } from './hub';
import type { StateStore } from './state';
import type { InlineKeyboard } from './telegram';
import type {
  EventTreePayload, MemoryViewPayload, Message, PostHumanMessageParams, Room, RoomReport,
  RoomStatusPayload, UsageSummaryPayload,
} from './types';

// 命令与内联按钮（11-telegram-bot.md §7、§8）。

export const CONFIRM_TTL_MS = 10 * 60 * 1000;

export const COMMAND_LIST: { command: string; description: string }[] = [
  { command: 'rooms', description: '列出房间' },
  { command: 'use', description: '选择当前房间：/use <roomId>' },
  { command: 'status', description: '当前房间状态' },
  { command: 'messages', description: '最近消息：/messages [n]' },
  { command: 'show', description: '消息全文：/show <messageId>' },
  { command: 'memory', description: '记忆视图：/memory [category]' },
  { command: 'post', description: '带参数发消息：/post key=value… 正文' },
  { command: 'pause', description: '暂停当前房间' },
  { command: 'resume', description: '恢复当前房间：/resume [n]' },
  { command: 'confirm', description: '确认完成当前房间' },
  { command: 'terminate', description: '终止 session：/terminate <sessionId>' },
  { command: 'enable', description: '启用 agent 派发：/enable <agentId>' },
  { command: 'disable', description: '停用 agent 派发：/disable <agentId>' },
  { command: 'newroom', description: '新建房间：/newroom name=… agents=… mode=…' },
  { command: 'deleteroom', description: '删除已结束房间：/deleteroom <roomId>' },
  { command: 'agents', description: 'agent 注册表' },
  { command: 'usage', description: '当前房间用量' },
  { command: 'report', description: '当前房间任务分析报告' },
  { command: 'help', description: '命令说明' },
];

export const HELP_TEXT = [
  '<b>VioletDagger</b>',
  '直接发送文本：作为人类消息发进当前房间；以 @agentId 开头为定向消息。',
  '',
  ...COMMAND_LIST.map((c) => `/${c.command} — ${escapeHtml(c.description)}`),
  '',
  '<b>/post 参数</b>：type= target= refs=1,2 verdict=true|false closes=true|false resolution=RESOLVED|UNRESOLVED summary="…" to=agentId',
  `<b>/memory 类别</b>：${Object.keys(MEMORY_CATEGORIES).join(' / ')}`,
  '<b>/newroom 参数</b>：name= agents=key,key mode=parallel|sequential [max=n] [workdir=路径]',
].join('\n');

export interface ChatContext {
  chatId: number;
  reply: (html: string, keyboard?: InlineKeyboard) => Promise<void>;
}

export interface CallbackContext extends ChatContext {
  messageDate: number; // 按钮所在消息的 date（unix 秒）
  edit: (html: string) => Promise<void>;
  now: () => number;
}

export interface CommandDeps {
  rest: RestClient;
  hub: RoomHub;
  state: StateStore;
}

function confirmKeyboard(data: string): InlineKeyboard {
  return [[{ text: '确认', callback_data: data }, { text: '取消', callback_data: 'cancel' }]];
}

export class Commands {
  constructor(private readonly deps: CommandDeps) {}

  // 返回 false 表示未知命令。
  async run(ctx: ChatContext, command: string, args: string): Promise<boolean> {
    switch (command) {
      case 'start':
      case 'help':
        await ctx.reply(HELP_TEXT);
        return true;
      case 'rooms': return this.rooms(ctx).then(() => true);
      case 'use': return this.use(ctx, parsePositiveIntArg('roomId', args)).then(() => true);
      case 'agents': return this.agents(ctx).then(() => true);
      case 'status': return this.status(ctx).then(() => true);
      case 'messages': return this.messages(ctx, args).then(() => true);
      case 'show': return this.show(ctx, parsePositiveIntArg('messageId', args)).then(() => true);
      case 'memory': return this.memory(ctx, args.trim()).then(() => true);
      case 'post': return this.post(ctx, parsePostArgs(args)).then(() => true);
      case 'pause': return this.simple(ctx, 'pauseRoom', undefined, '已暂停').then(() => true);
      case 'resume': return this.resume(ctx, args.trim()).then(() => true);
      case 'confirm': return this.askConfirm(ctx, this.requireRoom(ctx)).then(() => true);
      case 'terminate': return this.askTerminate(ctx, parsePositiveIntArg('sessionId', args)).then(() => true);
      case 'enable':
      case 'disable': return this.setEnabled(ctx, args.trim(), command === 'enable').then(() => true);
      case 'newroom': return this.newRoom(ctx, args).then(() => true);
      case 'deleteroom': return this.askDelete(ctx, parsePositiveIntArg('roomId', args)).then(() => true);
      case 'usage': return this.usage(ctx).then(() => true);
      case 'report': return this.report(ctx).then(() => true);
      default:
        return false;
    }
  }

  async text(ctx: ChatContext, text: string): Promise<void> {
    await this.post(ctx, parsePlainText(text));
  }

  async callback(ctx: CallbackContext, data: string): Promise<void> {
    const [action, rawRoomId, rawArg] = data.split(':');
    if (action === 'cancel') {
      await ctx.edit('已取消');
      return;
    }
    const roomId = Number(rawRoomId);
    if (!Number.isInteger(roomId) || roomId <= 0) return;

    if (action === 'use') {
      await this.use(ctx, roomId);
      return;
    }
    if (action === 'ask') {
      await this.askConfirm(ctx, roomId);
      return;
    }
    if (action !== 'confirm' && action !== 'terminate' && action !== 'delete') return;

    if (ctx.now() - ctx.messageDate * 1000 > CONFIRM_TTL_MS) {
      await ctx.edit('已过期，请重新执行命令');
      return;
    }
    let result: string;
    try {
      result = await this.executeConfirmed(action, roomId, rawArg);
    } catch (err) {
      if (err instanceof ApiError || err instanceof ArgError) result = escapeHtml(err.message);
      else throw err;
    }
    await ctx.edit(result);
  }

  private async executeConfirmed(action: 'confirm' | 'terminate' | 'delete', roomId: number, rawArg?: string): Promise<string> {
    switch (action) {
      case 'confirm':
        await this.roomCall(roomId, 'confirmCompletion');
        await this.deps.hub.sync().catch(() => undefined);
        return `房间 #${roomId} 已确认完成`;
      case 'terminate': {
        const seq = parsePositiveIntArg('sessionId', rawArg ?? '');
        await this.roomCall(roomId, 'terminateAgentSession', { sessionId: seq });
        return `房间 #${roomId} 的 session #${seq} 已终止`;
      }
      case 'delete': {
        const res = await this.deps.rest.deleteRoom(roomId);
        this.deps.hub.forget(roomId);
        await this.deps.hub.sync().catch(() => undefined);
        const lines = [`房间 #${roomId} 已删除`];
        if (res.nativeDeleteFailures.length > 0) {
          lines.push('以下 CLI 原生会话原件未删除：');
          for (const f of res.nativeDeleteFailures) {
            lines.push(`session #${f.seq} ${escapeHtml(f.agentId)} <code>${escapeHtml(f.target)}</code>：${escapeHtml(f.error)}`);
          }
        }
        return lines.join('\n');
      }
    }
  }

  private requireRoom(ctx: ChatContext): number {
    const roomId = this.deps.state.getCurrentRoom(ctx.chatId);
    if (roomId === null) throw new ArgError('未选择房间，用 /rooms 或 /use <id> 选择');
    return roomId;
  }

  // 房间不存在（404）时移出集合，并清空指向它的当前房间。
  private async roomCall<T>(roomId: number, method: string, params?: object): Promise<T> {
    try {
      return await this.deps.hub.call<T>(roomId, method, params);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) this.deps.hub.forget(roomId);
      throw err;
    }
  }

  private async getRoom(roomId: number): Promise<Room> {
    try {
      return await this.deps.rest.getRoom(roomId);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        this.deps.hub.forget(roomId);
        throw new ApiError(`房间 #${roomId} 不存在`, 404);
      }
      throw err;
    }
  }

  private async rooms(ctx: ChatContext): Promise<void> {
    const { text, ordered } = formatRooms(await this.deps.rest.listRooms());
    const keyboard = ordered.map((r) => [{ text: `使用 #${r.id} ${r.name}`.slice(0, 60), callback_data: `use:${r.id}` }]);
    await ctx.reply(text, keyboard.length > 0 ? keyboard : undefined);
  }

  private async use(ctx: ChatContext, roomId: number): Promise<void> {
    const room = await this.getRoom(roomId);
    this.deps.state.setCurrentRoom(ctx.chatId, room.id);
    await ctx.reply(`当前房间已切换\n${formatRoomHeader(room)}`);
  }

  private async agents(ctx: ChatContext): Promise<void> {
    await ctx.reply(formatAgents(await this.deps.rest.listAgents()));
  }

  private async status(ctx: ChatContext): Promise<void> {
    const roomId = this.requireRoom(ctx);
    const room = await this.getRoom(roomId);
    const status = await this.roomCall<RoomStatusPayload>(roomId, 'getRoomStatus');
    await ctx.reply(formatStatus(room, status));
  }

  private async messages(ctx: ChatContext, args: string): Promise<void> {
    const roomId = this.requireRoom(ctx);
    const n = args.trim() === '' ? 10 : parsePositiveIntArg('n', args);
    if (n > 50) throw new ArgError('n 不能超过 50');
    const { messages } = await this.roomCall<{ messages: Message[] }>(roomId, 'listMessages', { limit: n });
    if (messages.length === 0) {
      await ctx.reply('房间里还没有消息');
      return;
    }
    const view = await this.roomCall<MemoryViewPayload>(roomId, 'getMemoryView');
    const sorted = [...messages].sort((a, b) => a.id - b.id);
    await ctx.reply(sorted.map((m) => messageLine(m, view.goalMessageId)).join('\n'));
  }

  private async show(ctx: ChatContext, messageId: number): Promise<void> {
    const roomId = this.requireRoom(ctx);
    const tree = await this.roomCall<EventTreePayload>(roomId, 'getEventTree');
    const message = tree.messages.find((m) => m.id === messageId);
    if (!message) throw new ArgError(`消息 #${messageId} 不存在`);
    await ctx.reply(formatMessageFull(message, tree.messages[0]?.id ?? null));
  }

  private async memory(ctx: ChatContext, category: string): Promise<void> {
    const roomId = this.requireRoom(ctx);
    if (category !== '' && !isMemoryCategory(category)) {
      throw new ArgError(`类别须为 ${Object.keys(MEMORY_CATEGORIES).join(' / ')} 之一`);
    }
    const view = await this.roomCall<MemoryViewPayload>(roomId, 'getMemoryView');
    await ctx.reply(formatMemory(view, category === '' ? undefined : (category as keyof typeof MEMORY_CATEGORIES)));
  }

  private async post(ctx: ChatContext, params: PostHumanMessageParams): Promise<void> {
    const roomId = this.requireRoom(ctx);
    const { messageId } = await this.roomCall<{ messageId: number }>(roomId, 'postHumanMessage', params);
    await ctx.reply(`已发送 #${messageId}`);
  }

  private async simple(ctx: ChatContext, method: string, params: object | undefined, done: string): Promise<void> {
    const roomId = this.requireRoom(ctx);
    await this.roomCall(roomId, method, params);
    await ctx.reply(done);
  }

  private async resume(ctx: ChatContext, args: string): Promise<void> {
    const roomId = this.requireRoom(ctx);
    const additional = args === '' ? undefined : parsePositiveIntArg('n', args);
    const room = await this.getRoom(roomId);
    if (room.status !== 'paused_limit' && room.status !== 'paused_manual') throw new ArgError('房间未暂停');
    if (room.status === 'paused_limit' && additional === undefined) {
      throw new ArgError('已达上限暂停的房间需要指定追加的 session 数：/resume <n>');
    }
    await this.roomCall(roomId, 'resumeRoom', additional === undefined ? {} : { additionalSessions: additional });
    await ctx.reply(additional === undefined ? '已恢复' : `已恢复，追加 ${additional} 个 session`);
  }

  private async askConfirm(ctx: ChatContext, roomId: number): Promise<void> {
    const room = await this.getRoom(roomId);
    await ctx.reply(
      `确认结束房间 #${room.id} ${escapeHtml(room.name)}？结束后房间只读，不能恢复。`,
      confirmKeyboard(`confirm:${room.id}`),
    );
  }

  private async askTerminate(ctx: ChatContext, seq: number): Promise<void> {
    const roomId = this.requireRoom(ctx);
    await ctx.reply(`确认终止房间 #${roomId} 的 session #${seq}？`, confirmKeyboard(`terminate:${roomId}:${seq}`));
  }

  private async askDelete(ctx: ChatContext, roomId: number): Promise<void> {
    const room = await this.getRoom(roomId);
    await ctx.reply(
      `确认删除房间 #${room.id} ${escapeHtml(room.name)}？将级联删除 session、记忆、事件树、信息流、磁盘日志以及各 agent CLI 的原生会话记录，不可恢复。`,
      confirmKeyboard(`delete:${room.id}`),
    );
  }

  private async setEnabled(ctx: ChatContext, agentId: string, enabled: boolean): Promise<void> {
    if (agentId === '' || /\s/.test(agentId)) throw new ArgError('用法：/enable <agentId> 或 /disable <agentId>');
    const roomId = this.requireRoom(ctx);
    await this.roomCall(roomId, 'setAgentEnabled', { agentId, enabled });
    await ctx.reply(`${escapeHtml(agentId)} 派发已${enabled ? '启用' : '停用'}`);
  }

  private async newRoom(ctx: ChatContext, args: string): Promise<void> {
    const body = parseNewRoomArgs(args);
    const room = await this.deps.rest.createRoom(body);
    this.deps.state.setCurrentRoom(ctx.chatId, room.id);
    await this.deps.hub.sync().catch(() => undefined);
    await ctx.reply(`房间已创建，已设为当前房间。发送第一条消息作为任务描述。\n${formatRoomHeader(room)}`);
  }

  private async usage(ctx: ChatContext): Promise<void> {
    const roomId = this.requireRoom(ctx);
    await ctx.reply(formatUsage(await this.roomCall<UsageSummaryPayload>(roomId, 'getUsageSummary')));
  }

  private async report(ctx: ChatContext): Promise<void> {
    const roomId = this.requireRoom(ctx);
    await ctx.reply(formatReport(await this.roomCall<RoomReport>(roomId, 'getRoomReport')));
  }
}
