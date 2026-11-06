/**
 * Which file a log row is about. TeX prints "(name" when it opens a file and
 * ")" when it closes it; a warning's "on input line N" and a bad box's "at
 * lines N" are lines of the innermost file open at that point. The document's
 * own text shows up in the log too (an error's context, a bad box's
 * contents), and its parentheses open and close no file. Lines are as
 * pdfTeX 2026 wrote them for a main.tex that inputs chapters/one.tex, which
 * inputs chapters/two.tex.
 */
import { createRequire } from 'node:module';
import { eq } from './assert.mjs';

const { parseLog } = createRequire(import.meta.url)('../../compiler/server.js');

const log = [
  'This is pdfTeX, Version 3.141592653-2.6-1.40.29 (TeX Live 2026) (preloaded format=pdflatex 2026.3.1)  5 NOV 2026 09:30',
  'entering extended mode',
  '(./main.tex',
  'LaTeX2e <2025-11-01>',
  '(/usr/local/texlive/2026/texmf-dist/tex/latex/base/article.cls',
  'Document Class: article 2025/01/22 v1.4n Standard LaTeX document class',
  '(/usr/local/texlive/2026/texmf-dist/tex/latex/base/size10.clo',
  'File: size10.clo 2025/01/22 v1.4n Standard LaTeX file (size option)',
  ')',
  ') (/usr/local/texlive/2026/texmf-dist/tex/latex/hyperref/hyperref.sty',
  'Package: hyperref 2025-07-12 v7.01o Hypertext links for LaTeX',
  '',
  'Package hyperref Warning: Option `pdfborder\' has already been used,',
  '(hyperref)                setting the option has no effect on input line 4466.',
  '',
  ') (.aldine-out/main.aux)',
  '',
  'LaTeX Warning: Citation `smith2020\' on page 1 undefined on input line 5.',
  '',
  '(./chapters/one.tex',
  './chapters/one.tex:1: Undefined control sequence.',
  'l.1 Text with an error (open paren \\foo',
  '                                        here.',
  'The control sequence at the end of the top line',
  'of your error message was never \\def\'ed. If you have',
  'misspelled it (e.g., `\\hobx\'), type `I\' and the correct',
  '',
  'LaTeX Warning: Citation `inchapter2019\' on page 1 undefined on input line 2.',
  '',
  '',
  'Overfull \\hbox (178.13094pt too wide) detected at line 4',
  '\\OT1/cmr/m/n/10 Overfull in chapter (unbalanced paren more text here',
  ' []',
  '',
  '',
  'Underfull \\hbox (badness 10000) in paragraph at lines 7--8',
  '[]\\OT1/cmr/m/n/10 closing) twice) in a box',
  ' []',
  '',
  '(./chapters/two.tex',
  '',
  'LaTeX Warning: Citation `intwo2000\' on page 1 undefined on input line 1.',
  '',
  ')',
  '',
  'LaTeX Warning: Reference `missingref\' on page 1 undefined on input line 12.',
  '',
  ')',
  'Overfull \\hbox (160.84482pt too wide) detected at line 9',
  '\\OT1/cmr/m/n/10 This line is much too wide',
  ' []',
  '',
  '! Missing $ inserted.',
  '<inserted text> ',
  '                $',
  'l.10 a_(b',
  '         ',
  '',
  'LaTeX Warning: Citation `late2021\' on page 1 undefined on input line 11.',
  '',
  '[1',
  '',
  '{/usr/local/texlive/2026/texmf-var/fonts/map/pdftex/updmap/pdftex.map}] (.aldine-out/main.aux)',
  '',
  'LaTeX Warning: There were undefined references.',
  '',
  ' ) ',
  'Output written on .aldine-out/main.pdf (1 page, 24071 bytes).',
].join('\n');

const rows = parseLog(log).map(({ type, file, line, message }) => ({ type, file: file ?? null, line, about: message.slice(0, 30) }));
eq(rows, [
  { type: 'warning', file: '/usr/local/texlive/2026/texmf-dist/tex/latex/hyperref/hyperref.sty', line: 4466, about: 'Package hyperref Warning: Opti' },
  { type: 'warning', file: './main.tex', line: 5, about: 'LaTeX Warning: Citation `smith' },
  { type: 'error', file: 'chapters/one.tex', line: 1, about: 'Undefined control sequence. — ' },
  { type: 'warning', file: './chapters/one.tex', line: 2, about: 'LaTeX Warning: Citation `incha' },
  { type: 'typesetting', file: './chapters/one.tex', line: 4, about: 'Overfull \\hbox (178.13094pt to' },
  { type: 'typesetting', file: './chapters/one.tex', line: 7, about: 'Underfull \\hbox (badness 10000' },
  { type: 'warning', file: './chapters/two.tex', line: 1, about: 'LaTeX Warning: Citation `intwo' },
  { type: 'warning', file: './chapters/one.tex', line: 12, about: 'LaTeX Warning: Reference `miss' },
  { type: 'typesetting', file: './main.tex', line: 9, about: 'Overfull \\hbox (160.84482pt to' },
  { type: 'error', file: './main.tex', line: 10, about: 'Missing $ inserted.' },
  { type: 'warning', file: './main.tex', line: 11, about: 'LaTeX Warning: Citation `late2' },
  { type: 'warning', file: null, line: null, about: 'LaTeX Warning: There were unde' },
], 'every row names the file that was open, whatever parentheses the document text holds');

// TeX quotes a name with a space in it.
const quoted = parseLog(['("./my chapter.tex"', '', 'LaTeX Warning: Reference `x\' on page 1 undefined on input line 3.', ')'].join('\n'));
eq(quoted.map((e) => e.file), ['./my chapter.tex'], 'a quoted file name is the file');

// A row TeX gave no line has no file either: there is nothing to go to.
const noLine = parseLog(['(./main.tex', 'LaTeX Warning: Label(s) may have changed. Rerun to get cross-references right.', ')'].join('\n'));
eq(noLine.map((e) => [e.file ?? null, e.line]), [[null, null]], 'no line, no file');

console.log('logparse-files: OK');
