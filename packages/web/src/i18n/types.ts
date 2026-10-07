import type { MessageKey } from './zh';
import type { TFunction, TParams } from './translate';

export type Locale = 'zh' | 'en';
export const LOCALES: readonly Locale[] = ['zh', 'en'];
export const DEFAULT_LOCALE: Locale = 'zh';
// 与 vd.dashboard.layout、vd.eventTree.tab 同一命名前缀（09-frontend-i18n.md §2.1）。
export const LOCALE_STORAGE_KEY = 'vd.locale';

// 状态里不存已翻译的字符串，渲染时再翻译，切换语言后已显示的提示也会变（09-frontend-i18n.md §2.4）。
export type LocalizedText =
  | { kind: 'key'; key: MessageKey; params?: TParams }
  | { kind: 'raw'; text: string };

export function renderText(text: LocalizedText, t: TFunction): string {
  return text.kind === 'key' ? t(text.key, text.params) : text.text;
}

// 捕获到的异常：Error 的 message 来自服务端/运行时，原样展示；其它情况用前端文案兜底。
export function errorText(err: unknown): LocalizedText {
  return err instanceof Error ? { kind: 'raw', text: err.message } : { kind: 'key', key: 'common.unknownError' };
}
