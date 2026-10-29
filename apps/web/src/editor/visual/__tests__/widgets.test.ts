import { describe, it, expect } from 'vitest';
import { Compartment, EditorState, EditorSelection } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { closeBrackets, insertBracket } from '@codemirror/autocomplete';
import { latex } from 'codemirror-lang-latex';
import { buildAtomic, buildMarks, headingLineTail, mathParts } from '../decorations';
import { breakAfterHeading } from '../commands';
import { revealField } from '../reveal';
import { parseTabular, tableModel } from '../widgets/table';
import { citeChip } from '../widgets/chips';
import { mathEdit, mathliveCanEdit, roundTrips } from '../mathPopover';
import { commentRangesField, suggestField } from '../suggestions';
import { setComments } from '../../commentsEffect';
import { closeBeginBrace } from '../../beginEnv';
import { parsedState } from './parsedState';

function state(doc: string, anchor = doc.length) {
  return parsedState({ doc, selection: { anchor }, extensions: [latex(), revealField] });
}

function atomics(s: EditorState) {
  const out: Array<{ from: number; to: number; spec: Record<string, unknown> }> = [];
  buildAtomic(s, s.field(revealField).ranges).between(0, s.doc.length, (from, to, d) => { out.push({ from, to, spec: d.spec }); });
  return out;
}

function nodeNamed(s: EditorState, name: string) {
  let found = null as ReturnType<ReturnType<typeof syntaxTree>['resolve']> | null;
  syntaxTree(s).iterate({ enter(n) { if (!found && n.name === name) { found = n.node; return false; } } });
  return found!;
}

