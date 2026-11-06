import { describe, it, expect } from 'vitest';
import { EditorState, EditorSelection } from '@codemirror/state';
import { latex } from 'codemirror-lang-latex';
import { buildAtomic, buildMarks } from '../decorations';
import { computeRevealRanges, revealField } from '../reveal';
import { parsedState } from './parsedState';

function state(doc: string, selection?: { anchor: number; head?: number }) {
  return parsedState({
    doc,
    selection: selection ? EditorSelection.single(selection.anchor, selection.head ?? selection.anchor) : undefined,
    extensions: [latex(), revealField],
  });
}

function atomicRanges(s: EditorState) {
  const out: Array<[number, number]> = [];
  buildAtomic(s, s.field(revealField).ranges).between(0, s.doc.length, (from, to) => { out.push([from, to]); });
  return out;
}

function markRanges(s: EditorState) {
  const out: Array<[number, number, string]> = [];
  buildMarks(s, s.field(revealField).ranges, [{ from: 0, to: s.doc.length }]).between(0, s.doc.length, (from, to, deco) => {
    out.push([from, to, (deco.spec.class as string) ?? '']);
  });
  return out;
}

describe('visual decorations', () => {
  it('hides section markup and marks the heading line', () => {
    const s = state('\\section{Intro}\nBody text', { anchor: 20 }); // cursor in body prose
    // hide "\section{" [0,9) and "}" [14,15)
    expect(atomicRanges(s)).toEqual([[0, 9], [14, 15]]);
    const lines = markRanges(s).filter(([, , cls]) => cls.includes('cm-vis-h'));
    expect(lines).toEqual([[0, 0, 'cm-vis-h cm-vis-h1']]);
  });

  it('ranks subsection and subsubsection headings', () => {
    const s = state('\\subsection{A}\n\\subsubsection{B}\nx', { anchor: 33 });
    const classes = markRanges(s).map(([, , cls]) => cls);
    expect(classes).toContain('cm-vis-h cm-vis-h2');
    expect(classes).toContain('cm-vis-h cm-vis-h3');
  });

  it('hides bold markup and marks the interior', () => {
    const s = state('a \\textbf{bold} b');
    expect(atomicRanges(s)).toEqual([[2, 10], [14, 15]]);
    expect(markRanges(s)).toEqual([[10, 14, 'cm-vis-b']]);
  });

  it('styles emph as italic', () => {
    const s = state('\\emph{x} y', { anchor: 10 });
    expect(markRanges(s)).toEqual([[6, 7, 'cm-vis-i']]);
  });

  it('renders nested bold inside a heading', () => {
    const s = state('\\section{A \\textbf{big} deal}\nx', { anchor: 31 });
    const marks = markRanges(s);
    expect(marks.some(([, , cls]) => cls === 'cm-vis-b')).toBe(true);
    // both the heading braces and the nested bold braces are hidden
    expect(atomicRanges(s).length).toBe(4);
  });

  it('leaves unclosed constructs as raw source', () => {
    const s = state('x \\textbf{never closed', { anchor: 0 });
    expect(atomicRanges(s)).toEqual([]);
    expect(markRanges(s)).toEqual([]);
  });

  it('never decorates inside verbatim', () => {
    const s = state('\\begin{verbatim}\n\\textbf{not bold}\n\\end{verbatim}\nx', { anchor: 49 });
    expect(atomicRanges(s)).toEqual([]);
  });

  it('leaves unknown commands untouched', () => {
    const s = state('\\weirdmacro{x}{y} z', { anchor: 19 });
    expect(atomicRanges(s)).toEqual([]);
    expect(markRanges(s)).toEqual([]);
  });

  it('reveals a construct containing the cursor', () => {
    const doc = 'a \\textbf{bold} b';
    const s = state(doc, { anchor: 12 }); // cursor inside "bold"
    expect(s.field(revealField).ranges).toEqual([{ from: 2, to: 15 }]);
    expect(atomicRanges(s)).toEqual([]); // markup shown
    expect(markRanges(s)).toEqual([[10, 14, 'cm-vis-b']]); // around text still bold
  });

  it('a revealed heading shows its source in the heading\'s type', () => {
    const doc = '\\section{Intro}\n\\paragraph{Run} in text\nBody';
    for (const anchor of [3, doc.indexOf('Run') + 1]) {
      const s = state(doc, { anchor });
      expect(atomicRanges(s).some(([f]) => f === (anchor === 3 ? 0 : doc.indexOf('\\paragraph')))).toBe(false);
    }
    const runAt = doc.indexOf('Run');
    const s = state(doc, { anchor: 3 });
    expect(markRanges(s).filter(([, , cls]) => cls.startsWith('cm-vis-h'))).toEqual([[0, 0, 'cm-vis-h cm-vis-h1'], [runAt, runAt + 3, 'cm-vis-hrun']]);
    const run = state(doc, { anchor: runAt + 1 });
    expect(markRanges(run).filter(([, , cls]) => cls === 'cm-vis-hrun')).toEqual([[runAt, runAt + 3, 'cm-vis-hrun']]);
  });

  it('cursor outside the construct keeps it rendered', () => {
    const s = state('a \\textbf{bold} b', { anchor: 0 });
    expect(atomicRanges(s).length).toBe(2);
  });

  it('a selection reveals the constructs an end of it is in, and keeps those it covers whole rendered (vis-12)', () => {
    const doc = 'x \\textbf{a} y \\emph{b} z';
    const whole = state(doc, { anchor: 0, head: doc.length });
    expect(computeRevealRanges(whole)).toEqual([]);
    expect(atomicRanges(whole).length).toBe(4);
    // from the bold's text to the end: the bold shows its source, the italic stays rendered
    const s = state(doc, { anchor: doc.indexOf('a}'), head: doc.length });
    expect(computeRevealRanges(s)).toEqual([{ from: 2, to: 12 }]);
    expect(atomicRanges(s)).toEqual([[doc.indexOf('\\emph'), doc.indexOf('b}')], [doc.indexOf('b}') + 1, doc.indexOf('b}') + 2]]);
  });

  it('only the local selection reveals', () => {
    const doc = 'a \\textbf{bold} b';
    expect(computeRevealRanges(state(doc, { anchor: 0 }))).toEqual([]);
  });

  it('tolerates syntax errors elsewhere in the document', () => {
    const s = state('\\section{Ok}\nplain\n\\begin{itemize} unclosed\n\\textbf{b}', { anchor: 15 });
    // the section still renders even though the doc has an error node
    expect(atomicRanges(s).some(([f]) => f === 0)).toBe(true);
  });
});

