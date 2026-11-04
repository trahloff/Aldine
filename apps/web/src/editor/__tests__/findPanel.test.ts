import { describe, it, expect } from 'vitest';
import { EditorState, type TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { getSearchQuery, replaceAll, SearchQuery, setSearchQuery } from '@codemirror/search';
import { findPanel } from '../findPanel';

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
