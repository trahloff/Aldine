import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import Modal from './Modal';

export interface ConfirmOptions {
  title: string;
  body?: string;
  /** Names the action: "Delete branch", not "OK". */
  confirmLabel: string;
  /** Names the way out, "Cancel" unless set. */
  cancelLabel?: string;
  /** The action destroys something or cannot be taken back: the button is
   *  red and the way out has the focus, so Enter takes that. Otherwise Enter
   *  takes the action, as the blue button promises. */
  danger?: boolean;
}

export interface PromptOptions {
  title: string;
  /** A sentence under the title: what the text is for. */
  body?: string;
  value?: string;
  placeholder?: string;
  confirmLabel: string;
  /** Where the selection starts, 0 if unset: a file's name, after the folder it is in. */
  selectFrom?: number;
  /** Where the selection ends, the end if unset: before a file's extension. */
  selectTo?: number;
}

export interface Dialogs {
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
  const confirmRef = useRef<HTMLButtonElement>(null);
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
        <Modal onClose={cancel} label={open.o.title} testId="app-dialog" initialFocus={open.kind === 'confirm' && !open.o.danger ? confirmRef : 'first'}>
          <form onSubmit={(e) => { e.preventDefault(); accept(); }}>
            <h2 data-testid="dialog-title">{open.o.title}</h2>
            {open.o.body && <p className="modal__sub" data-testid="dialog-message">{open.o.body}</p>}
            {open.kind === 'prompt' && (
              <input
                className="input"
                style={{ marginTop: 10 }}
                value={text}
                placeholder={open.o.placeholder}
                aria-label={open.o.title}
                data-testid="dialog-input"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setText(e.target.value)}
                onFocus={(e) => e.target.setSelectionRange(open.o.selectFrom ?? 0, open.o.selectTo ?? e.target.value.length)}
              />
            )}
            <div className="modal__row">
              <button type="button" className="btn" onClick={cancel} data-testid="dialog-cancel">{(open.kind === 'confirm' && open.o.cancelLabel) || 'Cancel'}</button>
              <button
                ref={confirmRef}
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
