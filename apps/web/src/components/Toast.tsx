import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

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

interface Toast { id: number; text: string; kind?: 'info' | 'error' | 'ok'; action?: ToastAction; ms?: number; leaving?: boolean }

/** Matches .toast--out in app.css. */
const EXIT_MS = 160;

const ToastCtx = createContext<(text: string, kind?: Toast['kind'], action?: ToastAction) => void>(() => {});

export function useToast() {
  return useContext(ToastCtx);
}

const DismissCtx = createContext<(key: string) => void>(() => {});

/** Takes down the toast whose action carries `key`: its Undo was done another way (a shortcut). */
export function useToastDismiss() {
  return useContext(DismissCtx);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  /** Play the exit, then drop the toast. */
  const dismiss = useCallback((id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((t) => t.map((x) => (x.id === id ? { ...x, leaving: true } : x)));
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), EXIT_MS);
  }, []);
  const arm = useCallback((id: number, ms: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.set(id, setTimeout(() => dismiss(id), ms));
  }, [dismiss]);
  /** A toast under the pointer (or holding focus) is being read: its clock
   *  stops and starts over when the pointer leaves. */
  const hold = (id: number) => { clearTimeout(timers.current.get(id)); timers.current.delete(id); };

  useEffect(() => () => { timers.current.forEach((t) => clearTimeout(t)); }, []);

  const push = useCallback((text: string, kind: Toast['kind'] = 'info', action?: ToastAction) => {
    const id = Date.now() + Math.random();
    // a toast carrying an action needs time to be acted on; a sticky one waits.
    // An error carries a sentence to read and usually something to do about
    // it, so it stays about twice as long as a confirmation.
    const ms = action?.sticky ? undefined : action ? 8000 : kind === 'error' ? 7000 : 3400;
    setToasts((t) => [...(action?.key ? t.filter((x) => x.action?.key !== action.key) : t), { id, text, kind, action, ms }]);
    if (ms) arm(id, ms);
  }, [arm]);
  const shown = useRef(toasts);
  shown.current = toasts;
  const dismissKey = useCallback((key: string) => {
    shown.current.filter((x) => x.action?.key === key && !x.leaving).forEach((x) => dismiss(x.id));
  }, [dismiss]);
  return (
    <ToastCtx.Provider value={push}>
     <DismissCtx.Provider value={dismissKey}>
      {children}
      {/* A named landmark: a screen reader can jump straight to the notifications and their Undo. */}
      <section className="toasts" role="region" aria-label="Notifications" aria-live="polite" data-testid="toasts">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast${t.leaving ? ' toast--out' : ''}`}
            onPointerEnter={() => hold(t.id)}
            onPointerLeave={() => { if (t.ms && !t.leaving) arm(t.id, t.ms); }}
            onFocus={() => hold(t.id)}
            onBlur={() => { if (t.ms && !t.leaving) arm(t.id, t.ms); }}
          >
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
                    dismiss(t.id);
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
                      dismiss(t.id);
                      t.action!.onDismiss?.();
                    }}
                  >×</button>
                )}
              </span>
            )}
          </div>
        ))}
      </section>
     </DismissCtx.Provider>
    </ToastCtx.Provider>
  );
}