describe('table grid (VIS-06)', () => {
  it('never turns a %-comment line into a row and keeps \\\\[2pt] out of the next cell', () => {
    const body = '\na & b \\& c & {x & y} \\\\[2pt]\n% commented row & z & z \\\\\n1 & 2 & 3 \\\\\n';
    const parsed = parseTabular(body, 0)!;
    expect(parsed.rows.map((r) => r.map((c) => c.text))).toEqual([
      ['a', 'b \\& c', '{x & y}'],
      ['1', '2', '3'],
    ]);
    // offsets are exact source spans
    for (const row of parsed.rows) for (const c of row) expect(body.slice(c.from, c.to)).toBe(c.text);
  });

  it('marks a cell with a comment inside as source-only', () => {
    const parsed = parseTabular('a & b % note\n c \\\\\n', 0)!;
    expect(parsed.rows[0][1].raw).toBe('comment');
    expect(parsed.rows[0][0].raw).toBeUndefined();
  });

  it('marks a cell written over two lines as source-only, so a one-line field never joins its lines', () => {
    const parsed = parseTabular('\nLong text the author\nwrapped & b \\\\\n', 0)!;
    expect(parsed.rows[0][0]).toMatchObject({ text: 'Long text the author\nwrapped', raw: 'lines' });
    expect(parsed.rows[0][1].raw).toBeUndefined();
  });

  it('gives every cell the slot between its separators', () => {
    const body = '\n\\hline\na & {x & y} \\\\[2pt]\n  & c \\\\\n';
    const parsed = parseTabular(body, 0)!;
    expect(parsed.rows.flat().map((c) => body.slice(c.slot[0], c.slot[1]))).toEqual(['\n\\hline\na ', ' {x & y} ', '\n  ', ' c ']);
  });

  /** The document after "+ row", and the grid the table then has. */
  function addRow(doc: string) {
    const s = state(doc, doc.length);
    const node = nodeNamed(s, 'TabularEnvironment');
    const model = tableModel(s.doc, node)!;
    const begin = node.getChild('BeginEnv')!;
    const end = node.getChild('EndEnv')!;
    for (const c of model.addRow) {
      expect(node.from + c.from).toBeGreaterThanOrEqual(begin.to);
      expect(node.from + c.from).toBeLessThanOrEqual(end.from);
    }
    const after = s.update({ changes: model.addRow.map((c) => ({ from: node.from + c.from, insert: c.insert })) }).state.doc.toString();
    const s2 = state(after, after.length);
    const rows = tableModel(s2.doc, nodeNamed(s2, 'TabularEnvironment'))!.rows.map((r) => r.map((c) => c.text));
    return { after, rows };
  }

  it('"+ row" adds an empty row after the last one, inside the table', () => {
    expect(addRow('\\begin{tabular}{ll}\na & b \\\\\nc & d \\\\\n\\end{tabular}\n')).toEqual({
      after: '\\begin{tabular}{ll}\na & b \\\\\nc & d \\\\\n&  \\\\\n\\end{tabular}\n',
      rows: [['a', 'b'], ['c', 'd'], ['', '']],
    });
    // a last row without \\ gets one, instead of the new cells joining it
    expect(addRow('\\begin{tabular}{ll}\na & b \\\\\nc & d\n\\end{tabular}\n')).toEqual({
      after: '\\begin{tabular}{ll}\na & b \\\\\nc & d \\\\\n&  \\\\\n\\end{tabular}\n',
      rows: [['a', 'b'], ['c', 'd'], ['', '']],
    });
    // above the closing rule, below the last row's own comment
    expect(addRow('\\begin{tabular}{ll}\n\\toprule\na & b \\\\ % last\n\\bottomrule\n\\end{tabular}\n').after)
      .toBe('\\begin{tabular}{ll}\n\\toprule\na & b \\\\ % last\n&  \\\\\n\\bottomrule\n\\end{tabular}\n');
    expect(addRow('\\begin{tabular}{ll}\na & b % note\n\\end{tabular}\n').after)
      .toBe('\\begin{tabular}{ll}\na & b \\\\ % note\n&  \\\\\n\\end{tabular}\n');
    // a table written on one line, inside a sentence, stays on its line
    expect(addRow('Name: \\begin{tabular}{@{}l@{}}first\\\\second\\end{tabular} done')).toEqual({
      after: 'Name: \\begin{tabular}{@{}l@{}}first\\\\second \\\\ \\\\\\end{tabular} done',
      rows: [['first'], ['second'], ['']],
    });
  });

  it('finds the column spec inside \\begin, for every common shape', () => {
    for (const [begin, spec] of [
      ['\\begin{tabular}{ll}', 'll'],
      ['\\begin{tabular}{|l|c|}', '|l|c|'],
      ['\\begin{tabular}{@{}lr@{}}', '@{}lr@{}'],
      ['\\begin{tabular}{p{3cm}l}', 'p{3cm}l'],
      ['\\begin{tabular}[t]{lcr}', 'lcr'],
    ]) {
      const doc = `${begin}\na & b \\\\\n\\end{tabular}\n`;
      const s = state(doc, doc.length);
      const node = nodeNamed(s, 'TabularEnvironment');
      const model = tableModel(s.doc, node)!;
      expect(model.colSpec, begin).not.toBeNull();
      expect(doc.slice(node.from + model.colSpec!.from, node.from + model.colSpec!.to), begin).toBe(spec);
    }
  });
});

describe('"+ col" (#152)', () => {
  /** The column spec after "+ col". */
  function addCol(spec: string) {
    const doc = `\\begin{tabular}{${spec}}\na & b \\\\\n\\end{tabular}\n`;
    const s = state(doc, doc.length);
    const node = nodeNamed(s, 'TabularEnvironment');
    const model = tableModel(s.doc, node)!;
    const at = node.from + model.colInsert!.at;
    const after = doc.slice(0, at) + model.colInsert!.insert + doc.slice(at);
    return after.slice('\\begin{tabular}{'.length, after.indexOf('}\n'));
  }

  it('puts the new column inside the outer rule and padding', () => {
    expect(addCol('ll')).toBe('lll');
    expect(addCol('|l|c|')).toBe('|l|c|l|');
    expect(addCol('@{}lr@{}')).toBe('@{}lrl@{}');
    expect(addCol('l|c')).toBe('l|c|l');
    expect(addCol('lc|')).toBe('lcl|');
    expect(addCol('@{}l !{\\quad} r@{\\hspace{1em}}')).toBe('@{}l !{\\quad} rl@{\\hspace{1em}}');
    expect(addCol('lp{3cm}')).toBe('lp{3cm}l');
    expect(addCol('|lp{3cm}|')).toBe('|lp{3cm}l|');
  });
});

