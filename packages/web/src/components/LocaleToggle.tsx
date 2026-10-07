import { useI18n } from '../i18n/LocaleProvider';

// 显示切换目标语言（09-frontend-i18n.md §4）。
export function LocaleToggle() {
  const { t, toggleLocale } = useI18n();
  const label = t('common.localeToggleLabel');
  return (
    <button type="button" className="ghost locale-toggle" onClick={toggleLocale} aria-label={label} title={label}>
      {t('common.localeToggleTarget')}
    </button>
  );
}
