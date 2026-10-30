import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApiError } from '../src/api';
import { Bot } from '../src/bot';
import { Commands, CONFIRM_TTL_MS } from '../src/commands';
import { StateStore } from '../src/state';
import type { TelegramApi, TgUpdate } from '../src/telegram';
import type { Room } from '../src/types';

const OWNER = 42;
const NOW = 1_800_000_000_000;

function room(overrides: Partial<Room> = {}): Room {
  return {
    id: 7, name: 'r', status: 'active', createdAt: '', schedulingMode: 'parallel',
    maxSessions: 20, workdir: '/w', completedAt: null, ...overrides,
  };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-bot-'));
  const state = new StateStore(path.join(dir, 'state.json'));
  const sent: { chatId: number; html: string; keyboard?: unknown }[] = [];
  const edits: string[] = [];
  const tg: TelegramApi = {
    getUpdates: vi.fn(),
    sendMessage: vi.fn(async (chatId, html, keyboard) => {
      sent.push({ chatId, html, keyboard });
      return { message_id: 1, date: 0, chat: { id: chatId, type: 'private' } };
    }),
    editMessageText: vi.fn(async (_c, _m, html) => { edits.push(html); }),
    answerCallbackQuery: vi.fn(async () => undefined),
    setMyCommands: vi.fn(async () => undefined),
  };
  const rest = {
    getRoom: vi.fn(async (id: number) => room({ id })),
    listRooms: vi.fn(async () => []),
    createRoom: vi.fn(),
    deleteRoom: vi.fn(async () => ({ ok: true, nativeDeleteFailures: [] })),
    listAgents: vi.fn(async () => []),
  };
  const hub = {
    call: vi.fn(async (_roomId: number, method: string) => (method === 'postHumanMessage' ? { messageId: 11 } : { ok: true })),
    sync: vi.fn(async () => undefined),
    forget: vi.fn((id: number) => state.clearRoom(id)),
  };
  const commands = new Commands({ rest: rest as never, hub: hub as never, state });
  const bot = new Bot({ tg, state, commands, allowedUserIds: new Set([OWNER]), now: () => NOW });
  const text = (t: string, from = OWNER, type = 'private'): TgUpdate => ({
    update_id: 1, message: { message_id: 1, date: 0, chat: { id: 100, type }, from: { id: from }, text: t },
  });
  const click = (data: string, ageMs = 0, from = OWNER): TgUpdate => ({
    update_id: 2,
    callback_query: {
      id: 'q', from: { id: from }, data,
      message: { message_id: 5, date: Math.floor((NOW - ageMs) / 1000), chat: { id: 100, type: 'private' } },
    },
  });
  return { bot, state, sent, edits, tg, rest, hub, text, click };
}

describe('access control', () => {
  it('silently ignores strangers and group chats', async () => {
    const { bot, sent, tg, text, click } = setup();
    await bot.handleUpdate(text('/start', 99));
    await bot.handleUpdate(text('/start', OWNER, 'group'));
    await bot.handleUpdate(click('cancel', 0, 99));
    expect(sent).toEqual([]);
    expect(tg.answerCallbackQuery).not.toHaveBeenCalled();
  });

  it('requires /start before anything else, then registers the chat', async () => {
    const { bot, state, sent, text } = setup();
    await bot.handleUpdate(text('/rooms'));
    expect(sent.at(-1)!.html).toBe('请先发送 /start');
    expect(state.isRegistered(100)).toBe(false);
    await bot.handleUpdate(text('/start'));
    expect(state.isRegistered(100)).toBe(true);
    expect(sent.at(-1)!.html).toContain('VioletDagger');
  });
});

