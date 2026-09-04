import React, { createContext, useCallback, useContext, useState } from 'react';

interface Toast { id: number; text: string; kind?: 'info' | 'error' | 'ok' }

const ToastCtx = createContext<(text: string, kind?: Toast['kind']) => void>(() => {});

export function useToast() {
  return useContext(ToastCtx);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    // An error carries a sentence to read and usually something to do about
    // it, so it stays about twice as long as a confirmation.
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 3400);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            {t.kind === 'error' ? <span className="dot dot--error" /> : t.kind === 'ok' ? <span className="dot dot--ok" /> : null}
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
