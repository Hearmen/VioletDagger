// Telegram Bot API 的最小封装，只用 11-telegram-bot.md §11 列出的方法，Node 内置 fetch，不引入 SDK。

export interface TgUser { id: number }
export interface TgChat { id: number; type: string }
export interface TgMessage {
  message_id: number;
  date: number; // unix 秒
  chat: TgChat;
  from?: TgUser;
  text?: string;
}
export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface InlineButton { text: string; callback_data: string }
export type InlineKeyboard = InlineButton[][];

export class TelegramApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface TelegramApi {
  getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<TgUpdate[]>;
  sendMessage(chatId: number, html: string, keyboard?: InlineKeyboard): Promise<TgMessage>;
  // keyboard 省略时移除原消息上的按钮。
  editMessageText(chatId: number, messageId: number, html: string, keyboard?: InlineKeyboard): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
  setMyCommands(commands: { command: string; description: string }[]): Promise<void>;
}

export function createTelegramApi(token: string, fetchImpl: typeof fetch = fetch): TelegramApi {
  async function call<T>(method: string, body: object, signal?: AbortSignal): Promise<T> {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    let payload: { ok?: boolean; result?: T; description?: string; error_code?: number };
    try {
      payload = (await res.json()) as typeof payload;
    } catch {
      throw new TelegramApiError(`${method}: HTTP ${res.status}`, res.status);
    }
    if (!payload.ok) {
      throw new TelegramApiError(
        `${method}: ${payload.description ?? `HTTP ${res.status}`}`,
        payload.error_code ?? res.status,
      );
    }
    return payload.result as T;
  }

  return {
    getUpdates(offset, timeoutSec, signal) {
      return call<TgUpdate[]>(
        'getUpdates',
        { offset, timeout: timeoutSec, allowed_updates: ['message', 'callback_query'] },
        signal,
      );
    },
    sendMessage(chatId, html, keyboard) {
      return call<TgMessage>('sendMessage', {
        chat_id: chatId,
        text: html,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
      });
    },
    async editMessageText(chatId, messageId, html, keyboard) {
      await call('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: html,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: keyboard ?? [] },
      });
    },
    async answerCallbackQuery(callbackQueryId, text) {
      await call('answerCallbackQuery', { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
    },
    async setMyCommands(commands) {
      await call('setMyCommands', { commands });
    },
  };
}
