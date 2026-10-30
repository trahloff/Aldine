import { describe, it, expect, vi } from 'vitest';
import { EditorState, type TransactionSpec } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { autocompletion, CompletionContext, completionStatus, type Completion, type CompletionResult, type CompletionSource } from '@codemirror/autocomplete';
import { latexCompletionSource } from 'codemirror-lang-latex';
import { keyCommandCompletionSource, withoutKeyCommands, keyBraceGuard, citeCompletionSource, refCompletionSource } from '../latexExtras';

vi.mock('../../api', () => ({
  api: {
    bib: async () => [{ key: 'turing1950', type: 'article', author: 'Turing, Alan', title: 'Computing Machinery', year: '1950', file: 'refs.bib' }],
    labels: async () => [{ label: 'sec:intro', file: 'main.tex' }],
  },
}));

const sources: CompletionSource[] = [
  withoutKeyCommands(latexCompletionSource(true)),
  keyCommandCompletionSource,
  citeCompletionSource('p', 'main'),
  refCompletionSource('p', 'main', () => 'main.tex'),
];

/** Enough of an EditorView for a completion's apply and for startCompletion. */
class View {
  state: EditorState;
  constructor(marked: string) {
    const at = marked.indexOf('|');
    this.state = EditorState.create({
      doc: marked.slice(0, at) + marked.slice(at + 1),
      selection: { anchor: at },
      extensions: [autocompletion({ override: sources }), keyBraceGuard],
    });
  }
  dispatch(spec: TransactionSpec) { this.state = this.state.update(spec).state; }
  get marked() {
    const text = this.state.doc.toString(), head = this.state.selection.main.head;
    return text.slice(0, head) + '|' + text.slice(head);
  }
  /** Every option the sources offer at the caret, as the list would merge them. */
  async options(explicit = false): Promise<Array<{ option: Completion; result: CompletionResult }>> {
    const ctx = new CompletionContext(this.state, this.state.selection.main.head, explicit);
    const out: Array<{ option: Completion; result: CompletionResult }> = [];
    for (const source of sources) {
      const result = await source(ctx);
      if (result) for (const option of result.options) out.push({ option, result });
    }
    return out;
  }
  async accept(label: string) {
    const found = (await this.options()).filter(({ option }) => option.label === label);
    expect(found, `one ${label} in the list`).toHaveLength(1);
    const [{ option, result }] = found;
    const to = this.state.selection.main.head;
    if (typeof option.apply === 'function') option.apply(this as unknown as EditorView, option, result.from, to);
    else this.dispatch({ changes: { from: result.from, to, insert: option.apply ?? option.label } });
  }
  /** Types `text` the way a keystroke does: input handlers first, then plain insertion. */
  type(text: string) {
    const { from, to } = this.state.selection.main;
    const handled = this.state.facet(EditorView.inputHandler).some((h) => h(this as unknown as EditorView, from, to, text, () => this.state.update({})));
    if (!handled) this.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
  }
}

describe('\\cite and \\ref completions bring their braces (#223)', () => {
  it('inserts \\cite{} with the caret inside and lists the keys at once', async () => {
    const view = new View('See \\ci|');
    await view.accept('\\cite');
    expect(view.marked).toBe('See \\cite{|}');
    expect(completionStatus(view.state)).toBe('pending');
    const keys = (await view.options(true)).map(({ option }) => option.label);
    expect(keys).toEqual(['turing1950']);
  });

  it('hops over the closing brace when a key is accepted', async () => {
    const view = new View('See \\ci|');
    await view.accept('\\cite');
    await view.accept('turing1950');
    expect(view.marked).toBe('See \\cite{turing1950}|');
  });

  it('offers each cite and ref command once, the package\'s own included', async () => {
    const labels = (await new View('\\|').options()).map(({ option }) => option.label);
    for (const cmd of ['\\cite', '\\citep', '\\citet', '\\parencite', '\\textcite', '\\autocite', '\\footcite', '\\citeauthor', '\\citeyear', '\\nocite',
      '\\ref', '\\eqref', '\\cref', '\\Cref', '\\autoref', '\\pageref']) {
      expect(labels.filter((l) => l === cmd), cmd).toHaveLength(1);
    }
    // the rest of the package's list is still there
    expect(labels).toContain('\\section');
    expect(labels).toContain('\\label');
  });

  it('lists keys after every cite command and labels after every ref command it offers', async () => {
    for (const cmd of ['\\citep', '\\parencite', '\\textcite', '\\autocite', '\\footcite', '\\fullcite', '\\citeauthor', '\\nocite']) {
      const view = new View(`${cmd.slice(0, 3)}|`);
      await view.accept(cmd);
      expect(view.marked).toBe(`${cmd}{|}`);
      expect((await view.options(true)).map(({ option }) => option.label), cmd).toEqual(['turing1950']);
    }
    for (const cmd of ['\\ref', '\\eqref', '\\cref', '\\Cref', '\\autoref', '\\pageref']) {
      const view = new View(`${cmd.slice(0, 2)}|`);
      await view.accept(cmd);
      expect(view.marked).toBe(`${cmd}{|}`);
      expect((await view.options(true)).map(({ option }) => option.label), cmd).toEqual(['sec:intro']);
    }
  });

  it('drops a { typed between the braces it inserted', async () => {
    const view = new View('See \\ci|');
    await view.accept('\\cite');
    view.type('{');
    expect(view.marked).toBe('See \\cite{|}');
    view.type('t');
    expect(view.marked).toBe('See \\cite{t|}');
  });

  it('types { as usual outside an empty key argument', () => {
    const plain = new View('\\textbf{|}');
    plain.type('{');
    expect(plain.marked).toBe('\\textbf{{|}');
    const optional = new View('\\cite[p.~3]|');
    optional.type('{');
    expect(optional.marked).toBe('\\cite[p.~3]{|');
  });

  it('renames the command of an existing citation without adding braces', async () => {
    for (const [before, after] of [['\\ci|{turing1950}', '\\citep|{turing1950}'], ['\\ci|[p.~3]{turing1950}', '\\citep|[p.~3]{turing1950}']]) {
      const view = new View(before);
      await view.accept('\\citep');
      expect(view.marked).toBe(after);
      expect(completionStatus(view.state)).toBeNull();
    }
  });

  it('completes keys in a citation typed by hand with an optional argument', async () => {
    const view = new View('\\cite[p.~3]{tur|}');
    expect((await view.options()).map(({ option }) => option.label)).toEqual(['turing1950']);
    await view.accept('turing1950');
    expect(view.marked).toBe('\\cite[p.~3]{turing1950}|');
  });
});
