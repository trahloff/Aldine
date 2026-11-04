import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { latex } from 'codemirror-lang-latex';
import { pasteText, rawAt, recordOwnCopies } from '../clipboard';
import { htmlToLatex } from '../html2latex';
import { definesUrl, preambleOf } from '../preamble';
import { parsedState } from './parsedState';
import { installMiniDom } from './miniDom';

installMiniDom();

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

  it('takes escapes, ties after a word and formulas that open with a digit as LaTeX, but not price ranges', () => {
    expect(pasteText('', '30\\% (Fig.~3)', '')).toBeNull();
    expect(pasteText('', 'R\\&D costs', '')).toBeNull();
    expect(pasteText('', 'snake\\_case', '')).toBeNull();
    expect(pasteText('', 'see Table~2', '')).toBeNull();
    expect(pasteText('', 'it takes $2n$ steps', '')).toBeNull();
    expect(pasteText('', 'about $10^{-3}$ s', '')).toBeNull();
    expect(pasteText('', 'we need $2n + 1$ rounds', '')).toBeNull();
    expect(pasteText('', 'pay $5 now and $2n$ later', '')).toBeNull();
    expect(pasteText('', 'from $5-$10', '')).toBe('from \\$5-\\$10');
    expect(pasteText('', 'between $5M and $10M', '')).toBe('between \\$5M and \\$10M');
    expect(pasteText('', '$5M-$10M a year', '')).toBe('\\$5M-\\$10M a year');
    expect(pasteText('', '3~5 days', '')).toBe('3\\textasciitilde{}5 days');
    expect(pasteText('', 'see ~/notes and example.org/~me', '')).toBe('see \\textasciitilde{}/notes and example.org/\\textasciitilde{}me');
  });
});

describe('rich-text paste', () => {
  const docsList = (inner: string) =>
    `<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1">${inner}</b>`;
  const docsItem = (text: string, level: number) =>
    `<li dir="ltr" style="list-style-type:${level > 1 ? 'circle' : 'disc'};font-weight:400;" aria-level="${level}"><p dir="ltr" role="presentation"><span style="font-weight:400;">${text}</span></p></li>`;

  it('keeps the sub-items of a Google Docs list, nested under the item before them', () => {
    const html = docsList(`<ul style="padding-inline-start:48px;">${docsItem('One', 1)}<ul style="padding-inline-start:48px;">${docsItem('Sub a', 2)}${docsItem('Sub b', 2)}</ul>${docsItem('Two', 1)}</ul>`);
    expect(htmlToLatex(html)).toBe([
      '\\begin{itemize}',
      '\\item One',
      '\\begin{itemize}',
      '\\item Sub a',
      '\\item Sub b',
      '\\end{itemize}',
      '\\item Two',
      '\\end{itemize}',
    ].join('\n'));
  });

  it('keeps every level of a numbered list three deep', () => {
    const html = docsList(`<ol>${docsItem('A', 1)}<ol>${docsItem('B', 2)}<ol>${docsItem('C', 3)}</ol></ol></ol>`);
    expect(htmlToLatex(html)).toBe('\\begin{enumerate}\n\\item A\n\\begin{enumerate}\n\\item B\n\\begin{enumerate}\n\\item C\n\\end{enumerate}\n\\end{enumerate}\n\\end{enumerate}');
  });

  it('nests a list written inside its item, as web pages do', () => {
    expect(htmlToLatex('<ul><li>One<ul><li>Sub</li></ul></li><li>Two</li></ul>'))
      .toBe('\\begin{itemize}\n\\item One\n\\begin{itemize}\n\\item Sub\n\\end{itemize}\n\\item Two\n\\end{itemize}');
  });

  it('never drops what sits between items, or a sub-list with no item before it', () => {
    expect(htmlToLatex('<ul><ul><li>Sub</li></ul><li>Next</li></ul>')).toBe('\\begin{itemize}\n\\item Sub\n\\item Next\n\\end{itemize}');
    expect(htmlToLatex('<ol><li>First</li><p>its note</p><li>Second</li></ol>')).toBe('\\begin{enumerate}\n\\item First\nits note\n\\item Second\n\\end{enumerate}');
  });
});

describe('paste where text is source as written', () => {
  const at = (marked: string) => {
    const pos = marked.indexOf('|');
    const doc = marked.slice(0, pos) + marked.slice(pos + 1);
    return rawAt(parsedState({ doc, extensions: [latex()] }), pos);
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