describe('commands', () => {
  async function registered() {
    const ctx = setup();
    await ctx.bot.handleUpdate(ctx.text('/start'));
    return ctx;
  }

  it('answers unknown commands and asks for a room first', async () => {
    const { bot, sent, text } = await registered();
    await bot.handleUpdate(text('/nope'));
    expect(sent.at(-1)!.html).toBe('未知命令，见 /help');
    await bot.handleUpdate(text('hello'));
    expect(sent.at(-1)!.html).toBe('未选择房间，用 /rooms 或 /use &lt;id&gt; 选择');
  });

  it('posts plain text and directed messages to the current room', async () => {
    const { bot, sent, hub, text } = await registered();
    await bot.handleUpdate(text('/use 7'));
    await bot.handleUpdate(text('@codex-1 check #3'));
    expect(hub.call).toHaveBeenCalledWith(7, 'postHumanMessage', { content: 'check #3', targetAgentId: 'codex-1' });
    expect(sent.at(-1)!.html).toBe('已发送 #11');
  });

  it('relays RPC errors verbatim and forgets rooms that are gone', async () => {
    const { bot, sent, hub, state, text } = await registered();
    await bot.handleUpdate(text('/use 7'));
    hub.call.mockRejectedValueOnce(new ApiError('房间不存在', 404));
    await bot.handleUpdate(text('/pause'));
    expect(sent.at(-1)!.html).toBe('房间不存在');
    expect(hub.forget).toHaveBeenCalledWith(7);
    expect(state.getCurrentRoom(100)).toBeNull();
  });

  it('guards /resume by room status', async () => {
    const { bot, sent, hub, rest, text } = await registered();
    await bot.handleUpdate(text('/use 7'));
    await bot.handleUpdate(text('/resume'));
    expect(sent.at(-1)!.html).toBe('房间未暂停');
    rest.getRoom.mockResolvedValueOnce(room({ status: 'paused_limit' }));
    await bot.handleUpdate(text('/resume'));
    expect(sent.at(-1)!.html).toContain('/resume &lt;n&gt;');
    rest.getRoom.mockResolvedValueOnce(room({ status: 'paused_limit' }));
    await bot.handleUpdate(text('/resume 5'));
    expect(hub.call).toHaveBeenLastCalledWith(7, 'resumeRoom', { additionalSessions: 5 });
  });

  it('asks before confirming and executes on the button', async () => {
    const { bot, sent, edits, hub, text, click } = await registered();
    await bot.handleUpdate(text('/use 7'));
    await bot.handleUpdate(text('/confirm'));
    expect(sent.at(-1)!.keyboard).toEqual([[{ text: '确认', callback_data: 'confirm:7' }, { text: '取消', callback_data: 'cancel' }]]);
    expect(hub.call).not.toHaveBeenCalledWith(7, 'confirmCompletion', undefined);
    await bot.handleUpdate(click('confirm:7'));
    expect(hub.call).toHaveBeenCalledWith(7, 'confirmCompletion', undefined);
    expect(edits.at(-1)).toBe('房间 #7 已确认完成');
  });

  it('expires confirmation buttons after 10 minutes but not use/ask', async () => {
    const { bot, edits, hub, sent, click } = await registered();
    await bot.handleUpdate(click('terminate:7:3', CONFIRM_TTL_MS + 1000));
    expect(edits.at(-1)).toBe('已过期，请重新执行命令');
    expect(hub.call).not.toHaveBeenCalled();
    await bot.handleUpdate(click('ask:7', CONFIRM_TTL_MS * 10));
    expect(sent.at(-1)!.keyboard).toEqual([[{ text: '确认', callback_data: 'confirm:7' }, { text: '取消', callback_data: 'cancel' }]]);
    await bot.handleUpdate(click('cancel'));
    expect(edits.at(-1)).toBe('已取消');
  });

  it('shows executed errors in the confirmation message', async () => {
    const { bot, edits, rest, click } = await registered();
    rest.deleteRoom.mockRejectedValueOnce(new ApiError('Only completed rooms can be deleted', 409));
    await bot.handleUpdate(click('delete:7'));
    expect(edits.at(-1)).toBe('Only completed rooms can be deleted');
  });

  it('replies 内部错误 on unexpected exceptions', async () => {
    const { bot, sent, rest, text } = await registered();
    rest.listRooms.mockRejectedValueOnce(new TypeError('bad'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await bot.handleUpdate(text('/rooms'));
    spy.mockRestore();
    expect(sent.at(-1)!.html).toBe('内部错误');
  });
});