describe('escapes, \\url, \\centering and a heading\'s \\label (#150)', () => {
  function shown(s: EditorState) {
    const out: string[] = [];
    buildAtomic(s, s.field(revealField).ranges).between(0, s.doc.length, (from, to, deco) => {
      const w = deco.spec.widget as { text?: string } | undefined;
      out.push(`${s.doc.sliceString(from, to)}${w?.text !== undefined ? `→${w.text}` : ''}`);
    });
    return out;
  }

  it('renders escapes and \\ldots as their characters, never \\\\ or an argument', () => {
    const doc = 'Save 50\\% \\& \\$5 \\#3 a\\_b \\{x\\} c\\textasciitilde{} d\\ldots{} e\\ldots f \\\\ g\\ h \\textasciitilde{x}\n';
    expect(shown(state(doc, { anchor: doc.length }))).toEqual([
      '\\%→%', '\\&→&', '\\$→$', '\\#→#', '\\_→_', '\\{→{', '\\}→}', '\\textasciitilde{}→~', '\\ldots{}→…', '\\ldots→…',
    ]);
  });

  it('leaves escapes in \\path and \\nolinkurl as written, as LaTeX typesets them', () => {
    const doc = 'a\\_b \\path{c\\_d} \\nolinkurl{e\\_f}\n';
    expect(shown(state(doc, { anchor: doc.length }))).toEqual(['\\_→_']);
  });

  it('shows \\url as a link, and its source while the caret is in it', () => {
    const doc = 'See \\url{https://example.org/a_b} now.';
    const s = state(doc, { anchor: doc.length });
    expect(shown(s)).toEqual(['\\url{', '}']);
    expect(markRanges(s).map(([f, t, c]) => [doc.slice(f, t), c])).toEqual([['https://example.org/a_b', 'cm-vis-url']]);
    expect(shown(state(doc, { anchor: 12 }))).toEqual([]);
  });

  it('hides \\centering until the caret is on it', () => {
    const doc = '\\begin{table}\n  \\centering\n\\begin{tabular}{l}\na \\\\\n\\end{tabular}\n\\end{table}\n{\\centering x\\par}\nend';
    const s = state(doc, { anchor: doc.length });
    const hidden = shown(s);
    expect(hidden).toContain('  \\centering');
    expect(hidden).toContain('\\centering ');
    const inline = doc.lastIndexOf('\\centering');
    expect(shown(state(doc, { anchor: inline + 3 }))).not.toContain('\\centering ');
  });

  it('hides a heading\'s same-line \\label with its brace until the caret is in the heading', () => {
    const doc = '\\section{Intro} \\label{sec:intro}\nBody';
    expect(shown(state(doc, { anchor: doc.length }))).toEqual(['\\section{', '} \\label{sec:intro}']);
    expect(shown(state(doc, { anchor: 10 }))).toEqual([]);
  });
});

