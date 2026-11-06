import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { latex } from 'codemirror-lang-latex';
import { pasteText, rawAt, recordOwnCopies } from '../clipboard';
import { htmlToLatex } from '../html2latex';
import { definesUrl, preambleOf } from '../preamble';
import { setVisualEngine } from '../context';
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

  it('takes \\(…\\), \\[…\\], $$…$$, thin spaces and line breaks as LaTeX', () => {
    expect(pasteText('', 'inline \\(x^2\\) here', '')).toBeNull();
    expect(pasteText('', '\\[\n  a_1 + b\n\\]', '')).toBeNull();
    expect(pasteText('', '$$ x^2 $$', '')).toBeNull();
    expect(pasteText('', 'it is 5\\,km', '')).toBeNull();
    expect(pasteText('', 'first line\\\\ second', '')).toBeNull();
    expect(pasteText('', 'share \\\\server\\files 50%', '')).toBe('share \\textbackslash{}\\textbackslash{}server\\textbackslash{}files 50\\%');
  });
});

describe('a Google Docs or Word paste with LaTeX in it (vis-8)', () => {
  const run = (text: string, style = 'font-weight:400;font-style:normal;') =>
    `<span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;${style}font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">${text}</span>`;
  const para = (...runs: string[]) => `<p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;">${runs.join('')}</p>`;
  const docs = (...blocks: string[]) =>
    `<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-6a1b2c3d-7fff-4e21-9c0d-1f2e3d4c5b6a">${blocks.join('')}</b><br class="Apple-interchange-newline">`;

  it('keeps a \\cite and escapes the percent in the same paragraph', () => {
    const html = docs(para(run('As shown by \\cite{knuth84}, 50% of the R&amp;D budget_total goes to #3.')));
    const text = 'As shown by \\cite{knuth84}, 50% of the R&D budget_total goes to #3.';
    expect(pasteText(html, text, '')).toBe('As shown by \\cite{knuth84}, 50\\% of the R\\&D budget\\_total goes to \\#3.');
  });

  it('keeps formulas, ties, escapes and references, and still converts headings, bold and lists', () => {
    const html = docs(
      `<h1 dir="ltr" style="line-height:1.38;margin-top:20pt;margin-bottom:6pt;">${run('Results &amp; costs')}</h1>`,
      para(run('We see '), run('fast', 'font-weight:700;font-style:normal;'), run(' growth of $x_1 + y^2$ (Fig.~3, Table~\\ref{tab:a}) for 30\\% and 40% of users, $2n$ steps, and \\(a^b\\).')),
      `<ul style="margin-top:0;margin-bottom:0;padding-inline-start:48px;"><li dir="ltr" aria-level="1" style="list-style-type:disc;"><p dir="ltr" role="presentation">${run('One in $5 \\cite[p.~3]{lamport}')}</p></li></ul>`,
      para(run('Prices run from $5 to $10, and C:\\Users\\me holds the data.')),
    );
    const text = 'Results & costs\nWe see fast growth of $x_1 + y^2$ (Fig.~3, Table~\\ref{tab:a}) for 30\\% and 40% of users, $2n$ steps, and \\(a^b\\).\nOne in $5 \\cite[p.~3]{lamport}\nPrices run from $5 to $10, and C:\\Users\\me holds the data.';
    expect(pasteText(html, text, '')).toBe([
      '\\section{Results \\& costs}',
      'We see \\textbf{fast} growth of $x_1 + y^2$ (Fig.~3, Table~\\ref{tab:a}) for 30\\% and 40\\% of users, $2n$ steps, and \\(a^b\\).',
      '',
      '\\begin{itemize}',
      '\\item One in \\$5 \\cite[p.~3]{lamport}',
      '\\end{itemize}',
      'Prices run from \\$5 to \\$10, and C:\\textbackslash{}Users\\textbackslash{}me holds the data.',
    ].join('\n'));
  });

  it('keeps LaTeX whole when Docs splits it across runs, as it does for a link inside \\url{…}', () => {
    const link = `<a href="https://example.org/a_b" style="text-decoration:none;">${run('https://example.org/a_b', 'font-weight:400;font-style:normal;color:#1155cc;text-decoration:underline;')}</a>`;
    const html = docs(para(run('Data at \\url{'), link, run('} for 50% more.')));
    const text = 'Data at \\url{https://example.org/a_b} for 50% more.';
    expect(pasteText(html, text, '')).toBe('Data at \\url{https://example.org/a_b} for 50\\% more.');
    expect(pasteText(html, text, '\\usepackage{url}\n\\begin{document}\n')).toBe('Data at \\url{https://example.org/a_b} for 50\\% more.');
    // bold inside a command keeps its braces balanced
    expect(htmlToLatex(docs(para(run('\\emph{very '), run('bold', 'font-weight:700;'), run('} 5%'))))).toBe('\\emph{very \\textbf{bold}} 5\\%');
  });

  it('reads a % inside a one-line command or formula as a percent sign, except in an address', () => {
    expect(htmlToLatex(docs(para(run('Most\\footnote{About 50% of cases.} agree, and $x = 5%$.'))))).toBe('Most\\footnote{About 50\\% of cases.} agree, and $x = 5\\%$.');
    expect(htmlToLatex(docs(para(run('See \\url{https://example.org/a%20b} or 30\\%.'))))).toBe('See \\url{https://example.org/a%20b} or 30\\%.');
  });

  it('keeps a math environment or display math over several paragraphs, a line each', () => {
    const html = docs(
      para(run('Energy is')),
      para(run('\\begin{equation}')),
      para(run('E = mc^2 \\label{eq:e} % famous')),
      para(run('\\end{equation}')),
      para(run('and')),
      para(run('$$')),
      para(run('a_1 + b_2')),
      para(run('$$')),
      para(run('holds for 99% of it.')),
    );
    expect(htmlToLatex(html)).toBe([
      'Energy is',
      '',
      '\\begin{equation}',
      'E = mc^2 \\label{eq:e} % famous',
      '\\end{equation}',
      '',
      'and',
      '',
      '$$',
      'a_1 + b_2',
      '$$',
      '',
      'holds for 99\\% of it.',
    ].join('\n'));
    // an environment that never ends is a command like any other
    expect(htmlToLatex(docs(para(run('\\begin{equation}')), para(run('x^2 at 5%'))))).toBe('\\begin{equation}\n\nx\\textasciicircum{}2 at 5\\%');
  });

  it('converts a Word paste the same way', () => {
    const html = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta name=Generator content="Microsoft Word 15"><style><!-- p.MsoNormal {margin:0cm; font-family:"Calibri",sans-serif;} --></style></head><body lang=EN-GB style=\'tab-interval:36.0pt;word-wrap:break-word\'><!--StartFragment--><p class=MsoNormal>Costs rose by 30% (see\r\n\\cite{smith}) and <b>R&amp;D</b> grew by $\\Delta$.<o:p></o:p></p><!--EndFragment--></body></html>';
    expect(pasteText(html, 'Costs rose by 30% (see \\cite{smith}) and R&D grew by $\\Delta$.', '')).toBe('Costs rose by 30\\% (see \\cite{smith}) and \\textbf{R\\&D} grew by $\\Delta$.');
  });

  it('pastes LaTeX copied from a code editor with its colours as it is', () => {
    const vscode = '<meta charset=\'utf-8\'><div style="color: #cccccc;background-color: #1f1f1f;font-family: Menlo, Monaco, \'Courier New\', monospace;font-weight: normal;font-size: 12px;line-height: 18px;white-space: pre;"><div><span style="color: #569cd6;">\\section</span><span style="color: #cccccc;">{Intro} </span><span style="color: #6a9955;">% 50% done</span></div><div><span style="color: #cccccc;">See </span><span style="color: #569cd6;">\\cite</span><span style="color: #cccccc;">{knuth}.</span></div></div>';
    expect(pasteText(vscode, '\\section{Intro} % 50% done\nSee \\cite{knuth}.', '')).toBeNull();
    const jetbrains = '<html><head><meta http-equiv="content-type" content="text/html; charset=UTF-8"></head><body><pre style="background-color:#1e1f22;color:#bcbec4;font-family:\'JetBrains Mono\',monospace;font-size:9.8pt;"><span style="color:#cf8e6d;">\\item </span>50% done</pre></body></html>';
    expect(pasteText(jetbrains, '\\item 50% done', '')).toBeNull();
    // one run set in Courier New does not make a document code
    const mixed = docs(para(run('Call '), run('\\cite{x}', 'font-weight:400;font-family:\'Courier New\',monospace;'), run(' at 5%.')));
    expect(pasteText(mixed, 'Call \\cite{x} at 5%.', '')).toBe('Call \\cite{x} at 5\\%.');
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

describe('superscripts, subscripts and struck text (vis-19)', () => {
  it('keeps <sup>, <sub> and Google Docs\' raised runs, drops deleted text and keeps struck text plain', () => {
    expect(htmlToLatex('<p>About 10<sup>-3</sup> s for H<sub>2</sub>O.</p>')).toBe('About 10\\textsuperscript{-3} s for H\\textsubscript{2}O.');
    const docs = '<b style="font-weight:normal;" id="docs-internal-guid-1"><p dir="ltr"><span style="font-weight:400;vertical-align:baseline;">x</span><span style="font-size:0.6em;vertical-align:super;">2</span><span style="vertical-align:sub;">i</span></p></b>';
    expect(htmlToLatex(docs)).toBe('x\\textsuperscript{2}\\textsubscript{i}');
    expect(htmlToLatex('<p>Keep <del>old </del>new and <s>struck</s> and <strike>gone</strike> text.</p>')).toBe('Keep new and struck and gone text.');
    // Word's tracked changes: the deletion goes, the insertion stays
    expect(htmlToLatex('<p class=MsoNormal>We <del cite="mailto:Ada" datetime="2026-11-05T10:00">never </del><ins cite="mailto:Ada" datetime="2026-11-05T10:00">always </ins>agree.<o:p></o:p></p>')).toBe('We always agree.');
    // nested markup is not raised twice
    expect(htmlToLatex('<p>e<sup><span style="vertical-align:super">x</span></sup></p>')).toBe('e\\textsuperscript{x}');
  });
});

describe('desktop Word lists and numbered headings (vis-18)', () => {
  const marker = (m: string, font = '') =>
    `<![if !supportLists]><span style='${font}mso-fareast-font-family:Symbol'><span style='mso-list:Ignore'>${m}<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; </span></span></span><![endif]>`;
  const item = (level: number, m: string, text: string, list = 'l0', font = 'font-family:Symbol;') =>
    `<p class=MsoListParagraphCxSpMiddle style='margin-left:${36 * level}.0pt;text-indent:-18.0pt;mso-list:${list} level${level} lfo1'>${marker(m, font)}${text}<o:p></o:p></p>\r\n`;
  const word = (body: string) => `<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta name=Generator content="Microsoft Word 15"></head><body lang=EN-GB><!--StartFragment-->${body}<!--EndFragment--></body></html>`;

  it('groups bullet paragraphs into itemize, nested by level, without Word\'s bullet characters', () => {
    const html = word(`<p class=MsoNormal>Before.<o:p></o:p></p>\r\n${item(1, '·', 'First <b>point</b>')}${item(2, 'o', 'Sub point', 'l0', 'font-family:"Courier New";')}${item(1, '·', 'Second, at 50%')}<p class=MsoNormal>After.<o:p></o:p></p>`);
    expect(htmlToLatex(html)).toBe([
      'Before.',
      '',
      '\\begin{itemize}',
      '\\item First \\textbf{point}',
      '\\begin{itemize}',
      '\\item Sub point',
      '\\end{itemize}',
      '\\item Second, at 50\\%',
      '\\end{itemize}',
      'After.',
    ].join('\n'));
  });

  it('makes numbered paragraphs an enumerate, with lettered sub-items', () => {
    const html = word(`${item(1, '1.', 'One', 'l1', '')}${item(2, 'a.', 'One a', 'l1', '')}${item(1, '2.', 'Two', 'l1', '')}`);
    expect(htmlToLatex(html)).toBe('\\begin{enumerate}\n\\item One\n\\begin{enumerate}\n\\item One a\n\\end{enumerate}\n\\item Two\n\\end{enumerate}');
  });

  it('drops the number Word writes before a numbered heading', () => {
    const h = (tag: string, n: string, text: string) =>
      `<${tag} style='margin-left:21.6pt;text-indent:-21.6pt;mso-list:l2 level1 lfo2'><![if !supportLists]><span style='mso-list:Ignore'>${n}<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp; </span></span><![endif]>${text}<o:p></o:p></${tag}>`;
    expect(htmlToLatex(word(`${h('h1', '1', 'Introduction')}${h('h2', '1.1', 'Scope &amp; aims')}`))).toBe('\\section{Introduction}\n\n\\subsection{Scope \\& aims}');
  });
});

describe('formulas from web pages and Word (vis-21)', () => {
  const katex = (tex: string, glyphs: string, display = false) =>
    `<span class="katex${display ? '-display' : ''}"><span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"${display ? ' display="block"' : ''}><semantics><mrow><mi>E</mi><mo>=</mo><mi>m</mi><msup><mi>c</mi><mn>2</mn></msup></mrow><annotation encoding="application/x-tex">${tex}</annotation></semantics></math></span><span class="katex-html" aria-hidden="true"><span class="base"><span class="mord mathnormal">${glyphs}</span></span></span></span></span>`;

  it('pastes a KaTeX formula (ChatGPT, many blogs) once, from its TeX', () => {
    expect(htmlToLatex(`<p>Energy ${katex('E=mc^2', 'E=mc2')} holds.</p>`)).toBe('Energy $E=mc^2$ holds.');
    expect(htmlToLatex(`<p>So</p>${katex('E = mc^2', 'E=mc2', true)}<p>and</p>`)).toBe('So\n\n\\[ E = mc^2 \\]and');
  });

  it('pastes Wikipedia\'s formula from its TeX, without its image', () => {
    const wiki = '<p>Sum <span class="mwe-math-element"><span class="mwe-math-mathml-inline mwe-math-mathml-a11y" style="display: none;"><math xmlns="http://www.w3.org/1998/Math/MathML" alttext="{\\displaystyle \\alpha +\\beta }"><semantics><mrow class="MJX-TeXAtom-ORD"><mstyle displaystyle="true" scriptlevel="0"><mi>α</mi><mo>+</mo><mi>β</mi></mstyle></mrow><annotation encoding="application/x-tex">{\\displaystyle \\alpha +\\beta }</annotation></semantics></math></span><img src="https://wikimedia.org/api/rest_v1/media/math/render/svg/1" class="mwe-math-fallback-image-inline" aria-hidden="true" alt="{\\displaystyle \\alpha +\\beta }"></span> of 50%.</p>';
    expect(htmlToLatex(wiki)).toBe('Sum $\\alpha +\\beta$ of 50\\%.');
  });

  it('pastes arXiv\'s HTML formulas from their TeX', () => {
    const arxiv = '<p class="ltx_p">where <math id="S1.p1.m1" class="ltx_Math" alttext="x_{i}" display="inline"><semantics><msub><mi>x</mi><mi>i</mi></msub><annotation encoding="application/x-tex">x_{i}</annotation></semantics></math> and</p><table class="ltx_equation ltx_eqn_table"><tr class="ltx_equation ltx_eqn_row"><td class="ltx_eqn_cell ltx_align_center"><math alttext="\\sum_{i=1}^{n}x_{i}" display="block"><semantics><mrow><mo>∑</mo></mrow><annotation-xml encoding="MathML-Content"><apply>sum</apply></annotation-xml><annotation encoding="application/x-tex">\\sum_{i=1}^{n}x_{i}</annotation></semantics></math></td><td class="ltx_eqn_cell ltx_eqn_eqno ltx_align_right" rowspan="1"><span class="ltx_tag ltx_tag_equation">(1)</span></td></tr></table>';
    expect(htmlToLatex(arxiv)).toBe('where $x_{i}$ and\n\n\\[ \\sum_{i=1}^{n}x_{i} \\]');
    // an aligned equation: its parts, split at the alignment, make one formula per row
    const cell = (tex: string) => `<td class="ltx_eqn_cell"><math alttext="${tex}" display="inline"><semantics><mi>a</mi><annotation encoding="application/x-tex">${tex}</annotation></semantics></math></td>`;
    expect(htmlToLatex(`<table class="ltx_equationgroup ltx_eqn_align ltx_eqn_table"><tbody><tr class="ltx_eqn_row">${cell('\\displaystyle a')}${cell('\\displaystyle=b+c')}<td class="ltx_eqn_cell ltx_eqn_eqno"><span>(2)</span></td></tr></tbody></table>`)).toBe('\\[ a =b+c \\]');
  });

  it('reads MathJax 3\'s MathML when it carries no TeX, and MathJax 2\'s TeX script once', () => {
    const mj3 = '<p>Then <mjx-container class="MathJax CtxtMenu_Attached_0" jax="CHTML"><mjx-math class="MJX-TEX" aria-hidden="true"><mjx-mi class="mjx-i"><mjx-c class="mjx-c1D465 TEX-I"></mjx-c></mjx-mi></mjx-math><mjx-assistive-mml unselectable="on" display="inline"><math xmlns="http://www.w3.org/1998/Math/MathML"><msup><mi>x</mi><mn>2</mn></msup><mo>≤</mo><mfrac><mn>1</mn><mi>α</mi></mfrac></math></mjx-assistive-mml></mjx-container> holds.</p>';
    expect(htmlToLatex(mj3)).toBe('Then $x^{2}\\le \\frac{1}{\\alpha}$ holds.');
    const mj2 = '<p>Let <span class="MathJax_Preview" style="color: inherit; display: none;"></span><span class="MathJax" id="MathJax-Element-1-Frame" tabindex="0" role="presentation"><nobr aria-hidden="true"><span class="math"><span>x1+y</span></span></nobr><span class="MJX_Assistive_MathML" role="presentation"><math xmlns="http://www.w3.org/1998/Math/MathML"><msub><mi>x</mi><mn>1</mn></msub><mo>+</mo><mi>y</mi></math></span></span><script type="math/tex" id="MathJax-Element-1">x_1 + y</script> be.</p>';
    expect(htmlToLatex(mj2)).toBe('Let $x_1 + y$ be.');
  });

  it('turns Word\'s equations into LaTeX instead of dropping them with their image', () => {
    const span = (t: string) => `<i><span style='font-family:"Cambria Math",serif'><m:r>${t}</m:r></span></i>`;
    const inline = `<!--[if gte msEquation 12]><m:oMath>${span('E')}${span('=')}${span('m')}<m:sSup><m:sSupPr><span style='font-family:"Cambria Math",serif'><i>x</i></span></m:sSupPr><m:e>${span('c')}</m:e><m:sup>${span('2')}</m:sup></m:sSup></m:oMath><![endif]-->`;
    const image = '<![if !msEquation]><span style=\'font-size:11.0pt;position:relative;top:3.0pt\'><img width=55 height=19 src="file:///C:/Users/me/AppData/Local/Temp/msohtmlclip1/01/clip_image001.png"></span><![endif]>';
    expect(htmlToLatex(`<p class=MsoNormal>So ${inline}${image} holds.<o:p></o:p></p>`)).toBe('So $E=mc^{2}$ holds.');
    const display = '<!--[if gte msEquation 12]><m:oMathPara><m:oMath><m:f><m:fPr><m:ctrlPr></m:ctrlPr></m:fPr><m:num><m:r>α</m:r></m:num><m:den><m:r>2</m:r></m:den></m:f><m:r>≤</m:r><m:nary><m:naryPr><m:chr m:val="∑"/><m:limLoc m:val="undOvr"/></m:naryPr><m:sub><m:r>i=1</m:r></m:sub><m:sup><m:r>n</m:r></m:sup><m:e><m:sSub><m:e><m:r>x</m:r></m:e><m:sub><m:r>i</m:r></m:sub></m:sSub></m:e></m:nary><m:r>+</m:r><m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg></m:deg><m:e><m:r>y</m:r></m:e></m:rad><m:func><m:fName><m:r>sin</m:r></m:fName><m:e><m:d><m:e><m:r>θ</m:r></m:e></m:d></m:e></m:func></m:oMath></m:oMathPara><![endif]-->';
    expect(htmlToLatex(`<p class=MsoNormal>${display}${image}<o:p></o:p></p>`)).toBe('\\[ \\frac{\\alpha}{2}\\le \\sum_{i=1}^{n} x_{i}+\\sqrt{y}\\sin \\left( \\theta \\right) \\]');
  });
});

describe('Unicode math in a pdfLaTeX project (vis-9)', () => {
  it('writes Greek letters and math symbols as commands, which pdfLaTeX can typeset', () => {
    try {
      setVisualEngine('pdf');
      expect(pasteText('', 'p ≤ 0.05 for α and Ω, x ≠ y', '')).toBe('p \\ensuremath{\\le} 0.05 for \\ensuremath{\\alpha} and \\ensuremath{\\Omega}, x \\ensuremath{\\neq} y');
      // what pdfLaTeX typesets as it is stays as it is
      expect(pasteText('', '3 × 4 ± 1 at 20 °C', '')).toBeNull();
      expect(pasteText('<p>Mean <b>μ</b> ≈ 5%</p>', 'Mean μ ≈ 5%', '')).toBe('Mean \\textbf{\\ensuremath{\\mu}} \\ensuremath{\\approx} 5\\%');
      setVisualEngine('xelatex');
      expect(pasteText('', 'p ≤ 0.05 for α', '')).toBeNull();
      expect(pasteText('<p>Mean <b>μ</b> ≈ 5%</p>', 'Mean μ ≈ 5%', '')).toBe('Mean \\textbf{μ} ≈ 5\\%');
    } finally {
      setVisualEngine(null);
    }
  });
});
