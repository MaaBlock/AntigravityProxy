export type ToastType = "info" | "success" | "warning" | "error";

export interface Toast {
  id: number;
  type: ToastType;
  message: string;
}

type ToastListener = (toast: Toast) => void;
const listeners = new Set<ToastListener>();

export const notify = (type: ToastType, message: string) => {
  const toast: Toast = { id: Date.now() + Math.random(), type, message };
  listeners.forEach((fn) => fn(toast));
};

export const subscribeToasts = (fn: ToastListener) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