describe('the source shows only from strictly inside a chip, a formula or a table (vis-2)', () => {
  const doc = [
    'See \\cite{knuth1984}, $x^2$ and \\ref{fig:a}.',
    '\\begin{tabular}{l}',
    'a \\\\',
    '\\end{tabular}',
    '\\begin{figure}',
    '\\caption{A plot}',
    '\\end{figure}',
    '\\[ y = 1 \\]',
    'end',
  ].join('\n');
  const constructs = ['\\cite{knuth1984}', '$x^2$', '\\ref{fig:a}', '\\begin{tabular}{l}\na \\\\\n\\end{tabular}', '\\begin{figure}\n\\caption{A plot}\n\\end{figure}', '\\[ y = 1 \\]'];
  const drawn = (s: EditorState, text: string) => atomicRanges(s).some(([f, t]) => doc.slice(f, t) === text);

  it('a caret at either edge keeps each one drawn; one strictly inside shows its source', () => {
    for (const text of constructs) {
      const from = doc.indexOf(text);
      for (const at of [from, from + text.length]) {
        const s = state(doc, { anchor: at });
        expect(computeRevealRanges(s), `${text} at ${at}`).toEqual([]);
        expect(drawn(s, text), `${text} at ${at}`).toBe(true);
      }
      expect(drawn(state(doc, { anchor: from + 1 }), text), text).toBe(false);
    }
  });

  it('at a chip\'s edge inside bold the bold shows its source and the chip stays drawn', () => {
    const d = 'a \\textbf{see \\cite{k}} b';
    const s = state(d, { anchor: d.indexOf('}}') + 1 });
    expect(computeRevealRanges(s)).toEqual([{ from: 2, to: d.length - 2 }]);
    expect(atomicRanges(s)).toEqual([[d.indexOf('\\cite'), d.indexOf('}}') + 1]]);
  });

  it('a formula in a heading or caption the caret is in stays drawn', () => {
    const d = '\\section{Cost $x$ now}\n\\begin{figure}\n\\caption{Plot of $y$}\n\\end{figure}\nend';
    const math = (anchor: number) => atomicRanges(state(d, { anchor })).map(([f, t]) => d.slice(f, t)).filter((t) => t.startsWith('$'));
    expect(math(d.indexOf('Cost') + 1)).toEqual(['$x$']);
    // the figure shows its source around the caption the caret is in
    expect(math(d.indexOf('Plot') + 1)).toEqual(['$x$', '$y$']);
  });

  it('a caret in a table float\'s caption shows the caption only, the grid stays drawn', () => {
    const d = '\\begin{table}\n\\centering\n\\begin{tabular}{l}\na \\\\\n\\end{tabular}\n\\caption{Results}\n\\end{table}\nend';
    const s = state(d, { anchor: d.indexOf('Results') + 2 });
    const shown = atomicRanges(s).map(([f, t]) => d.slice(f, t));
    expect(shown).toEqual(['\\begin{table}', '\\centering', '\\begin{tabular}{l}\na \\\\\n\\end{tabular}', '\\end{table}']);
  });

  it('a caret in the indentation before a figure keeps it drawn', () => {
    const d = 'x\n  \\begin{figure}\n  \\caption{A}\n  \\end{figure}\nend';
    const s = state(d, { anchor: d.indexOf('  \\begin') });
    expect(drawn(s, '\\begin{figure}\n  \\caption{A}\n  \\end{figure}')).toBe(false);
    expect(atomicRanges(s).map(([f, t]) => d.slice(f, t))).toEqual(['\\begin{figure}\n  \\caption{A}\n  \\end{figure}']);
  });
});

describe('a bullet hides its \\item at its edges (vis-1)', () => {
  const doc = '\\begin{itemize}\n\\item First\n\\item Second\n\\end{itemize}\nend';
  const marker = (s: EditorState) => atomicRanges(s).some(([f, t]) => doc.slice(f, t) === '\\item ' && f === doc.indexOf('\\item Second'));

  it('a caret before the bullet or at the start of the item\'s text keeps the bullet', () => {
    const at = doc.indexOf('\\item Second');
    for (const anchor of [at, at + '\\item '.length]) expect(marker(state(doc, { anchor })), String(anchor)).toBe(true);
    // strictly inside the hidden \item, as only a search or a jump can put it
    expect(marker(state(doc, { anchor: at + 3 }))).toBe(false);
  });
});

describe('a heading\'s hidden \\label shows for a selection with an end in it (find-6)', () => {
  const doc = '\\section{Introduction}\\label{sec:intro}\nBody';
  const label = (s: EditorState) => atomicRanges(s).some(([f, t]) => doc.slice(f, t) === '}\\label{sec:intro}');

  it('a match inside the label shows it, a selection over the whole line does not', () => {
    const at = doc.indexOf('sec:intro');
    expect(label(state(doc, { anchor: at, head: at + 'sec:intro'.length }))).toBe(false);
    expect(label(state(doc, { anchor: doc.indexOf('\\label'), head: doc.indexOf('\n') }))).toBe(false);
    expect(label(state(doc, { anchor: 0, head: doc.indexOf('\n') + 1 }))).toBe(true);
    expect(label(state(doc, { anchor: doc.length }))).toBe(true);
  });
});
