export type ToastType = 'error' | 'success' | 'info';

export type ShowToast = (message: string, type?: ToastType) => void;