describe('display math (VIS-04)', () => {
  it('$$…$$ renders the formula between the inner dollars', () => {
    const doc = 'x $$ E = mc^2 $$ y';
    const s = state(doc, 0);
    const node = nodeNamed(s, 'DollarMath');
    const parts = mathParts('DollarMath', node, s.doc)!;
    expect(parts.source).toBe('E = mc^2');
    expect(parts.display).toBe(true);
    expect(doc.slice(parts.innerFrom, parts.innerTo)).toBe(' E = mc^2 ');
  });

  it('$…$ stays inline', () => {
    const s = state('a $x_i$ b', 0);
    const parts = mathParts('DollarMath', nodeNamed(s, 'DollarMath'), s.doc)!;
    expect(parts).toMatchObject({ source: 'x_i', display: false, innerFrom: 3, innerTo: 6 });
  });
});

describe('cite chips (VIS-08)', () => {
  it('show the optional notes', () => {
    expect(citeChip('knuth1984', ['p.~12']).label).toBe('knuth1984, p. 12');
    expect(citeChip('lamport1994,knuth1984', ['see', 'ch.~3']).label).toBe('see lamport1994,knuth1984, ch. 3');
    expect(citeChip('k', ['see', '']).label).toBe('see k');
    expect(citeChip('k').label).toBe('k');
  });

  it('read the notes off \\cite and \\citet', () => {
    const s = state('A \\cite[see][ch.~3]{a} and \\citet[p.~3]{b}.', 0);
    const labels = atomics(s).map((a) => (a.spec.widget as { label?: string } | undefined)?.label).filter(Boolean);
    expect(labels).toEqual(['see a, ch. 3', 'b, p. 3']);
  });
});

