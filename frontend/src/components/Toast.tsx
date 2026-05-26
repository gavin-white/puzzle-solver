import { useEffect } from 'react';
import type { ToastType } from '../types/ui';
import './Toast.css';

interface ToastProps {
  message: string;
  type?: ToastType;
  onClose: () => void;
  duration?: number;
}

/** Dismissible timed banner for errors, success, or info toasts. */
export function Toast({ message, type = 'error', onClose, duration = 5000 }: ToastProps) {
  const labelByType = {
    error: 'Error',
    success: 'Success',
    info: 'Info',
  } as const;

  useEffect(() => {
    const timer = setTimeout(() => {
      onClose();
    }, duration);

    return () => clearTimeout(timer);
  }, [onClose, duration]);

  return (
    <div className={`toast toast-${type}`}>
      <div className="toast-content">
        <div className="toast-icon" aria-hidden>
          {type === 'error' && (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="13" />
              <line x1="12" y1="16" x2="12.01" y2="16" strokeWidth="3" strokeLinecap="round" />
            </svg>
          )}
          {type === 'success' && (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <polyline points="8 12.5 11 15.5 16.5 9.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
          {type === 'info' && (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="10" x2="12" y2="16" strokeLinecap="round" />
              <line x1="12" y1="7" x2="12.01" y2="7" strokeWidth="3" strokeLinecap="round" />
            </svg>
          )}
        </div>
        <div className="toast-text">
          <span className="toast-label">{labelByType[type]}</span>
          <span className="toast-message">{message}</span>
        </div>
        <button className="toast-close" onClick={onClose} aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  );
}

