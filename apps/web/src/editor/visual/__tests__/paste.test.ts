import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { ensureSyntaxTree } from '@codemirror/language';
import { latex } from 'codemirror-lang-latex';
import { pasteText, rawAt, recordOwnCopies } from '../clipboard';
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
    for (const filter of state.facet(EditorView.clipboardOutputFilter)) filter('Save 10% & 5 #1', state);
    expect(pasteText('', 'Save 10% & 5 #1', '')).toBeNull();
    expect(pasteText('', 'Save 10% & 5 #1\r\n'.trimEnd(), '')).toBeNull();
    expect(pasteText('', 'Save 20% & 5 #1', '')).toBe('Save 20\\% \\& 5 \\#1');
  });

  it('takes any control word or $…$ formula as LaTeX, but not a path or prices', () => {
    expect(pasteText('', '$\\alpha$ and \\ref{fig:1} \\emph{x}', '')).toBeNull();
    expect(pasteText('', 'where $a_1 + x^2$ holds', '')).toBeNull();
    expect(pasteText('', 'see the note\\footnote{a_b}', '')).toBeNull();
    expect(pasteText('', 'C:\\Users\\me 100%', '')).toBe('C:\\textbackslash{}Users\\textbackslash{}me 100\\%');
    expect(pasteText('', 'from $5 to $10', '')).toBe('from \\$5 to \\$10');
  });
});

describe('paste where text is source as written', () => {
  const at = (marked: string) => {
    const pos = marked.indexOf('|');
    const doc = marked.slice(0, pos) + marked.slice(pos + 1);
    const s = EditorState.create({ doc, extensions: [latex()] });
    ensureSyntaxTree(s, doc.length, 5_000);
    return rawAt(s, pos);
  };

  it('pastes as it is into math, verbatim, paths and reference keys', () => {
    expect(at('Let $a + |b$ hold.')).toBe(true);
    expect(at('\\begin{align}\n  x &= |\n\\end{align}')).toBe(true);
    expect(at('\\begin{verbatim}\nint x = 1;|\n\\end{verbatim}')).toBe(true);
    expect(at('\\begin{lstlisting}\n|\n\\end{lstlisting}')).toBe(true);
    expect(at('See \\ref{|}.')).toBe(true);
    expect(at('See \\ref{sec:|}.')).toBe(true);
    expect(at('\\cite{knuth,|}')).toBe(true);
    expect(at('\\label{|}')).toBe(true);
    expect(at('\\url{https://|}')).toBe(true);
    expect(at('\\path{/usr/|}')).toBe(true);
    expect(at('\\verb|a_b|| x')).toBe(false);
    // just outside is prose again
    expect(at('Let $a$| hold.')).toBe(false);
    expect(at('See \\ref{a}|.')).toBe(false);
    expect(at('Plain | text.')).toBe(false);
    expect(at('\\emph{some |text}')).toBe(false);
    expect(pasteText('', 'a_1 + x^2', '', true)).toBeNull();
    expect(pasteText('<b>x</b>', 'x', '', true)).toBeNull();
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
