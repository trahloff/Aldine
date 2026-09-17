import React, { createContext, useCallback, useContext, useState } from 'react';

export interface ToastAction {
  label: string;
  onClick: () => void;
  testId?: string;
  /** Stay until acted on or dismissed — for a review prompt that arrives
   *  when nobody is looking at the screen. */
  sticky?: boolean;
  /** Runs when the × is used — the review prompt records the visit either way. */
  onDismiss?: () => void;
  /** A new toast with the same key replaces the one on screen instead of
   *  stacking under it — two review prompts for overlapping commit sets would
   *  otherwise sit side by side with nothing to tell them apart. */
  key?: string;
}

interface Toast { id: number; text: string; kind?: 'info' | 'error' | 'ok'; action?: ToastAction }

const ToastCtx = createContext<(text: string, kind?: Toast['kind'], action?: ToastAction) => void>(() => {});

export function useToast() {
  return useContext(ToastCtx);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: Toast['kind'] = 'info', action?: ToastAction) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...(action?.key ? t.filter((x) => x.action?.key !== action.key) : t), { id, text, kind, action }]);
    // a toast carrying an action needs time to be acted on; a sticky one waits.
    // An error carries a sentence to read and usually something to do about
    // it, so it stays about twice as long as a confirmation.
    if (action?.sticky) return;
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), action ? 8000 : kind === 'error' ? 7000 : 3400);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            <span className="toast__body">
              {t.kind === 'error' ? <span className="dot dot--error" /> : t.kind === 'ok' ? <span className="dot dot--ok" /> : null}
              <span className="toast__text">{t.text}</span>
            </span>
            {t.action && (
              <span className="toast__actions" data-testid="toast-actions">
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
                {t.action.sticky && (
                  <button
                    className="btn btn--ghost btn--small"
                    aria-label="Dismiss"
                    data-testid="toast-dismiss"
                    onClick={() => {
                      setToasts((cur) => cur.filter((x) => x.id !== t.id));
                      t.action!.onDismiss?.();
                    }}
                  >×</button>
                )}
              </span>
            )}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
