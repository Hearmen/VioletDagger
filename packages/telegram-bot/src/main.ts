import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RestClient } from './api';
import { Bot, FatalBotError } from './bot';
import { Commands } from './commands';
import { loadConfig } from './config';
import { RoomHub } from './hub';
import { StateStore } from './state';
import { createTelegramApi } from './telegram';

// 包根目录（src/ 或 dist/ 的上一级），不随启动时的 cwd 变化。
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env, PACKAGE_ROOT);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return;
  }

  const state = new StateStore(config.statePath);
  state.load();
  const tg = createTelegramApi(config.token);
  const rest = new RestClient(config.apiUrl);

  let bot: Bot | null = null;
  const hub = new RoomHub({
    rest,
    wsBaseUrl: config.apiUrl.replace(/^http/, 'ws'),
    idleNotifyDelayMs: config.idleNotifyDelayMs,
    notify: (html, keyboard) => {
      void bot?.broadcast(html, keyboard);
    },
    onRoomGone: (roomId) => state.clearRoom(roomId),
  });
  bot = new Bot({ tg, state, commands: new Commands({ rest, hub, state }), allowedUserIds: config.allowedUserIds });

  const shutdown = () => {
    bot?.stop();
    hub.stop();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await hub.start();
  console.log(`VioletDagger Telegram bot started, orchestrator at ${config.apiUrl}`);
  try {
    await bot.run();
  } catch (err) {
    if (err instanceof FatalBotError) {
      console.error(err.message);
      process.exitCode = 1;
    } else {
      throw err;
    }
  } finally {
    hub.stop();
  }
}

main().catch((err) => {
  console.error('Telegram bot crashed:', err);
  process.exitCode = 1;
});
