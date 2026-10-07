import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createT, type TFunction } from './translate';
import { DEFAULT_LOCALE, LOCALE_STORAGE_KEY, LOCALES, type Locale } from './types';

export interface I18nContextValue {
  locale: Locale;
  setLocale(next: Locale): void;
  toggleLocale(): void;
  t: TFunction;
}

// Provider 外使用时（如单独渲染组件的测试）得到默认中文，切换为空操作。
const DEFAULT_CONTEXT: I18nContextValue = {
  locale: DEFAULT_LOCALE,
  setLocale: () => {},
  toggleLocale: () => {},
  t: createT(DEFAULT_LOCALE),
};

const I18nContext = createContext<I18nContextValue>(DEFAULT_CONTEXT);

const HTML_LANG: Record<Locale, string> = { zh: 'zh-CN', en: 'en' };

function readStoredLocale(): Locale {
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    return LOCALES.includes(stored as Locale) ? (stored as Locale) : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

export function LocaleProvider(props: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(readStoredLocale);

  useEffect(() => {
    document.documentElement.lang = HTML_LANG[locale];
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      // 忽略写入失败（隐私模式等），本次会话内切换仍然生效
    }
  }, []);

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale,
      toggleLocale: () => setLocale(locale === 'zh' ? 'en' : 'zh'),
      t: createT(locale),
    }),
    [locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{props.children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}