describe('formula editor write-back (VIS-02)', () => {
  it('refuses what MathLive would rewrite', () => {
    expect(mathliveCanEdit('x + y')).toBe(true);
    expect(mathliveCanEdit('50\\% of x')).toBe(true);
    expect(mathliveCanEdit('\\label{eq:one} f(x)')).toBe(false);
    expect(mathliveCanEdit('a &= b')).toBe(false);
    expect(mathliveCanEdit('a \\\\ b')).toBe(false);
    expect(mathliveCanEdit('f(x) % keep me')).toBe(false);
    expect(mathliveCanEdit('a\n+ b')).toBe(false);
    expect(mathliveCanEdit('\\begin{matrix}1\\end{matrix}')).toBe(false);
  });

  it('treats spacing and optional braces as the same formula, anything else as a rewrite', () => {
    expect(roundTrips(' E = mc^2 ', 'E=mc^2')).toBe(true);
    expect(roundTrips('x_{i}^{2}', 'x_{i}^2')).toBe(true);
    expect(roundTrips('\\frac{1}{2}x', '\\frac12x')).toBe(true);
    expect(roundTrips('\\R^n', '\\mathbb{R}^n')).toBe(false);
    expect(roundTrips('a \\le b', 'a\\leq b')).toBe(false);
  });

  it('reads spaces inside \\text as part of the formula, and spacing elsewhere as not', () => {
    expect(roundTrips('x \\text{a  b} y', 'x\\text{a b}y')).toBe(true);
    expect(roundTrips('\\text{a b}', '\\text{ab}')).toBe(false);
    expect(roundTrips('\\mathrm{a b}', '\\mathrm{ab}')).toBe(true);
    expect(roundTrips('\\textstyle a b', '\\textstyle ab')).toBe(true);
  });

  it('opens a formula written between line breaks, but not one with a line break inside', () => {
    expect(mathliveCanEdit('\n  E = mc^2\n')).toBe(true);
    expect(mathliveCanEdit('\n  a\n  + b\n')).toBe(false);
  });

  it('writes only the tokens the person changed', () => {
    // (raw, MathLive's canonical form before, after, its everyday form after)
    const apply = (raw: string, c0: string, c1: string, s1: string) => {
      const e = mathEdit(raw, c0, c1, s1)!;
      return raw.slice(0, e.from) + e.insert + raw.slice(e.to);
    };
    expect(apply(' E = mc^2 ', 'E=mc^2', 'E=mc^2+1', 'E=mc^2+1')).toBe(' E = mc^2+1 ');
    expect(apply('x + y', 'x+y', 'x+z', 'x+z')).toBe('x + z');
    expect(apply('x + y', 'x+y', '2x+y', '2x+y')).toBe('2x + y');
    expect(apply('x_{i}^{2}', 'x_{i}^2', 'x_{i}^2+1', 'x_{i}^2+1')).toBe('x_{i}^{2}+1');
    expect(apply('\\frac{1}{2} x', '\\frac12x', '\\frac13x', '\\frac{1}{3}x')).toBe('\\frac{1}{3} x');
    expect(apply('x^{2}', 'x^2', 'x^{23}', 'x^{23}')).toBe('x^{23}');
    expect(apply('\\alpha x', '\\alpha x', '\\alpha y', '\\alpha y')).toBe('\\alpha y');
    expect(apply('\\alpha', '\\alpha', '\\alpha b', '\\alpha b')).toBe('\\alpha b');
    expect(apply('a + b + c', 'a+b+c', 'a+c', 'a+c').replace(/\s+/g, '')).toBe('a+c');
    expect(mathEdit('\\R^n', '\\mathbb{R}^n', '\\mathbb{R}^n+1', '\\mathbb{R}^n+1')).toBeNull();
    // spaces typed inside \text are written, and new words keep the space before them
    expect(apply('x \\text{ab} y', 'x\\text{ab}y', 'x\\text{a b}y', 'x\\text{a b}y')).toBe('x \\text{a b} y');
    expect(apply('x \\text{a b} y', 'x\\text{a b}y', 'x\\text{ab}y', 'x\\text{ab}y')).toBe('x \\text{ab} y');
    expect(apply('x \\text{ if } y', 'x\\text{ if }y', 'x\\text{ if and only if }y', 'x\\text{ if and only if }y'))
      .toBe('x \\text{ if and only if } y');
    expect(apply('\n  E = mc^2\n', 'E=mc^2', 'E=mc^2+1', 'E=mc^2+1')).toBe('\n  E = mc^2+1\n');
  });
});

