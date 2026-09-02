import React, { createContext, useCallback, useContext, useState } from 'react';

export interface ToastAction { label: string; onClick: () => void; testId?: string }

interface Toast { id: number; text: string; kind?: 'info' | 'error' | 'ok'; action?: ToastAction }

const ToastCtx = createContext<(text: string, kind?: Toast['kind'], action?: ToastAction) => void>(() => {});

export function useToast() {
  return useContext(ToastCtx);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: Toast['kind'] = 'info', action?: ToastAction) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind, action }]);
    // a toast carrying an action needs time to be acted on
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), action ? 8000 : 3400);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            {t.kind === 'error' ? <span className="dot dot--error" /> : t.kind === 'ok' ? <span className="dot dot--ok" /> : null}
            {t.text}
            {t.action && (
              <button
                className="btn btn--small"
                data-testid={t.action.testId}
                onClick={() => {
                  setToasts((cur) => cur.filter((x) => x.id !== t.id));
                  t.action!.onClick();
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
