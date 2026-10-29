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
    expect(markRanges(s)).toEqual([]);
  });

  it('cursor outside the construct keeps it rendered', () => {
    const s = state('a \\textbf{bold} b', { anchor: 0 });
    expect(atomicRanges(s).length).toBe(2);
  });

  it('a selection spanning constructs reveals every one it touches', () => {
    const doc = 'x \\textbf{a} y \\emph{b} z';
    const s = state(doc, { anchor: 0, head: doc.length });
    const reveals = computeRevealRanges(s, []);
    expect(reveals.length).toBeGreaterThanOrEqual(2);
    expect(atomicRanges(s)).toEqual([]);
  });

  it('remote carets force-reveal their construct', () => {
    const doc = 'a \\textbf{bold} b';
    const s = state(doc, { anchor: 0 });
    const reveals = computeRevealRanges(s, [12]);
    expect(reveals).toContainEqual({ from: 2, to: 15 });
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
