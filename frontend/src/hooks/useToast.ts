import { useState, useCallback } from 'react';
import type { ToastType } from '../types/ui';

/** Active toast payload shown by `<Toast />`. */
interface ToastState {
  id: number;
  message: string;
  type?: ToastType;
}

/** Minimal global toast queue: show, clear, and current message state. */
export function useToast() {
  const [toast, setToast] = useState<ToastState | null>(null);

  const showToast = useCallback((message: string, type: ToastType = 'error') => {
    setToast({ id: Date.now(), message, type });
  }, []);

  const clearToast = useCallback(() => {
    setToast(null);
  }, []);

  return { toast, showToast, clearToast };
}
