/**
 * Root detection on imported archives: the manuscript, not the biggest file;
 * banners longer than 4 KB; class stubs without \begin{document}; nested
 * roots; and never a name the archive does not contain.
 */
import { check, eq } from './assert.mjs';

const { guessRoot } = await import('../src/unzip.ts');

const B = (s) => Buffer.from(s);
const doc = (extra = '') => `\\documentclass{article}\n${extra}\\begin{document}\nHello\n\\end{document}\n`;
const banner = '%'.repeat(79).concat('\n').repeat(80); // ~6.4 KB of comment lines

eq(guessRoot({ 'main.tex': B(doc()), 'chapter.tex': B('\\section{One}\n'.repeat(200)) }), 'main.tex', 'the file with \\documentclass, not the largest');
eq(guessRoot({ 'article.tex': B(banner + doc()) }), 'article.tex', '\\documentclass after a >4 KB banner');
eq(guessRoot({ 'elsarticle-template.tex': B(doc('\\usepackage{lipsum}\n'.repeat(300))), 'manuscript.tex': B(doc()) }), 'manuscript.tex', 'conventional root name beats a larger template');
eq(guessRoot({ 'sample.tex': B(doc('\\usepackage{lipsum}\n'.repeat(300))), 'mypaper.tex': B(doc()) }), 'mypaper.tex', 'no conventional name: the smaller candidate wins over a bundled sample');
eq(guessRoot({ 'sub/notes.tex': B(doc()), 'paper/sections/intro.tex': B('\\section{Intro}'), 'paper/main.tex': B(doc()) }), 'paper/main.tex', 'nested root by name');
eq(guessRoot({ 'a/b/c/deep.tex': B(doc()), 'top.tex': B(doc()) }), 'top.tex', 'shallowest path among equals');
eq(guessRoot({ 'mycls.tex': B('\\documentclass{article}\n% class docs, no body\n'), 'thesis.tex': B(doc()) }), 'thesis.tex', '\\begin{document} beats a preamble-only file');
eq(guessRoot({ 'snippet.tex': B('% \\documentclass{article}\ntext'), 'main.tex': B(doc()) }), 'main.tex', 'commented-out \\documentclass is not a candidate');
eq(guessRoot({ 'zz.tex': B('text'), 'aa/inner.tex': B('text'), 'b.tex': B('more') }), 'b.tex', 'no \\documentclass anywhere: shallowest .tex, smallest first');
eq(guessRoot({ 'Main.TEX': B(doc()) }), 'Main.TEX', 'extension match is case-insensitive');
check(guessRoot({ 'refs.bib': B('@book{x}') }) === undefined, 'no .tex at all → nothing (never an invented main.tex)');

const late = B('%'.repeat(300 * 1024) + '\n' + doc());
eq(guessRoot({ 'huge.tex': late, 'main.tex': B('text') }), 'main.tex', '\\documentclass beyond the 256 KB scan window is not seen; fallback still names a real file');

console.log('guessRoot: all checks passed');
