import { EditorSelection, EditorState, type Extension, type StateEffect } from '@codemirror/state';
import { EditorView, showDialog, type Command, type KeyBinding } from '@codemirror/view';
import { gotoLine, search, searchKeymap, SearchQuery, setSearchQuery } from '@codemirror/search';
import { safeStorage } from '../util/safeStorage';

/** Match case, whole word and regex: the project search panel's key, so both finds share them. */
const TOGGLES = 'aldine.search';

/** The last query of any file's Find: a pane is rebuilt for every file, its search state with it. */
let lastQuery: SearchQuery | null = null;

function storedToggles(): { caseSensitive: boolean; wholeWord: boolean; regexp: boolean } {
  const v = safeStorage.getJSON<{ case?: unknown; word?: unknown; regex?: unknown } | null>(TOGGLES, {});
  return { caseSensitive: v?.case === true, wholeWord: v?.word === true, regexp: v?.regex === true };
}

function remember(query: SearchQuery): void {
  lastQuery = query;
  const t = storedToggles();
  if (t.caseSensitive !== query.caseSensitive || t.wholeWord !== query.wholeWord || t.regexp !== query.regexp) {
    safeStorage.setJSON(TOGGLES, { case: query.caseSensitive, word: query.wholeWord, regex: query.regexp });
  }
}

const literal = (q: SearchQuery) => new SearchQuery({
  search: q.search, replace: q.replace, caseSensitive: q.caseSensitive, regexp: q.regexp, wholeWord: q.wholeWord, test: q.test, literal: true,
});

/**
 * Every query is literal, as in project search: unquoted, `\noindent` looks
 * for a newline and a replacement `\textit` writes a tab. The panel builds
 * each query it commits without `literal`, so search()'s option alone is
 * lost at the first keystroke; the literal copy comes last and wins.
 * (SearchQuery.eq ignores `literal`, so the panel does not answer it.)
 */
const literalQueries = EditorState.transactionExtender.of((tr) => {
  const loose = tr.effects.filter((e): e is StateEffect<SearchQuery> => e.is(setSearchQuery) && !e.value.literal);
  return loose.length ? { effects: loose.map((e) => setSearchQuery.of(literal(e.value))) } : null;
});

const rememberQuery = EditorView.updateListener.of((u) => {
  for (const tr of u.transactions) for (const e of tr.effects) if (e.is(setSearchQuery)) remember(e.value);
});

const findPhrases = EditorState.phrases.of({
  Replace: 'Replace with',
  next: 'Next',
  previous: 'Previous',
  all: 'Select all matches',
  'match case': 'Match case',
  regexp: 'Regular expression',
  'by word': 'Whole word',
  replace: 'Replace',
  'replace all': 'Replace all',
  close: 'Close',
  go: 'Go',
});

/**
 * CodeMirror's own field and button styles are for a light page (a white
 * field under the panel's inherited near-white text in the dark theme) and
 * 70% of the editor's size, which iOS zooms in on.
 */
