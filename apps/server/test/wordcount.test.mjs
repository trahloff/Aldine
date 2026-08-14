/**
 * Whole-document word count: the include graph must resolve targets against
 * the ROOT FILE'S dir (nested roots like paper/main.tex), skip commented-out
 * and missing includes, and survive cycles.
 */
import { check, eq } from './assert.mjs';

const { latexWordCount, documentFiles } = await import('../src/wordcount.ts');

eq(latexWordCount('one two three'), 3, 'plain words');
eq(latexWordCount('% a comment line\nreal words here'), 3, 'comments stripped');
eq(latexWordCount('\\section{Intro} body'), 2, 'command stripped, brace content kept');
eq(latexWordCount('before $x^2 + y$ after'), 3, 'inline math counts as one word');

const nested = {
  'paper/main.tex': 'Intro words.\n\\input{chapters/ch1}\n% \\input{chapters/ghost}\n\\include{appendix}',
  'paper/chapters/ch1.tex': 'Chapter one has five words\n\\input{chapters/ch1} % self-include must not loop',
  'paper/appendix.tex': 'Appendix text',
};
const read = (p) => nested[p] ?? null;
const files = documentFiles('paper/main.tex', read);
eq(files.length, 3, 'root + chapter + appendix, ghost and cycle skipped');
eq(files[0], 'paper/main.tex', 'root first');
check(files.includes('paper/chapters/ch1.tex'), 'include target resolves against the root dir');
check(files.includes('paper/appendix.tex'), '\\include works and .tex is appended');

const flat = documentFiles('main.tex', (p) => (p === 'main.tex' ? '\\input{a}\\input{sub/b.tex}' : p === 'a.tex' || p === 'sub/b.tex' ? 'x' : null));
eq(flat.length, 3, 'top-level root resolves plain and nested targets');

console.log('wordcount: all checks passed');
