/**
 * Bibliography-log parsing. A malformed .bib entry never reaches the LaTeX
 * log: bibtex writes no .bbl and LaTeX then reports only one "Citation
 * undefined" warning per citation — hundreds of rows, none naming the line to
 * fix. These are the lines that do name it.
 */
import { createRequire } from 'node:module';
import { check, eq } from './assert.mjs';

const { parseBibLog, latexmkFailure } = createRequire(import.meta.url)('../../compiler/server.js');

// ---- bibtex ----
const blg = [
  'This is BibTeX, Version 0.99d',
  'Database file #1: refs.bib',
  "I was expecting a `,' or a `}'---line 42 of file refs.bib",
  ' : @ARTICLE{alpha2001,',
  "You're missing a field part---line 57 of file refs.bib",
  'Repeated entry---line 91 of file refs.bib',
  'Warning--entry type for "beta2002" isn\'t style-file defined',
  '--line 103 of file refs.bib',
  'Warning--missing publisher in gamma2003',
  '(There were 3 error messages)',
].join('\n');

eq(parseBibLog(blg), [
  { type: 'error', file: 'refs.bib', line: 42, message: "BibTeX: I was expecting a `,' or a `}'" },
  { type: 'error', file: 'refs.bib', line: 57, message: "BibTeX: You're missing a field part" },
  { type: 'error', file: 'refs.bib', line: 91, message: 'BibTeX: Repeated entry' },
], 'the three located errors, and none of the Warning-- noise');

// A `Warning--` continuation line is "--line N of file X" (two dashes) and
// must not be mistaken for an error's "---line N of file X".
check(!parseBibLog('--line 103 of file refs.bib').length, 'a warning continuation is not an error');

eq(parseBibLog("I couldn't open style file plainnat.bst"), [
  { type: 'error', line: null, message: "BibTeX: I couldn't open style file plainnat.bst" },
], 'a missing .bst has no line to point at but still has to be said');

// ---- biber ----
eq(parseBibLog("[0] Utils.pm:410> ERROR - Cannot find 'refs.bib'!"), [
  { type: 'error', line: null, message: "Biber: Cannot find 'refs.bib'!" },
], 'biber error');
eq(parseBibLog('[62] Biber.pm:130> WARN - Duplicate entry key: "alpha2001"'), [
  { type: 'warning', line: null, message: 'Biber: Duplicate entry key: "alpha2001"' },
], 'biber warning stays a warning');

check(!parseBibLog('The style file: plainnat.bst\nDatabase file #1: refs.bib').length, 'ordinary bibtex chatter parses to nothing');

// ---- latexmk's own summary ----
const out = [
  'Latexmk: Errors, so I did not complete making targets',
  'Collected error summary (may duplicate other messages):',
  "  pdflatex: Command for 'pdflatex' gave return code 1",
  "      Refer to '.aldine-out/main.log' and/or above output for details",
  'Latexmk: Undoing directory change',
].join('\n');

eq(latexmkFailure(out), [
  { type: 'error', line: null, message: "Typesetting failed: pdflatex: Command for 'pdflatex' gave return code 1" },
], 'the summary line, without the "Refer to" that points at a log the user already has');

eq(latexmkFailure('Latexmk: Nothing to do.'), [], 'a run with no summary contributes nothing');

console.log('biblog tests passed');

// ---- biber rows that name a .bib line ----
// biber reads a re-encoded temp copy named after the .bib; the row must point
// at the .bib and its line, never be left for the root file to absorb.
eq(parseBibLog('[62] Utils.pm:410> WARN - BibTeX subsystem: /tmp/biber_tmp_abcd/references.bib_1234.utf8, line 16, warning: undefined macro "June"'), [
  { type: 'warning', file: 'references.bib', line: 16, message: 'Biber: BibTeX subsystem: /tmp/biber_tmp_abcd/references.bib_1234.utf8, line 16, warning: undefined macro "June"' },
], 'a located biber warning carries the .bib name and line');
eq(parseBibLog("[70] Biber.pm:4300> WARN - I didn't find a database entry for 'invented_key' (section 0)")[0].file, undefined, 'an unlocated biber warning names no file');

// ---- the source line and the offending token ----
const { parseLog, documentBodyReached } = createRequire(import.meta.url)('../../compiler/server.js');
const texlog = [
  './main.tex:15: Undefined control sequence.',
  'l.15 We \\emphasise',
  '                   {keeps} it',
  '',
  './main.tex:5: LaTeX Error: File `nonexistentpkgxyz.sty\' not found.',
  '',
  'Type X to quit or <RETURN> to proceed,',
  '',
  './main.tex:5: Emergency stop.',
  '<read *> ',
  '         ',
  'l.5 \\usepackage{nonexistentpkgxyz}',
  '                                  ^^M',
  '! Undefined control sequence.',
  'l.3 \\thisisnotacommand',
  '',
].join('\n');
const rows = parseLog(texlog);
eq(rows[0], { type: 'error', file: 'main.tex', line: 15, message: 'Undefined control sequence. — \\emphasise', context: 'We \\emphasise{keeps} it' },
  'an undefined control sequence names its token and carries the source line, rejoined from TeX\'s two halves');
eq(rows[1].context, '\\usepackage{nonexistentpkgxyz}', 'the context is the source line without TeX\'s ^^M end-of-line marker');
eq(rows[3], { type: 'error', line: 3, message: 'Undefined control sequence. — \\thisisnotacommand', context: '\\thisisnotacommand' }, 'the "!" form gets the same treatment');
check(!('context' in parseLog('./main.tex:9: Missing $ inserted.\n')[0]), 'no l.<n> line, no context field');

// ---- the bibliography gate ----
check(documentBodyReached('This is pdfTeX\n\\openout1 = `main.aux\'.\n\nLaTeX Warning: Citation `x\' undefined'), 'the .aux \\openout marks the body');
check(!documentBodyReached('./main.tex:5: LaTeX Error: File `x.sty\' not found.\n./main.tex:5: Emergency stop.\n==> Fatal error occurred, no output PDF file produced!'), 'a run that died in the preamble never opened the .aux — its .blg rows belong to the previous run');

console.log('biblog context tests passed');
