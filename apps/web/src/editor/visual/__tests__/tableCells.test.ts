import { describe, it, expect } from 'vitest';
import { cellParts } from '../widgets/cell';
import { multicolumnOf, parseTabular, specColumns } from '../widgets/table';
import { cellLatex, pastedCells } from '../cellText';
import { setVisualEngine } from '../context';
import { installMiniDom } from './miniDom';

installMiniDom();

describe('what a table cell shows (vis-13)', () => {
  it('draws styles, formulas, escapes and citations instead of their source', () => {
    expect(cellParts('\\textbf{Model}')).toEqual([{ style: 'cm-vis-b', parts: ['Model'] }]);
    expect(cellParts('95\\% at $p<0.05$')).toEqual(['95% at ', { math: 'p<0.05' }]);
    expect(cellParts('R\\&D~costs \\cite[p.~3]{knuth}')).toEqual(['R&D\u00a0costs ', { cite: 'knuth', notes: ['p.~3'] }]);
    expect(cellParts('{\\bf Old} style')).toEqual([{ style: '', parts: [{ style: 'cm-vis-b', parts: ['Old'] }] }, ' style']);
    expect(cellParts('\\emph{a \\textit{b}}')).toEqual([{ style: 'cm-vis-i', parts: ['a ', { style: 'cm-vis-i', parts: ['b'] }] }]);
    expect(cellParts('10\\textsuperscript{-3} and \\ldots{} see \\ref{tab:a}')).toEqual(['10', { style: 'cm-vis-sup', parts: ['-3'] }, ' and … see ', { ref: 'tab:a' }]);
  });

  it('shows a \\multicolumn or \\multirow as its content, and an unknown command as written', () => {
    expect(cellParts('\\multicolumn{2}{c}{\\textbf{Results}}')).toEqual([{ style: 'cm-vis-b', parts: ['Results'] }]);
    expect(cellParts('\\multirow{2}{*}{Group A}')).toEqual(['Group A']);
    expect(cellParts('\\multirow[t]{3}{2cm}[1ex]{B}')).toEqual(['B']);
    expect(cellParts('\\hfill x \\unknown{y}')).toEqual([' x \\unknown', { style: '', parts: ['y'] }]);
    expect(cellParts('a\\ldots b')).toEqual(['a…b']);
    expect(cellParts('$5 and \\$6')).toEqual(['$5 and $6']);
  });
});

describe('merged cells and the column spec (vis-13, vis-14)', () => {
  it('reads a cell that is one \\multicolumn: its span, spec and the content its editor edits', () => {
    const text = '\\multicolumn{2}{|c|}{Two {cols}}';
    const m = multicolumnOf(text, 10)!;
    expect(m).toMatchObject({ span: 2, spec: '|c|', body: { text: 'Two {cols}' } });
    expect(text.slice(m.body.from - 10, m.body.to - 10)).toBe('Two {cols}');
    expect(text.slice(m.spanAt[0] - 10, m.spanAt[1] - 10)).toBe('2');
    expect(multicolumnOf('\\multicolumn{2}{c}{x} \\hfill', 0)).toBeNull();
    const parsed = parseTabular('\n\\multicolumn{2}{c}{Head} \\\\\na & b \\\\\n', 0)!;
    expect(parsed.rows[0][0].multi?.span).toBe(2);
    expect(parsed.breaks.map(Boolean)).toEqual([true, true]);
  });

  it('lists the spec\'s columns with their widths and decorations, between rules and padding', () => {
    const spec = '@{}|>{\\centering}p{3cm}|l<{\\,}!{\\vrule}S[table-format=2.1]r@{}';
    expect(specColumns(spec, 0)!.map((c) => [c.text, c.letter])).toEqual([
      ['>{\\centering}p{3cm}', 'p'], ['l<{\\,}', 'l'], ['S[table-format=2.1]', 'S'], ['r', 'r'],
    ]);
    expect(specColumns('*{3}{c}', 0)).toBeNull();
  });
});

describe('typing into a cell (vis-6)', () => {
  it('escapes a bare % and & anywhere outside a formula, so the row stays a row', () => {
    expect(cellLatex('91', '91%')).toBe('91\\%');
    expect(cellLatex('', 'R&D')).toBe('R\\&D');
    expect(cellLatex('50\\%', '50%')).toBe('50\\%');
    expect(cellLatex('', '\\textbf{R&D}')).toBe('\\textbf{R\\&D}');
    expect(cellLatex('', '\\url{a%20b&c}')).toBe('\\url{a%20b&c}');
  });

  it('keeps formulas and what is escaped already, and escapes other specials only where the person typed', () => {
    expect(cellLatex('', '$p<0.05$ at 5%')).toBe('$p<0.05$ at 5\\%');
    expect(cellLatex('', 'R\\&D for \\$5')).toBe('R\\&D for \\$5');
    expect(cellLatex('', 'costs $5 and a_b #3')).toBe('costs \\$5 and a\\_b \\#3');
    // a cell's own LaTeX keeps its bytes when the edit is elsewhere in it
    expect(cellLatex('5~km', '5~km_x')).toBe('5~km\\_x');
    expect(cellLatex('{\\bf x}', '{\\bf x} y')).toBe('{\\bf x} y');
    expect(cellLatex('$a$ b', '$a$ b')).toBe('$a$ b');
  });
});

describe('pasting into a cell (vis-6)', () => {
  it('converts a one-cell paste as Visual does, on one line', () => {
    expect(pastedCells('', '91% of R&D', '')).toEqual([['91\\% of R\\&D']]);
    expect(pastedCells('<p>Mean <b>gain</b></p>', 'Mean gain', '')).toEqual([['Mean \\textbf{gain}']]);
    expect(pastedCells('<b>Bold</b> 5%', 'Bold 5%', '')).toEqual([['\\textbf{Bold} 5\\%']]);
    expect(pastedCells('<ul><li>One</li></ul>', 'One', '')).toEqual([['One']]);
  });

  it('spreads tabs and line breaks over cells and rows, a quoted spreadsheet cell staying one', () => {
    expect(pastedCells('', 'a\tb%\r\nc\t"two\nlines"\r\n', '')).toEqual([['a', 'b\\%'], ['c', 'two lines']]);
    expect(pastedCells('', 'x\n$y_1$\n', '')).toEqual([['x'], ['$y_1$']]);
  });

  it('writes Unicode math as commands for pdfLaTeX', () => {
    try {
      setVisualEngine('pdf');
      expect(pastedCells('', 'α\t≤ 5', '')).toEqual([['\\ensuremath{\\alpha}', '\\ensuremath{\\le} 5']]);
    } finally {
      setVisualEngine(null);
    }
  });
});
