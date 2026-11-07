import { describe, expect, it } from 'vitest';
import { spellcheckable, unspelledRanges } from '../spellcheck';

/** The parts a spellchecker skips, as text. */
const skipped = (text: string) => unspelledRanges(text).map(([a, b]) => text.slice(a, b));

describe('spellcheck leaves LaTeX alone', () => {
  it('skips command names and control symbols, not their prose arguments', () => {
    expect(skipped('A \\textbf{bold} word, 50\\% off.')).toEqual(['\\textbf', '\\%']);
  });

  it('skips the keys, labels and paths commands take', () => {
    expect(skipped('See \\cite[p.~3]{knuth84} and \\cref{sec:intro}.')).toEqual(['\\cite[p.~3]{knuth84}', '\\cref{sec:intro}']);
    expect(skipped('\\includegraphics[width=0.8\\linewidth]{figs/plot}')).toEqual(['\\includegraphics[width=0.8\\linewidth]{figs/plot}']);
    expect(skipped('\\begin{itemize}')).toEqual(['\\begin{itemize}']);
    expect(skipped('\\href{https://x.org}{the site}')).toEqual(['\\href{https://x.org}']);
  });

  it('skips math and verbatim, inline and displayed', () => {
    expect(skipped('Let $x_i \\in S$ hold.')).toEqual(['$x_i \\in S$']);
    expect(skipped('Then \\[ a = b \\] and \\(c\\).')).toEqual(['\\[ a = b \\]', '\\(c\\)']);
    const eq = '\\begin{align*}\n  f(x) &= mx \\\\\n\\end{align*}';
    expect(skipped(`Text\n${eq}\nmore`)).toEqual([eq]);
    const code = '\\begin{verbatim}\nteh codez\n\\end{verbatim}';
    expect(skipped(code)).toEqual([code]);
  });

  it('keeps an escaped dollar out of math, and comments in', () => {
    expect(skipped('It costs \\$5 and \\$6.')).toEqual(['\\$', '\\$']);
    expect(skipped('% a comment with wrods')).toEqual([]);
  });

  it('checks prose files only', () => {
    expect(spellcheckable('main.tex')).toBe(true);
    expect(spellcheckable('README.md')).toBe(true);
    expect(spellcheckable('refs.bib')).toBe(false);
    expect(spellcheckable('style.sty')).toBe(false);
  });
});
