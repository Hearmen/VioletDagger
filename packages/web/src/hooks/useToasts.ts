import { useCallback, useRef, useState } from 'react';

export interface Toast {
  id: number;
  message: string;
}

const TOAST_TTL_MS = 5000;

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextIdRef = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback((message: string) => {
    const id = nextIdRef.current++;
    setToasts((prev) => [...prev, { id, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, TOAST_TTL_MS);
  }, []);

  return { toasts, push, dismiss };
}
