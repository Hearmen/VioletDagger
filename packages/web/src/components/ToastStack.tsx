import type { Toast } from '../hooks/useToasts';
import { useI18n } from '../i18n/LocaleProvider';
import { renderText } from '../i18n/types';

export function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  const { t } = useI18n();
  if (toasts.length === 0) return null;
  return (
    <div className="toasts">
      {toasts.map((toast) => (
        <div key={toast.id} role="alert" className="toast">
          <span>{renderText(toast.message, t)}</span>
          <button className="ghost" onClick={() => onDismiss(toast.id)}>
            {t('common.close')}
          </button>
        </div>
      ))}
    </div>
  );
}
