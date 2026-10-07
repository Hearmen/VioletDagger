import { en } from './en';
import type { Locale } from './types';
import { zh, type MessageKey } from './zh';

export type TParams = Record<string, string | number>;
export type TFunction = (key: MessageKey, params?: TParams) => string;

const DICTIONARIES: Record<Locale, Record<MessageKey, string>> = { zh, en };

// 未提供的占位符原样保留，便于测试发现遗漏（09-frontend-i18n.md §2.2）。
export function interpolate(template: string, params?: TParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

export function createT(locale: Locale): TFunction {
  const dict = DICTIONARIES[locale];
  return (key, params) => interpolate(dict[key], params);
}
