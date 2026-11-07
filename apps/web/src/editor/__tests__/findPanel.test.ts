import { describe, it, expect } from 'vitest';
import { EditorState, type TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { getSearchQuery, replaceAll, SearchQuery, setSearchQuery } from '@codemirror/search';
import { countMatches, findPanel, findStatusText } from '../findPanel';

/** What the find panel dispatches on each keystroke: a query built without `literal`. */
function committed(doc: string, search: string, replace = '') {
  const state = EditorState.create({ doc, extensions: [findPanel()] });
  return state.update({ effects: setSearchQuery.of(new SearchQuery({ search, replace })) }).state;
}

function matches(state: EditorState): string[] {
  const out: string[] = [];
  const cursor = getSearchQuery(state).getCursor(state);
  for (let r = cursor.next(); !r.done; r = cursor.next()) out.push(state.sliceDoc(r.value.from, r.value.to));
  return out;
}

describe('in-file Find is literal', () => {
  it('finds \\noindent and \\textbf as typed', () => {
    const doc = '\\noindent First.\n\\textbf{Bold} and \\\\ a break.';
    expect(matches(committed(doc, '\\noindent'))).toEqual(['\\noindent']);
    expect(matches(committed(doc, '\\textbf'))).toEqual(['\\textbf']);
    // \\ is the line break itself, not "any backslash"
    expect(matches(committed(doc, '\\\\'))).toEqual(['\\\\']);
  });

  it('replaces with \\textit as typed, not with a tab', () => {
    let state = committed('\\noindent First. \\noindent Second.', '\\noindent', '\\textit');
    const view = { get state() { return state; }, dispatch(spec: TransactionSpec) { state = state.update(spec).state; } };
    expect(replaceAll(view as unknown as EditorView)).toBe(true);
    expect(state.doc.toString()).toBe('\\textit First. \\textit Second.');
  });
});

describe('the match count beside the Find field', () => {
  const doc = 'alpha beta alpha gamma alpha';

  it('counts the matches and says which one is selected', () => {
    const state = committed(doc, 'alpha');
    const q = getSearchQuery(state);
    expect(countMatches(state, q)).toEqual({ total: 3, current: null, capped: false });
    expect(findStatusText(q, countMatches(state, q))).toBe('3 matches');
    const second = state.update({ selection: { anchor: 11, head: 16 } }).state;
    expect(countMatches(second, q)).toEqual({ total: 3, current: 2, capped: false });
    expect(findStatusText(q, countMatches(second, q))).toBe('2 of 3');
  });

  it('says No matches, one match, a capped count and a broken regular expression', () => {
    const none = committed(doc, 'delta');
    expect(findStatusText(getSearchQuery(none), countMatches(none, getSearchQuery(none)))).toBe('No matches');
    const one = committed(doc, 'gamma');
    expect(findStatusText(getSearchQuery(one), countMatches(one, getSearchQuery(one)))).toBe('1 match');
    const many = committed('a '.repeat(30), 'a');
    const capped = countMatches(many, getSearchQuery(many), 10);
    expect(capped).toEqual({ total: 10, current: null, capped: true });
    expect(findStatusText(getSearchQuery(many), capped)).toBe('10+ matches');
    const broken = new SearchQuery({ search: '(', regexp: true });
    expect(findStatusText(broken, null)).toBe('Not a valid regular expression');
    expect(findStatusText(new SearchQuery({ search: '' }), null)).toBe('');
  });

  it('reports what Replace all replaced', () => {
    const q = getSearchQuery(committed(doc, 'alpha'));
    expect(findStatusText(q, { total: 0, current: null, capped: false }, 3)).toBe('Replaced 3 matches');
    expect(findStatusText(q, null, 1)).toBe('Replaced 1 match');
  });
});
