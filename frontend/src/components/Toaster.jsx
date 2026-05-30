// Toaster: transient, severity-colored toasts for newly raised alerts.
// Each toast auto-dismisses after a few seconds (longer for critical).
import React, { useEffect } from 'react';
import { fmtClock } from '../format.js';

function Toast({ toast, onDismiss }) {
  useEffect(() => {
    const ttl = toast.severity === 'critical' ? 8000 : toast.severity === 'warning' ? 6000 : 4000;
    const id = setTimeout(() => onDismiss(toast.toastId), ttl);
    return () => clearTimeout(id);
  }, [toast.toastId, toast.severity, onDismiss]);

  return (
    <div className={`toast sev-${toast.severity}`} role="alert">
      <div className="toast-head">
        <span className="toast-type">{toast.type.toUpperCase()}</span>
        <span className="toast-ex muted small">{toast.exchange}</span>
        <button className="toast-close" onClick={() => onDismiss(toast.toastId)} aria-label="Dismiss">
          ×
        </button>
      </div>
      <div className="toast-msg">{toast.message}</div>
      <div className="toast-time muted tiny">{fmtClock(toast.ts)}</div>
    </div>
  );
}

export function Toaster({ toasts, onDismiss }) {
  return (
    <div className="toaster" aria-live="polite">
      {toasts.map((t) => (
        <Toast key={t.toastId} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
