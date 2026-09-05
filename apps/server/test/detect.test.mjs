/**
 * Engine detection on import: latexmkrc settings in latexmk's own precedence,
 * magic comments, the packages that need XeLaTeX or LuaLaTeX, and the
 * Latin-1 transcode that keeps an inputenc'd file compiling.
 */
import { check, eq } from './assert.mjs';

const { detectEngine, engineFromLatexmkrc, engineFromSource, decodeText } = await import('../src/detect.ts');

const B = (s) => Buffer.from(s);
const doc = (preamble = '') => `\\documentclass{article}\n${preamble}\\begin{document}\nHello\n\\end{document}\n`;

// ---- latexmkrc ----
eq(engineFromLatexmkrc('$pdf_mode = 4;'), 'lualatex', '$pdf_mode 4 is -pdflua');
eq(engineFromLatexmkrc('$pdf_mode = 5;'), 'xelatex', '$pdf_mode 5 is -pdfxe');
eq(engineFromLatexmkrc('$pdf_mode = 1;'), 'pdf', '$pdf_mode 1 is an explicit pdflatex');
eq(engineFromLatexmkrc('$pdf_mode = "4";'), 'lualatex', 'quoted value');
eq(engineFromLatexmkrc("$pdflatex = 'xelatex -synctex=1 %O %S';"), 'xelatex', 'pre-4.51 idiom: $pdflatex names xelatex');
eq(engineFromLatexmkrc("$pdflatex = 'lualatex %O %S';"), 'lualatex', '$pdflatex names lualatex');
eq(engineFromLatexmkrc("$pdflatex = '/usr/bin/xelatex %O %S';"), 'xelatex', 'absolute command path');
eq(engineFromLatexmkrc("$pdflatex = 'pdflatex -shell-escape %O %S';"), null, '$pdflatex naming pdflatex only passes flags: no choice');
eq(engineFromLatexmkrc("$xelatex = 'xelatex -interaction=nonstopmode %O %S';"), 'xelatex', 'a bare $xelatex assignment is the last hint');
eq(engineFromLatexmkrc("$lualatex = 'lualatex %O %S';"), 'lualatex', 'a bare $lualatex assignment');
eq(engineFromLatexmkrc("$pdf_mode = 4;\n$xelatex = 'xelatex %O %S';"), 'lualatex', '$pdf_mode wins over a command assignment');
const allThree = "$pdflatex = 'pdflatex -shell-escape %O %S';\n$xelatex = 'xelatex -shell-escape %O %S';\n$lualatex = 'lualatex -shell-escape %O %S';";
eq(engineFromLatexmkrc(allThree), null, 'flags handed to all three engines choose none');
eq(engineFromLatexmkrc("$xelatex = 'xelatex %O %S';\n$lualatex = 'lualatex %O %S';"), null, 'both bare assignments together are no hint either');
eq(engineFromLatexmkrc("$pdf_mode = 5;\n" + allThree), 'xelatex', '$pdf_mode still decides beside all three');
eq(engineFromLatexmkrc("$pdflatex = 'xelatex %O %S';\n$lualatex = 'lualatex %O %S';"), 'xelatex', 'a $pdflatex naming xelatex beats a bare $lualatex');
eq(engineFromLatexmkrc('# $pdf_mode = 4;\n$bibtex_use = 2;'), null, 'commented-out setting is ignored');
eq(engineFromLatexmkrc('$bibtex_use = 2;'), null, 'no engine setting at all');

