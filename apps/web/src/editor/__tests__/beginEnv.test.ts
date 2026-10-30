import { describe, it, expect } from 'vitest';
import { EditorState, type TransactionSpec } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { closeBrackets } from '@codemirror/autocomplete';
import { closeBeginBraceInput } from '../beginEnv';

/** Text typed as input events, as a `}` needing Option arrives: no key
 *  binding runs, only the input handlers, then the plain insertion. */
function typeText(doc: string, text: string, extensions = [closeBeginBraceInput, closeBrackets()]) {
  let state = EditorState.create({ doc, selection: { anchor: doc.length }, extensions });
  const view = { get state() { return state; }, dispatch(spec: TransactionSpec) { state = state.update(spec).state; } };
  for (const ch of text) {
    const { from, to } = state.selection.main;
    const handled = state.facet(EditorView.inputHandler).some((h) => h(view as unknown as EditorView, from, to, ch, () => state.update({})));
    if (!handled) view.dispatch(state.replaceSelection(ch));
  }
  return state;
}

describe('closing \\begin{…} with a } typed as text', () => {
  it('closes the environment once when the } needs Option', () => {
    const s = typeText('', '\\begin{itemize}');
    expect(s.doc.toString()).toBe('\\begin{itemize}\n  \n\\end{itemize}');
    expect(s.selection.main.head).toBe('\\begin{itemize}\n  '.length);
  });

  it('keeps the indentation of the line', () => {
    const s = typeText('  ', '\\begin{enumerate}');
    expect(s.doc.toString()).toBe('  \\begin{enumerate}\n    \n  \\end{enumerate}');
  });

  it('only steps over the brace anywhere else', () => {
    expect(typeText('', '\\textbf{x}').doc.toString()).toBe('\\textbf{x}');
  });

  it('left out, closeBrackets steps over the brace and the environment stays open', () => {
    expect(typeText('', '\\begin{itemize}', [closeBrackets()]).doc.toString()).toBe('\\begin{itemize}');
  });
});