describe('lists and headings keep the caret inside (VIS-07)', () => {
  it('hides a list\'s \\begin/\\end lines whole', () => {
    const doc = '\\begin{itemize}\n\\item First\n\\item Second\n\\end{itemize}\nafter';
    const s = state(doc);
    const blocks = atomics(s).filter((a) => a.spec.block);
    expect(blocks.map((b) => doc.slice(b.from, b.to))).toEqual(['\\begin{itemize}', '\\end{itemize}']);
  });

  it('hides indented \\begin/\\end lines with their indentation', () => {
    const doc = '\\begin{itemize}\n  \\item A\n  \\begin{enumerate}\n    \\item B\n  \\end{enumerate}\n\\end{itemize}\nx';
    const s = state(doc);
    const blocks = atomics(s).filter((a) => a.spec.block).map((b) => doc.slice(b.from, b.to));
    expect(blocks).toEqual(['\\begin{itemize}', '  \\begin{enumerate}', '  \\end{enumerate}', '\\end{itemize}']);
  });

  it('a caret in the indentation of a hidden \\end line reveals it', () => {
    const doc = '\\begin{itemize}\n  \\item A\n  \\end{itemize}\nx';
    const s = state(doc, doc.indexOf('  \\end'));
    expect(s.field(revealField).ranges).toContainEqual({ from: doc.indexOf('\\end'), to: doc.indexOf('\\end') + '\\end{itemize}'.length });
  });

  it('marks the closing brace of a heading on its own line, and styles a run-in heading\'s argument only', () => {
    const doc = '\\section{Heading}\n\\paragraph{Para} body text\nend';
    const s = state(doc);
    const closer = atomics(s).find((a) => a.spec.headingCloser);
    expect(closer && doc.slice(closer.from, closer.to)).toBe('}');
    expect(closer!.from).toBe(doc.indexOf('}'));
    const marks: Array<[number, number, string]> = [];
    buildMarks(s, s.field(revealField).ranges, [{ from: 0, to: doc.length }]).between(0, doc.length, (f, t, d) => { marks.push([f, t, String(d.spec.class)]); });
    expect(marks.filter(([, , c]) => c.startsWith('cm-vis-h ')).length).toBe(1);
    const run = marks.find(([, , c]) => c === 'cm-vis-hrun')!;
    expect(doc.slice(run[0], run[1])).toBe('Para');
  });

  it('a \\label or a comment after a heading leaves it on its own line; body text does not', () => {
    for (const tail of ['', '  ', '\\label{sec:intro}', ' \\label{sec:setup} ', '\\label{a}\\label{b} % c', ' % note', '\\label {x}%']) {
      expect(headingLineTail(tail), JSON.stringify(tail)).toBe(true);
    }
    for (const tail of [' body', '\\label{x} text', ' \\% off', '\\labelx{y}', '\\ref{x}', '\\label{x']) {
      expect(headingLineTail(tail), JSON.stringify(tail)).toBe(false);
    }
  });

  it('renders a heading with a same-line \\label as a heading, and keeps run-in headings run-in', () => {
    const doc = [
      '\\section{Introduction}\\label{sec:intro}',
      '\\subsection{Setup} \\label{sec:setup}',
      '\\section{Labelled}\\label{sec:l} % note',
      '\\paragraph{Run-in} body \\label{p}',
      'end',
    ].join('\n');
    const s = state(doc);
    const marks: Array<[number, number, string]> = [];
    buildMarks(s, s.field(revealField).ranges, [{ from: 0, to: doc.length }]).between(0, doc.length, (f, t, d) => { marks.push([f, t, String(d.spec.class)]); });
    const lines = marks.filter(([, , c]) => c.startsWith('cm-vis-h ')).map(([f, , c]) => [s.doc.lineAt(f).number, c]);
    expect(lines).toEqual([[1, 'cm-vis-h cm-vis-h1'], [2, 'cm-vis-h cm-vis-h2'], [3, 'cm-vis-h cm-vis-h1']]);
    const runs = marks.filter(([, , c]) => c === 'cm-vis-hrun').map(([f, t]) => doc.slice(f, t));
    expect(runs).toEqual(['Run-in']);
    // a label alone after the closer hides with it, and End stops before both (#150)
    expect(atomics(s).filter((a) => a.spec.headingCloser).map((a) => doc.slice(a.from, a.to))).toEqual(['}\\label{sec:intro}', '} \\label{sec:setup}']);
  });
});

describe('Enter at a heading\'s closing brace', () => {
  function enter(doc: string, at: number, head = at) {
    let s = parsedState({ doc, selection: { anchor: at, head }, extensions: [latex(), revealField] });
    const ran = breakAfterHeading({ state: s, dispatch: (tr) => { s = tr.state; } });
    return { ran, doc: s.doc.toString(), head: s.selection.main.head };
  }

  it('starts the new line after the heading, with no indent', () => {
    const doc = 'Intro.\n\\section{Heading}\nBody.\n';
    const r = enter(doc, doc.indexOf('}'));
    expect(r).toEqual({ ran: true, doc: 'Intro.\n\\section{Heading}\n\nBody.\n', head: doc.indexOf('}') + 2 });
  });

  it('keeps a same-line \\label and comment with the heading, from the brace or the end of the line', () => {
    for (const tail of ['\\label{sec:intro}', ' \\label{sec:setup} % note', ' % note']) {
      const doc = `\\section{Heading}${tail}\nBody.`;
      for (const at of [doc.indexOf('}'), doc.indexOf('\n')]) {
        const r = enter(doc, at);
        expect(r.ran).toBe(true);
        expect(r.doc).toBe(`\\section{Heading}${tail}\n\nBody.`);
        expect(r.head).toBe(doc.indexOf('\n') + 1);
      }
    }
  });

  it('leaves Enter alone inside the heading text, at a run-in heading, between brace and label, and for a selection', () => {
    const doc = '\\section{Heading}\n\\paragraph{Run-in} body\n\\section{L}\\label{l}\nend';
    expect(enter(doc, doc.indexOf('ding')).ran).toBe(false);
    expect(enter(doc, doc.indexOf('} body')).ran).toBe(false);
    expect(enter(doc, doc.indexOf(' body\n') + 5).ran).toBe(false);
    expect(enter(doc, doc.indexOf('\\label')).ran).toBe(false);
    expect(enter(doc, doc.indexOf('Heading'), doc.indexOf('}')).ran).toBe(false);
    expect(enter(doc, doc.indexOf('end')).ran).toBe(false);
  });
});

