import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { pasteText, recordOwnCopies } from '../clipboard';
import { definesUrl, preambleOf } from '../preamble';

describe('plain-text paste in Visual (#149)', () => {
  it('escapes prose so it typesets', () => {
    expect(pasteText('', '50% & $5 #3', '')).toBe('50\\% \\& \\$5 \\#3');
    expect(pasteText('', 'a_b ~ c^2 {x}', '')).toBe('a\\_b \\textasciitilde{} c\\textasciicircum{}2 \\{x\\}');
    // nothing to escape: the editor's own paste
    expect(pasteText('', 'Just words.\n\nTwo paragraphs.', '')).toBeNull();
  });

  it('leaves LaTeX and the editor\'s own copies as they are', () => {
    expect(pasteText('', '\\section{Intro} 50\\%', '')).toBeNull();
    const state = EditorState.create({ extensions: [recordOwnCopies] });
    for (const filter of state.facet(EditorView.clipboardOutputFilter)) filter('$x$ & 10\\% off', state);
    expect(pasteText('', '$x$ & 10\\% off', '')).toBeNull();
    expect(pasteText('', '$x$ & 10\\% off\r\n'.trimEnd(), '')).toBeNull();
    expect(pasteText('', '$y$ & 10% off', '')).toBe('\\$y\\$ \\& 10\\% off');
  });
});

describe('\\url only where the preamble defines it (#149)', () => {
  const doc = (pre: string) => `\\documentclass{article}\n${pre}\n\\begin{document}\nx\n\\end{document}\n`;

  it('reads the packages the preamble loads', () => {
    expect(definesUrl(preambleOf(doc('')))).toBe(false);
    expect(definesUrl(preambleOf(doc('\\usepackage{url}')))).toBe(true);
    expect(definesUrl(preambleOf(doc('\\usepackage[hidelinks]{hyperref}')))).toBe(true);
    expect(definesUrl(preambleOf(doc('\\usepackage{amsmath, xurl}')))).toBe(true);
    expect(definesUrl(preambleOf(doc('\\usepackage[backend=biber]{biblatex}')))).toBe(true);
    expect(definesUrl(preambleOf(doc('% \\usepackage{hyperref}')))).toBe(false);
    // a file without a preamble of its own (and no root file read) has none
    expect(definesUrl(preambleOf('Some chapter text.'))).toBe(false);
  });
});
