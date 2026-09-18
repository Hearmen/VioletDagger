import type { Toast } from '../hooks/useToasts';

export function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div className="toasts">
      {toasts.map((toast) => (
        <div key={toast.id} role="alert" className="toast">
          <span>{toast.message}</span>
          <button className="ghost" onClick={() => onDismiss(toast.id)}>
            关闭
          </button>
        </div>
      ))}
    </div>
  );
}
