import path from 'node:path';

// 环境变量见 11-telegram-bot.md §2。
export interface BotConfig {
  token: string;
  allowedUserIds: Set<number>;
  apiUrl: string;
  statePath: string;
  idleNotifyDelayMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv, packageRoot: string): BotConfig {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required');

  const rawIds = (env.VIOLETDAGGER_TG_ALLOWED_USER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (rawIds.length === 0) throw new Error('VIOLETDAGGER_TG_ALLOWED_USER_IDS is required');
  const allowedUserIds = new Set<number>();
  for (const raw of rawIds) {
    if (!/^-?\d+$/.test(raw)) {
      throw new Error(`VIOLETDAGGER_TG_ALLOWED_USER_IDS must be comma-separated integers, got: ${raw}`);
    }
    allowedUserIds.add(Number(raw));
  }

  const rawDelay = env.VIOLETDAGGER_TG_IDLE_NOTIFY_DELAY_MS ?? '10000';
  const idleNotifyDelayMs = Number(rawDelay);
  if (!Number.isInteger(idleNotifyDelayMs) || idleNotifyDelayMs < 0) {
    throw new Error(`VIOLETDAGGER_TG_IDLE_NOTIFY_DELAY_MS must be a non-negative integer, got: ${rawDelay}`);
  }

  return {
    token,
    allowedUserIds,
    apiUrl: (env.VIOLETDAGGER_API_URL ?? 'http://127.0.0.1:4200').replace(/\/+$/, ''),
    statePath: env.VIOLETDAGGER_TG_STATE_PATH ?? path.join(packageRoot, 'state.json'),
    idleNotifyDelayMs,
  };
}
