import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { latex } from 'codemirror-lang-latex';
import { groupAt } from '../clicks';

const doc = 'Hello \\textbf{brave} new\n\nend  of';
const state = EditorState.create({ doc, extensions: [latex()] });
const group = (pos: number, bias?: number) => {
  const r = groupAt(state, pos, bias);
  return state.sliceDoc(r.from, r.to);
};

describe('the double-click group', () => {
  it('is the word, space run or punctuation at the click, as CodeMirror groups them', () => {
    expect(group(doc.indexOf('brave') + 2)).toBe('brave');
    // LaTeX counts the backslash as part of a word
    expect(group(doc.indexOf('textbf') + 1)).toBe('\\textbf');
    expect(group(doc.indexOf('  of') + 1)).toBe('  ');
  });

  it('takes the character on the side the click fell', () => {
    expect(group(doc.indexOf('brave'), -1)).toBe('{');
    expect(group(doc.indexOf('brave'), 1)).toBe('brave');
  });

  it('looks inward at the ends of a line and selects nothing on an empty one', () => {
    expect(group(doc.indexOf('\n'), 1)).toBe('new');
    expect(group(doc.indexOf('end'), -1)).toBe('end');
    const empty = groupAt(state, doc.indexOf('\n') + 1);
    expect([empty.from, empty.to]).toEqual([doc.indexOf('\n') + 1, doc.indexOf('\n') + 1]);
  });
});
