import { Prec, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { yUndoManagerKeymap } from 'y-codemirror.next';

/**
 * Vim keybindings, loaded on first use: the package is a chunk of its own,
 * so a browser that never turns them on never downloads them.
 */
let loading: Promise<Extension> | null = null;
let loaded: Extension | null = null;

/** The extension once a load has finished, for a pane that mounts afterwards
 *  and should start in Vim without waiting a tick. */
export const vimIfLoaded = (): Extension | null => loaded;

const theme = EditorView.theme({
  '.cm-fat-cursor': { background: 'var(--accent)', color: 'var(--on-accent) !important' },
  '&:not(.cm-focused) .cm-fat-cursor': { background: 'none', outline: 'solid 1px var(--accent)', color: 'transparent !important' },
  '.cm-vim-panel': { fontFamily: 'var(--font-mono)', fontSize: 'var(--text-s)', color: 'var(--text-2)', minHeight: '22px', alignItems: 'center' },
  '.cm-vim-panel input': { color: 'var(--text)', fontFamily: 'inherit', fontSize: 'inherit' },
});

export function loadVim(): Promise<Extension> {
  loading ??= import('@replit/codemirror-vim').then(({ vim, CodeMirror }) => {
    // Undo is Yjs's here (y-codemirror's UndoManager, per user, never
    // undoing a collaborator's typing); the package's u and Ctrl-R would
    // call CodeMirror's history, which this editor does not have.
    const command = (key: string) => yUndoManagerKeymap.find((b) => b.key === key)!.run!;
    const undo = command('Mod-z'), redo = command('Mod-Shift-z');
    CodeMirror.commands.undo = (cm) => { undo(cm.cm6); };
    CodeMirror.commands.redo = (cm) => { redo(cm.cm6); };
    // Highest precedence: in normal mode every key is a command, and no other
    // keymap (the \begin{} brace closer, Visual's keys) may see it first.
    loaded = Prec.highest([theme, vim({ status: true })]);
    return loaded;
  }).catch((err) => {
    loading = null; // a later toggle tries the download again
    throw err;
  });
  return loading;
}
