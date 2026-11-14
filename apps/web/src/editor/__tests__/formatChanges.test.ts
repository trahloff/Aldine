import { describe, it, expect } from 'vitest';
import { EditorState, EditorSelection } from '@codemirror/state';
import * as Y from 'yjs';
import { formatChanges } from '../formatChanges';

const apply = (before: string, after: string) => EditorState.create({ doc: before }).update({ changes: formatChanges(before, after) }).state;

describe('formatChanges', () => {
  it('re-indents a line by inserting or removing only its leading whitespace', () => {
    const before = '\\begin{itemize}\n\\item a\n    \\item b\n\\end{itemize}';
    const after = '\\begin{itemize}\n  \\item a\n  \\item b\n\\end{itemize}';
    expect(formatChanges(before, after)).toEqual([
      { from: 16, to: 16, insert: '  ' },
      { from: 26, to: 28, insert: '' },
    ]);
    expect(apply(before, after).doc.toString()).toBe(after);
  });

  it('changes nothing when the text is already formatted', () => {
    expect(formatChanges('a\n  b\n', 'a\n  b\n')).toEqual([]);
  });

  it('replaces tabs with spaces in place, and drops trailing whitespace', () => {
    const before = '\\begin{x}\n\tfoo  \n\\end{x}\n';
    const after = '\\begin{x}\n  foo\n\\end{x}\n';
    expect(apply(before, after).doc.toString()).toBe(after);
    expect(formatChanges(before, after).every((c) => /^\s*$/.test(before.slice(c.from, c.to)) && /^\s*$/.test(c.insert))).toBe(true);
  });

  it('keeps a cursor on the text it was on', () => {
    const before = '\\begin{itemize}\n\\item word\n\\end{itemize}';
    const after = '\\begin{itemize}\n    \\item word\n\\end{itemize}';
    const at = before.indexOf('word') + 2;
    const state = EditorState.create({ doc: before, selection: EditorSelection.cursor(at) });
    const next = state.update({ changes: formatChanges(before, after) }).state;
    expect(next.doc.sliceString(next.selection.main.head - 2, next.selection.main.head + 2)).toBe('word');
  });

  it('keeps a collaborator\'s relative position in the shared document', () => {
    const before = '\\begin{a}\n\\begin{b}\nx marks\n\\end{b}\n\\end{a}';
    const after = '\\begin{a}\n  \\begin{b}\n    x marks\n  \\end{b}\n\\end{a}';
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('t');
    ytext.insert(0, before);
    const rel = Y.createRelativePositionFromTypeIndex(ytext, before.indexOf('marks'));
    // From the end backwards, as CodeMirror's binding applies a change set.
    ydoc.transact(() => {
      for (const c of [...formatChanges(before, after)].reverse()) {
        if (c.to > c.from) ytext.delete(c.from, c.to - c.from);
        if (c.insert) ytext.insert(c.from, c.insert);
      }
    });
    expect(ytext.toString()).toBe(after);
    const abs = Y.createAbsolutePositionFromRelativePosition(rel, ydoc)!;
    expect(after.slice(abs.index, abs.index + 5)).toBe('marks');
  });

  it('falls back to one block when the line count changed', () => {
    for (const [before, after] of [['x', 'x\nx'], ['a\nb\nc', 'a\nc'], ['', 'y\n'], ['p\nq\n', 'p\n\nq\n']]) {
      expect(apply(before, after).doc.toString()).toBe(after);
      expect(formatChanges(before, after)).toHaveLength(1);
    }
  });
});
