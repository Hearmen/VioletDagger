import fs from 'node:fs';
import path from 'node:path';

// 私聊状态（11-telegram-bot.md §4），整体读写一个 JSON 文件。
export interface BotState {
  chats: Record<string, { currentRoomId: number | null }>;
}

export class StateStore {
  private state: BotState = { chats: {} };

  constructor(private readonly filePath: string) {}

  // 文件不存在视为空状态；无法解析时按空状态启动，原文件直到第一次修改才被覆盖。
  load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    try {
      const parsed = JSON.parse(raw) as BotState;
      if (!parsed || typeof parsed.chats !== 'object' || parsed.chats === null) throw new Error('missing chats');
      this.state = { chats: parsed.chats };
    } catch (err) {
      console.error(`Failed to parse ${this.filePath}, starting with empty state:`, err);
    }
  }

  chatIds(): number[] {
    return Object.keys(this.state.chats).map(Number);
  }

  isRegistered(chatId: number): boolean {
    return String(chatId) in this.state.chats;
  }

  // 已登记则保留原 currentRoomId。
  register(chatId: number): void {
    if (this.isRegistered(chatId)) return;
    this.state.chats[String(chatId)] = { currentRoomId: null };
    this.save();
  }

  getCurrentRoom(chatId: number): number | null {
    return this.state.chats[String(chatId)]?.currentRoomId ?? null;
  }

  setCurrentRoom(chatId: number, roomId: number | null): void {
    const entry = this.state.chats[String(chatId)];
    if (!entry || entry.currentRoomId === roomId) return;
    entry.currentRoomId = roomId;
    this.save();
  }

  // 房间被删除时清空所有指向它的 currentRoomId。
  clearRoom(roomId: number): void {
    let changed = false;
    for (const entry of Object.values(this.state.chats)) {
      if (entry.currentRoomId === roomId) {
        entry.currentRoomId = null;
        changed = true;
      }
    }
    if (changed) this.save();
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.filePath);
  }
}