// ---- source sniffing ----
eq(engineFromSource(doc('\\usepackage{fontspec}\n')), { engine: 'xelatex', reason: 'the fontspec package in the main document' }, 'fontspec');
eq(engineFromSource(doc('\\usepackage[math-style=ISO]{unicode-math}\n')).engine, 'xelatex', 'unicode-math with options');
eq(engineFromSource(doc('\\usepackage{polyglossia}\n')).engine, 'xelatex', 'polyglossia');
eq(engineFromSource(doc('\\usepackage{xepersian}\n')).engine, 'xelatex', 'xepersian');
eq(engineFromSource(doc('\\usepackage[RTLdocument]{bidi}\n')).engine, 'xelatex', 'bidi');
eq(engineFromSource(doc('\\usepackage{amsmath,fontspec,graphicx}\n')).engine, 'xelatex', 'fontspec inside a package list');
eq(engineFromSource(doc('\\usepackage{luacode}\n')), { engine: 'lualatex', reason: 'the luacode package in the main document' }, 'luacode');
eq(engineFromSource(doc('\\usepackage{fontspec}\n\\usepackage{luacode}\n')).engine, 'lualatex', 'luacode beats fontspec: fontspec runs on both engines, luacode on one');
eq(engineFromSource('% !TEX program = lualatex\n' + doc('\\usepackage{fontspec}\n')).engine, 'lualatex', 'magic comment wins over packages');
eq(engineFromSource('% !TEX TS-program = xelatex\n' + doc()).engine, 'xelatex', 'TeXShop spelling');
eq(engineFromSource('%!TEX program = pdflatex\n' + doc('\\usepackage{fontspec}\n')).engine, 'pdf', 'magic comment can pin pdflatex explicitly');
eq(engineFromSource(doc('% \\usepackage{fontspec}\n')), null, 'commented-out package is not a hint');
eq(engineFromSource(doc('\\usepackage{fontspecial}\n')), null, 'no partial matches');
eq(engineFromSource(doc('\\usepackage{graphicx}\n')), null, 'plain preamble: nothing');
eq(engineFromSource(doc('\\newcommand{\\pct}{\\%}\\usepackage{fontspec}\n')).engine, 'xelatex', 'an escaped \\% earlier on the line does not hide the package');
eq(engineFromSource(doc('\\newcommand{\\pct}{\\%} % \\usepackage{fontspec}\n')), null, 'a real comment after an escaped \\% still hides it');

// ---- archive-level precedence ----
const files = { 'latexmkrc': B('$pdf_mode = 5;'), 'main.tex': B(doc('\\usepackage{luacode}\n')) };
eq(detectEngine(files, 'main.tex'), { engine: 'xelatex', reason: 'latexmkrc in the archive' }, 'latexmkrc beats the package sniff');
eq(detectEngine({ '.latexmkrc': B('$pdf_mode = 4;'), 'main.tex': B(doc()) }, 'main.tex').engine, 'lualatex', 'dotfile spelling');
eq(detectEngine({ 'paper/latexmkrc': B('$pdf_mode = 5;'), 'paper/main.tex': B(doc()) }, 'paper/main.tex').engine, 'xelatex', 'latexmkrc beside a nested root');
eq(detectEngine({ 'latexmkrc': B('$pdf_mode = 4;'), 'paper/latexmkrc': B('$pdf_mode = 5;'), 'paper/main.tex': B(doc()) }, 'paper/main.tex').engine, 'xelatex', 'the latexmkrc beside the root wins over the top-level one');
eq(detectEngine({ 'latexmkrc': B('$bibtex_use = 2;'), 'main.tex': B(doc('\\usepackage{xepersian}\n')) }, 'main.tex'), { engine: 'xelatex', reason: 'the xepersian package in the main document' }, 'silent latexmkrc falls through to the root');
eq(detectEngine({ 'latexmkrc': B("$pdflatex = 'pdflatex -synctex=1 %O %S';"), 'main.tex': B(doc('\\usepackage{xepersian}\n')) }, 'main.tex'), { engine: 'xelatex', reason: 'the xepersian package in the main document' }, 'a flags-only $pdflatex line does not override a root that needs XeLaTeX');
eq(detectEngine({ 'latexmkrc': B(allThree), 'main.tex': B(doc('\\usepackage{xepersian}\n')) }, 'main.tex'), { engine: 'xelatex', reason: 'the xepersian package in the main document' }, 'an rc that flags all three engines leaves the root to decide');
eq(detectEngine({ 'latexmkrc': B(allThree), 'main.tex': B(doc()) }, 'main.tex'), { engine: 'pdf', reason: null }, 'and a plain root under it stays on pdflatex');
eq(detectEngine({ 'latexmkrc': B('$pdf_mode = 1;'), 'main.tex': B(doc('\\usepackage{fontspec}\n')) }, 'main.tex'), { engine: 'pdf', reason: null }, 'explicit $pdf_mode 1 overrides the sniff, with no reason to report');
eq(detectEngine({ 'main.tex': B(doc()) }, 'main.tex'), { engine: 'pdf', reason: null }, 'default');
eq(detectEngine({ 'chapter.tex': B('\\usepackage{fontspec}') }, undefined), { engine: 'pdf', reason: null }, 'no root: nothing to sniff');
eq(detectEngine({ 'main.tex': B('%'.repeat(300 * 1024) + '\n' + doc('\\usepackage{fontspec}\n')) }, 'main.tex').engine, 'pdf', 'a preamble past the scan window is not seen');

