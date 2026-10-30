import { Prec, type EditorState, type TransactionSpec } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

/**
 * The `}` that finishes `\begin{name` while closeBrackets' own `}` already
 * sits after the caret: step over that brace and close the environment.
 * codemirror-lang-latex's `}` handler inserts a second brace instead, which
 * ends up stranded after `\end{name}` (an "Extra }" at the next compile).
 */
export function closeBeginBrace(view: { state: EditorState; dispatch(spec: TransactionSpec): void }): boolean {
  const { state } = view;
  if (state.selection.ranges.length > 1) return false;
  const sel = state.selection.main;
  if (!sel.empty || state.sliceDoc(sel.head, sel.head + 1) !== '}') return false;
  const line = state.doc.lineAt(sel.head);
  const m = /\\begin\{([^}]+)$/.exec(state.sliceDoc(line.from, sel.head));
  if (!m) return false;
  const indent = /^\s*/.exec(line.text)![0];
  const after = sel.head + 1;
  view.dispatch({
    changes: { from: after, insert: `\n${indent}  \n${indent}\\end{${m[1]}}` },
    selection: { anchor: after + 1 + indent.length + 2 },
    scrollIntoView: true,
    userEvent: 'input.type',
  });
  return true;
}

/**
 * closeBeginBrace for a `}` that arrives as typed text instead of through the
 * key binding: CodeMirror matches no `}` binding when the character needs
 * Option (macOS German and similar layouts), and closeBrackets' own input
 * handler would only step over its brace, leaving the environment unclosed.
 */
export const closeBeginBraceInput = Prec.high(EditorView.inputHandler.of((view, from, to, text) =>
  text === '}' && from === to && view.state.selection.main.head === from && closeBeginBrace(view)));