describe('figures (VIS-16)', () => {
  it('take the figure\'s own caption, not a subfigure\'s', () => {
    const doc = '\\begin{figure}\n\\begin{subfigure}{0.4\\linewidth}\n\\caption{Left}\n\\end{subfigure}\n\\caption{Two panels}\n\\end{figure}\nx';
    const s = state(doc);
    const fig = atomics(s).find((a) => (a.spec.widget as { caption?: string } | undefined)?.caption !== undefined);
    expect((fig!.spec.widget as { caption: string }).caption).toBe('Two panels');
  });
});

describe('inline suggestions after a mode switch (VIS-09)', () => {
  it('are there when the visual layer mounts after the comments arrived', () => {
    const mode = new Compartment();
    let s = EditorState.create({ doc: 'More prose here.', extensions: [commentRangesField, mode.of([])] });
    s = s.update({ effects: setComments.of([{ id: 'c1', from: 0, to: 10, resolved: false, suggestion: 'Less prose' }]) }).state;
    s = s.update({ changes: { from: 0, insert: 'Yet ' } }).state;
    s = s.update({ effects: mode.reconfigure(suggestField) }).state; // Source → Visual
    const ranges: Array<[number, number, boolean]> = [];
    s.field(suggestField).deco.between(0, s.doc.length, (f, t, d) => { ranges.push([f, t, !!d.spec.widget]); });
    expect(ranges).toEqual([[4, 14, false], [14, 14, true]]);
  });
});

describe('typing \\begin{name} (VIS-12)', () => {
  function type(text: string, start = '') {
    let s = EditorState.create({ doc: start, selection: { anchor: start.length }, extensions: [closeBrackets()] });
    const view = { get state() { return s; }, dispatch: (spec: Parameters<EditorState['update']>[0]) => { s = s.update(spec).state; } };
    for (const ch of text) {
      if (ch === '}' && closeBeginBrace(view)) continue;
      const tr = insertBracket(s, ch);
      s = tr ? tr.state : s.update(s.replaceSelection(ch)).state;
    }
    return s;
  }

  it('closes the environment once, with no stray brace', () => {
    const s = type('\\begin{itemize}');
    expect(s.doc.toString()).toBe('\\begin{itemize}\n  \n\\end{itemize}');
    expect(s.selection.main.head).toBe('\\begin{itemize}\n  '.length);
  });

  it('keeps the indentation of the line', () => {
    const s = type('\\begin{enumerate}', '  ');
    expect(s.doc.toString()).toBe('  \\begin{enumerate}\n    \n  \\end{enumerate}');
  });

  it('leaves other braces to closeBrackets', () => {
    expect(type('\\textbf{x}').doc.toString()).toBe('\\textbf{x}');
  });
});

describe('selections', () => {
  it('a selection over a hidden list line reveals it', () => {
    const doc = '\\begin{itemize}\n\\item A\n\\end{itemize}\nx';
    const s = parsedState({ doc, selection: EditorSelection.single(0, doc.length), extensions: [latex(), revealField] });
    expect(atomics(s).filter((a) => a.spec.block)).toEqual([]);
  });
});
