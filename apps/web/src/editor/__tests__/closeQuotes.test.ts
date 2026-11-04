import { describe, it, expect } from 'vitest';
import { EditorState, type Extension, type TransactionSpec } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { closeBrackets } from '@codemirror/autocomplete';
import { latex } from 'codemirror-lang-latex';
import { latexCloseBrackets } from '../latexExtras';

/** Types `text` one character at a time as input events: input handlers first, then plain insertion. */
function typeText(text: string, extensions: Extension[]) {
  let state = EditorState.create({ doc: '', extensions });
  const view = { get state() { return state; }, dispatch(spec: TransactionSpec) { state = state.update(spec).state; } };
  for (const ch of text) {
    const { from, to } = state.selection.main;
    const handled = state.facet(EditorView.inputHandler).some((h) => h(view as unknown as EditorView, from, to, ch, () => state.update({})));
    if (!handled) view.dispatch(state.replaceSelection(ch));
  }
  const head = state.selection.main.head, doc = state.doc.toString();
  return doc.slice(0, head) + '|' + doc.slice(head);
}

const editor = (path = 'main.tex') => [latex({ enableLinting: false, enableAutocomplete: false, enableTooltips: false }), closeBrackets(), latexCloseBrackets(path)];

describe('typing LaTeX quotes and primes', () => {
  it('leaves no stray apostrophe after ``quoted\'\' or f\'\'', () => {
    expect(typeText("``quoted'' and", editor())).toBe("``quoted'' and|");
    expect(typeText("$f''(x)$", editor())).toBe("$f''(x)$|");
    expect(typeText('"`x"\'', editor())).toBe('"`x"\'|');
  });

  it('still pairs braces, brackets and parentheses', () => {
    expect(typeText('\\textbf{', editor())).toBe('\\textbf{|}');
    expect(typeText('[(', editor())).toBe('[(|)]');
  });

  it('pairs a " around a .bib field value', () => {
    expect(typeText('title = "', editor('refs.bib'))).toBe('title = "|"');
  });

  it('left out, the package pairs the quotes and a stray one is left behind', () => {
    const without = [latex({ enableLinting: false, enableAutocomplete: false, enableTooltips: false }), closeBrackets()];
    expect(typeText("``quoted''", without)).toBe("``quoted''|'");
  });
});