const findTheme = EditorView.theme({
  '.cm-panel.cm-search': { padding: '6px 40px 6px 8px', fontFamily: 'var(--font-ui)', fontSize: 'var(--text-m)' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label': { margin: '3px 6px 3px 0' },
  '.cm-textfield': {
    height: '28px', padding: '0 8px', verticalAlign: 'middle',
    border: '1px solid var(--hairline-strong)', borderRadius: 'var(--radius-m)',
    backgroundColor: 'var(--bg-panel)', color: 'var(--text)', caretColor: 'var(--text)',
    fontFamily: 'var(--font-mono)', fontSize: 'var(--text-m)',
  },
  '.cm-textfield::placeholder': { color: 'var(--text-3)' },
  '.cm-textfield:focus': { outline: 'none', borderColor: 'var(--accent)', boxShadow: '0 0 0 3px var(--accent-soft)' },
  '.cm-button': {
    height: '28px', padding: '0 10px', verticalAlign: 'middle',
    border: '1px solid var(--hairline-strong)', borderRadius: 'var(--radius-m)',
    backgroundColor: 'var(--bg-panel)', backgroundImage: 'none', color: 'var(--text)',
    fontFamily: 'var(--font-ui)', fontSize: 'var(--text-m)', fontWeight: '500', cursor: 'pointer',
  },
  '.cm-button:active': { backgroundImage: 'none', backgroundColor: 'var(--bg-active)' },
  '.cm-button:focus-visible': { outline: '2px solid var(--accent)', outlineOffset: '1px' },
  '.cm-panel.cm-search label': {
    display: 'inline-flex', alignItems: 'center', gap: '5px', verticalAlign: 'middle',
    fontSize: 'var(--text-s)', color: 'var(--text-2)', cursor: 'pointer',
  },
  '.cm-panel.cm-search input[type=checkbox]': { margin: '0', accentColor: 'var(--accent-fill)' },
  '.cm-panel.cm-search [name=close]': {
    top: '6px', right: '6px', width: '28px', height: '28px', borderRadius: 'var(--radius-m)',
    color: 'var(--text-2)', fontSize: '18px', lineHeight: '28px', cursor: 'pointer',
  },
  '.cm-panel.cm-search [name=close]:focus-visible': { outline: '2px solid var(--accent)', outlineOffset: '1px' },
  '.cm-searchMatch': { backgroundColor: 'var(--warn-soft)', borderRadius: '2px' },
  // the selected match is the editor's selection too, drawn beneath it
  '.cm-searchMatch-selected': { backgroundColor: 'transparent', outline: '1px solid var(--accent)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--accent-soft)' },
  '@media (hover: hover) and (pointer: fine)': {
    '.cm-button:hover': { backgroundColor: 'var(--bg-hover)' },
    '.cm-panel.cm-search [name=close]:hover': { backgroundColor: 'var(--bg-hover)', color: 'var(--text)' },
  },
  // iOS zooms the page when a focused field's text is under 16px; a finger needs 44px
  '@media (pointer: coarse)': {
    '.cm-textfield': { height: '44px', fontSize: '16px' },
    '.cm-button': { height: '44px' },
    '.cm-panel.cm-search': { paddingRight: '52px' },
    '.cm-panel.cm-search [name=close]': { width: '44px', height: '44px', lineHeight: '44px' },
  },
});

/** In-file Find (Mod-F): above the text, literal, and with the toggles project search uses. */
export function findPanel(): Extension {
  return [search({ top: true, literal: true, ...storedToggles() }), literalQueries, rememberQuery, findPhrases, findTheme];
}

/**
 * Go to line, above the text like Find: CodeMirror's own opens below it. It
 * takes what CodeMirror's takes: a line, +n or -n lines from the cursor, a
 * percentage of the document, and :column after any of them.
 */
export const gotoLineTop: Command = (view) => {
  const { close, result } = showDialog(view, {
    label: view.state.phrase('Go to line'),
    input: { type: 'text', name: 'line', value: String(view.state.doc.lineAt(view.state.selection.main.head).number) },
    focus: true,
    submitLabel: view.state.phrase('go'),
    top: true,
  });
  result.then((form) => {
    const field = form?.elements.namedItem('line') as HTMLInputElement | null;
    const match = field && /^([+-])?(\d+)?(:\d+)?(%)?$/.exec(field.value);
    if (!match) { view.dispatch({ effects: close }); return; }
    // The document as it is now: collaborators may have edited it while the dialog was open.
    const { state } = view;
    const start = state.doc.lineAt(state.selection.main.head);
    const [, sign, ln, cl, percent] = match;
    const col = cl ? +cl.slice(1) : 0;
    let line = ln ? +ln : start.number;
    if (ln && percent) {
      let pc = line / 100;
      if (sign) pc = pc * (sign === '-' ? -1 : 1) + start.number / state.doc.lines;
      line = Math.round(state.doc.lines * pc);
    } else if (ln && sign) {
      line = line * (sign === '-' ? -1 : 1) + start.number;
    }
    const to = state.doc.line(Math.max(1, Math.min(state.doc.lines, line)));
    const selection = EditorSelection.cursor(to.from + Math.max(0, Math.min(col, to.length)));
    view.dispatch({ effects: [close, EditorView.scrollIntoView(selection.from, { y: 'center' })], selection });
  });
  return true;
};

/** CodeMirror's search keys, with Mod-Alt-G opening Go to line above the text. */
export const findKeymap: readonly KeyBinding[] = searchKeymap.map((b) => (b.run === gotoLine ? { ...b, run: gotoLineTop } : b));

/** Carries the last Find query into a pane just built for another file. */
export function restoreFind(view: EditorView): void {
  if (lastQuery) view.dispatch({ effects: setSearchQuery.of(lastQuery) });
}
