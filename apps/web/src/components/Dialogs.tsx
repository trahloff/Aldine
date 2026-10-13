import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import Modal from './Modal';

export interface ConfirmOptions {
  title: string;
  body?: string;
  /** Names the action: "Delete branch", not "OK". */
  confirmLabel: string;
  /** The action destroys something: the button is red. */
  danger?: boolean;
}

export interface PromptOptions {
  title: string;
  value?: string;
  confirmLabel: string;
  /** Select only this many leading characters of the value (a file's stem, not its extension). */
  selectTo?: number;
}

interface Dialogs {
  /** Resolves true when confirmed; false on Cancel, Escape or a click outside. */
  confirm(o: ConfirmOptions): Promise<boolean>;
  /** Resolves the entered text; null on Cancel, Escape or a click outside. */
  prompt(o: PromptOptions): Promise<string | null>;
}

type Open =
  | { kind: 'confirm'; o: ConfirmOptions; done(v: boolean): void }
  | { kind: 'prompt'; o: PromptOptions; done(v: string | null): void };

const Ctx = createContext<Dialogs>({ confirm: async () => false, prompt: async () => null });

export function useDialogs(): Dialogs {
  return useContext(Ctx);
}

/**
 * The app's own question and rename dialogs, in place of the browser's
 * confirm() and prompt(): themed, non-blocking, and able to name the action.
 */
export function DialogProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState<Open | null>(null);
  const [text, setText] = useState('');
  const api = useRef<Dialogs>({
    confirm: (o) => new Promise<boolean>((done) => setOpen({ kind: 'confirm', o, done })),
    prompt: (o) => new Promise<string | null>((done) => { setText(o.value ?? ''); setOpen({ kind: 'prompt', o, done }); }),
  });

  const cancel = useCallback(() => {
    setOpen((cur) => {
      if (cur?.kind === 'confirm') cur.done(false);
      else cur?.done(null);
      return null;
    });
  }, []);
  const accept = () => {
    if (!open) return;
    if (open.kind === 'confirm') open.done(true);
    else open.done(text);
    setOpen(null);
  };

  return (
    <Ctx.Provider value={api.current}>
      {children}
      {open && (
        <Modal onClose={cancel} label={open.o.title} testId="app-dialog">
          <form onSubmit={(e) => { e.preventDefault(); accept(); }}>
            <h2 data-testid="dialog-title">{open.o.title}</h2>
            {open.kind === 'confirm' && open.o.body && <p className="modal__sub" data-testid="dialog-message">{open.o.body}</p>}
            {open.kind === 'prompt' && (
              <input
                className="input"
                style={{ marginTop: 10 }}
                value={text}
                aria-label={open.o.title}
                data-testid="dialog-input"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setText(e.target.value)}
                onFocus={(e) => e.target.setSelectionRange(0, open.o.selectTo ?? e.target.value.length)}
              />
            )}
            <div className="modal__row">
              <button type="button" className="btn" onClick={cancel} data-testid="dialog-cancel">Cancel</button>
              <button
                type="submit"
                className={`btn ${open.kind === 'confirm' && open.o.danger ? 'btn--danger' : 'btn--primary'}`}
                disabled={open.kind === 'prompt' && !text.trim()}
                data-testid="dialog-confirm"
              >
                {open.o.confirmLabel}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </Ctx.Provider>
  );
}