// ---- decoding ----
eq(decodeText(B('caf\u00e9')), { text: 'café', transcoded: false }, 'valid UTF-8 passes through');
const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9]); // "café" in Latin-1
eq(decodeText(latin1), { text: 'café', transcoded: true }, 'Latin-1 bytes are transcoded');
const inputenc = Buffer.concat([B('\\usepackage[latin1]{inputenc}\n\\usepackage[T1]{fontenc}\ncaf'), Buffer.from([0xe9])]);
eq(decodeText(inputenc).text, '\\usepackage[latin1]{inputenc}\n\\usepackage[T1]{fontenc}\ncafé'.replace('[latin1]', '[utf8]'), 'a transcoded file gets its inputenc switched to utf8');
eq(decodeText(Buffer.concat([B('\\usepackage[utf8]{inputenc} '), Buffer.from([0xe9])])).text, '\\usepackage[utf8]{inputenc} é', 'an inputenc already on utf8 is left alone');
eq(decodeText(B('\\usepackage[latin1]{inputenc}\ncaf\u00e9')).text, '\\usepackage[latin1]{inputenc}\ncafé', 'valid UTF-8 keeps its inputenc line untouched, even a wrong one');
check(!decodeText(B('')).transcoded, 'empty file is not a transcode');
eq(decodeText(Buffer.from([0xef, 0xbb, 0xbf, 0x41])), { text: '\ufeffA', transcoded: false }, 'a UTF-8 BOM is kept, so a valid file round-trips byte for byte');
const mixed = Buffer.concat([B('Z\u00fcrich und K\u00f6ln, '), Buffer.from([0xe9]), B(' fin')]);
eq(decodeText(mixed), { text: 'Z\u00fcrich und K\u00f6ln, \ufffd fin', transcoded: false }, 'a UTF-8 file with one stray byte keeps its multibyte characters');
const cp1252 = Buffer.concat([B('\\usepackage[ansinew]{inputenc}\nI'), Buffer.from([0x92]), B('m '), Buffer.from([0x93]), B('quoted'), Buffer.from([0x94]), B(' '), Buffer.from([0x96, 0x80])]);
eq(decodeText(cp1252), { text: '\\usepackage[utf8]{inputenc}\nI\u2019m \u201cquoted\u201d \u2013\u20ac', transcoded: true }, 'Windows-1252 punctuation survives and inputenc follows');
eq(decodeText(Buffer.from([0x49, 0x92, 0x6d])).text, 'I\u2019m', 'no inputenc: Windows-1252 is the default for the C1 range');
eq(decodeText(Buffer.concat([B('\\usepackage[latin9]{inputenc} '), Buffer.from([0xa4])])).text, '\\usepackage[utf8]{inputenc} \u20ac', 'latin9 decodes its euro sign');
eq(decodeText(Buffer.concat([B('\\usepackage[applemac]{inputenc} caf'), Buffer.from([0x8e])])).text, '\\usepackage[utf8]{inputenc} caf\u00e9', 'applemac decodes as Mac Roman');

console.log('detect: all checks passed');
