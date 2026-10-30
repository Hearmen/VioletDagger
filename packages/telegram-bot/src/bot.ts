import { ApiError } from './api';
import { ArgError } from './args';
import { type CallbackContext, type ChatContext, COMMAND_LIST, Commands } from './commands';
import { escapeHtml, splitMessage } from './format';
import type { StateStore } from './state';
import {
  type InlineKeyboard, type TelegramApi, TelegramApiError, type TgCallbackQuery, type TgMessage, type TgUpdate,
} from './telegram';

// 长轮询、访问控制与 update 分发（11-telegram-bot.md §3、§10）。

export class FatalBotError extends Error {}

export interface BotDeps {
  tg: TelegramApi;
  state: StateStore;
  commands: Commands;
  allowedUserIds: Set<number>;
  retryDelayMs?: number;
  now?: () => number;
}

export function isAuthorized(allowed: Set<number>, chatType: string | undefined, fromId: number | undefined): boolean {
  return chatType === 'private' && fromId !== undefined && allowed.has(fromId);
}

const COMMAND_PATTERN = /^\/([A-Za-z_]+)(?:@\S+)?(?:\s+([\s\S]*))?$/;

export class Bot {
  private offset = 0;
  private abort = new AbortController();
  private stopped = false;

  constructor(private readonly deps: BotDeps) {}

  // 向所有登记私聊发送，单条超长时切分。
  async broadcast(html: string, keyboard?: InlineKeyboard): Promise<void> {
    for (const chatId of this.deps.state.chatIds()) {
      await this.send(chatId, html, keyboard).catch((err) => {
        console.error(`Failed to notify chat ${chatId}:`, err.message);
      });
    }
  }

  async run(): Promise<void> {
    await this.deps.tg.setMyCommands(COMMAND_LIST).catch((err) => {
      console.error('setMyCommands failed:', err.message);
    });
    while (!this.stopped) {
      let updates: TgUpdate[];
      try {
        updates = await this.deps.tg.getUpdates(this.offset, 50, this.abort.signal);
      } catch (err) {
        if (this.stopped) break;
        if (err instanceof TelegramApiError && err.status === 409) {
          throw new FatalBotError('同一 token 已有其他实例在运行');
        }
        console.error('getUpdates failed:', (err as Error).message);
        await this.sleep(this.deps.retryDelayMs ?? 3000);
        continue;
      }
      for (const update of updates) {
        await this.handleUpdate(update);
        this.offset = update.update_id + 1;
      }
    }
  }

  stop(): void {
    this.stopped = true;
    this.abort.abort();
  }

  async handleUpdate(update: TgUpdate): Promise<void> {
    if (update.message) await this.handleMessage(update.message);
    else if (update.callback_query) await this.handleCallback(update.callback_query);
  }

  private async handleMessage(message: TgMessage): Promise<void> {
    if (!isAuthorized(this.deps.allowedUserIds, message.chat.type, message.from?.id)) {
      console.log(`rejected update from ${message.from?.id} in ${message.chat.type}`);
      return;
    }
    const chatId = message.chat.id;
    const ctx: ChatContext = { chatId, reply: (html, keyboard) => this.send(chatId, html, keyboard) };
    await this.guard(ctx, async () => {
      const text = message.text;
      if (text === undefined) {
        await ctx.reply('只支持文本消息');
        return;
      }
      const match = COMMAND_PATTERN.exec(text.trim());
      const command = match ? match[1].toLowerCase() : null;
      if (command === 'start') this.deps.state.register(chatId);
      if (!this.deps.state.isRegistered(chatId)) {
        await ctx.reply('请先发送 /start');
        return;
      }
      if (match && command) {
        const known = await this.deps.commands.run(ctx, command, match[2] ?? '');
        if (!known) await ctx.reply('未知命令，见 /help');
      } else {
        await this.deps.commands.text(ctx, text);
      }
    });
  }

  private async handleCallback(query: TgCallbackQuery): Promise<void> {
    const message = query.message;
    if (!isAuthorized(this.deps.allowedUserIds, message?.chat.type, query.from.id) || !message) {
      console.log(`rejected update from ${query.from.id} in ${message?.chat.type}`);
      return;
    }
    await this.deps.tg.answerCallbackQuery(query.id).catch((err) => {
      console.error('answerCallbackQuery failed:', err.message);
    });
    const chatId = message.chat.id;
    const ctx: CallbackContext = {
      chatId,
      reply: (html, keyboard) => this.send(chatId, html, keyboard),
      messageDate: message.date,
      edit: (html) => this.deps.tg.editMessageText(chatId, message.message_id, splitMessage(html)[0]),
      now: this.deps.now ?? Date.now,
    };
    if (!this.deps.state.isRegistered(chatId)) {
      await ctx.reply('请先发送 /start');
      return;
    }
    await this.guard(ctx, () => this.deps.commands.callback(ctx, query.data ?? ''));
  }

  // 用户可见错误回复一行文案；其他异常回复"内部错误"，不影响后续 update。
  private async guard(ctx: ChatContext, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      const userFacing = err instanceof ArgError || err instanceof ApiError;
      if (!userFacing) console.error('Failed to handle update:', err);
      await ctx.reply(userFacing ? escapeHtml((err as Error).message) : '内部错误').catch((replyErr) => {
        console.error('Failed to send error reply:', replyErr.message);
      });
    }
  }

  private async send(chatId: number, html: string, keyboard?: InlineKeyboard): Promise<void> {
    const chunks = splitMessage(html);
    for (let i = 0; i < chunks.length; i += 1) {
      // 按钮挂在最后一片上。
      await this.deps.tg.sendMessage(chatId, chunks[i], i === chunks.length - 1 ? keyboard : undefined);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.abort.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}
