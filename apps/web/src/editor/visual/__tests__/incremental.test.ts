import { describe, it, expect } from 'vitest';
import { EditorState, EditorSelection } from '@codemirror/state';
import type { DecorationSet } from '@codemirror/view';
import { ensureSyntaxTree, syntaxTreeAvailable } from '@codemirror/language';
import { latex } from 'codemirror-lang-latex';
import { buildAtomic } from '../decorations';
import { revealField } from '../reveal';
import { atomicField } from '../atomicField';

const PAPER = [
  '\\documentclass{article}',
  '\\begin{document}',
  '\\section{Introduction}',
  'Intro with \\textbf{bold \\emph{nested}} and $x+y$ inline, \\cite[p.~3]{knuth1984} too.',
  '\\paragraph{Run in} body text after a run-in heading.',
  '\\section{Labelled}\\label{sec:l} % note',
  '\\begin{itemize}',
  '  \\item First $a$',
  '  \\item Second \\textit{it}',
  '  \\begin{enumerate}',
  '    \\item One',
  '    \\item Two',
  '  \\end{enumerate}',
  '\\end{itemize}',
  '$$ E = mc^2 $$',
  '\\[ \\int_0^1 x \\, dx \\]',
  '\\begin{equation}\\label{eq:a}',
  '  f(x) = 1 % keep',
  '\\end{equation}',
  '\\begin{align}',
  '  a &= b \\\\',
  '  c &= d',
  '\\end{align}',
  '\\begin{table}[ht]',
  '\\centering',
  '\\begin{tabular}{l|c}',
  '\\hline',
  'a & b \\\\[2pt]',
  '% commented & row \\\\',
  'c & {d & e} \\\\',
  '\\end{tabular}',
  '\\caption{A table}',
  '\\end{table}',
  '\\begin{figure}',
  '\\begin{subfigure}{0.4\\linewidth}\\caption{Left}\\end{subfigure}',
  '\\includegraphics{plot}',
  '\\caption{Main}',
  '\\end{figure}',
  'See \\ref{fig:x} and \\cite{lamport1994,knuth1984}.',
  '\\begin{verbatim}',
  '\\textbf{not bold} $no$',
  '\\end{verbatim}',
  '% a comment with $math$',
  '\\subsection{Details \\textbf{here}}',
  'More \\underline{under} and \\textsc{caps}.',
  '\\subsection{Costs} \\label{sec:costs}',
  'Save 50\\% \\& more\\ldots{} at \\url{https://example.org/a_b}, \\{x\\} \\textasciitilde{} ok \\\\ next.',
  '{\\centering inline centred\\par}',
  '\\end{document}',
  '',
].join('\n');

const TOKENS = [
  '$', '$$', '{', '}', '\\', '\\textbf{', '\\emph{x}', '\\item ', '\\begin{itemize}', '\\end{itemize}',
  '\\begin{enumerate}\n\\item z\n\\end{enumerate}', '%', '\n', '\n\n', 'x', ' ', '&', '\\\\', '\\section{', '}',
  '\\[', '\\]', '\\cite{k}', '\\ref{r}', '\\begin{tabular}{ll}\na & b \\\\\n\\end{tabular}', '\\end{figure}',
  '\\begin{verbatim}', '\\caption{c}', '[p.~1]', '  ', '\\label{l}',
  '\\%', '\\ldots', '{}', '\\url{', '\\centering', '\\centering\n',
];

function describeSet(set: DecorationSet, len: number): string[] {
  const out: string[] = [];
  set.between(0, len, (from, to, deco) => {
    const w = deco.spec.widget;
    out.push(`${from}-${to} ${w ? `${w.constructor.name}${JSON.stringify(w)}` : JSON.stringify(deco.spec)}`);
  });
  return out.sort();
}

/** A seeded generator, so a failure names a reproducible run. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

function parsed(state: EditorState): EditorState {
  if (syntaxTreeAvailable(state, state.doc.length)) return state;
  ensureSyntaxTree(state, state.doc.length, 5_000);
  return state.update({}).state; // adopts the finished tree
}

function start(doc: string, anchor = 0): EditorState {
  return parsed(EditorState.create({ doc, selection: { anchor }, extensions: [latex(), revealField, atomicField] }));
}

function expectMatchesFullBuild(state: EditorState, step: string) {
  const len = state.doc.length;
  const kept = describeSet(state.field(atomicField).deco, len);
  const fresh = describeSet(buildAtomic(state, state.field(revealField).ranges), len);
  expect(kept, step).toEqual(fresh);
}

describe('incremental visual decorations', () => {
  it('equal a full rebuild after every random edit and caret move', () => {
    for (let run = 1; run <= 12; run++) {
      const rand = rng(run * 7919);
      let state = start(PAPER);
      for (let step = 0; step < 120; step++) {
        const len = state.doc.length;
        const at = Math.floor(rand() * (len + 1));
        const kind = rand();
        let label: string;
        if (kind < 0.45) {
          const insert = TOKENS[Math.floor(rand() * TOKENS.length)];
          state = state.update({ changes: { from: at, insert }, selection: { anchor: at + insert.length } }).state;
          label = `insert ${JSON.stringify(insert)} at ${at}`;
        } else if (kind < 0.75) {
          const to = Math.min(len, at + 1 + Math.floor(rand() * 25));
          label = `delete ${JSON.stringify(state.sliceDoc(at, to))} at ${at}`;
          state = state.update({ changes: { from: at, to }, selection: { anchor: at } }).state;
        } else if (kind < 0.9) {
          state = state.update({ selection: { anchor: at } }).state;
          label = `caret to ${at}`;
        } else {
          const head = Math.min(len, at + Math.floor(rand() * 60));
          state = state.update({ selection: EditorSelection.single(at, head) }).state;
          label = `select ${at}-${head}`;
        }
        state = parsed(state);
        expectMatchesFullBuild(state, `run ${run} step ${step}: ${label}\n${state.doc.toString()}`);
      }
    }
  }, 60_000);

  it('stay in step where an edit re-pairs environments or braces far from it', () => {
    // ⟨A⟩ the edit, ⟨E⟩ the end of a deletion, ⟨S⟩ the caret before it
    const cases: Array<[string, string]> = [
      // \begin{equatio → \begin{equation turns what follows into math that ends elsewhere
      ['cle}\n\\begin{document}\\begin{equatio⟨A⟩⟨S⟩\\l\n\n\\end{document}\\paragraph{}', 'n'],
      ['\\begin{document}\n\\begin{tabula⟨A⟩⟨S⟩}\\begin{itemize}\n  \\begin{enumerate}$x^2 + y_1$\n  \\end{enumerate}plain words \n\\end{equation}\n\\begin{equation}\\label{eq:a}\n\n\\end{align}\n\\begin{table}[ht]\\subsection{Sub}\\label{sec:s}\\begin{equation}\\begin{figure}\n\\end{figure}\n  E = mc^2\n\\end{equation}\n\\end{document}', 'r'],
      ['}\n$$ E$\n\\begin{tabula⟨A⟩⟨S⟩[n}\\paragraph{}{}\n\\begin{table}\\end{ent}', 'r'],
      ['\\begin{abel{sec:l} \n{$a$\\begin{equatio⟨A⟩⟨S⟩}\n\\section{{}{}}}}\\begin{table\n\\end\\v', 'n'],
      // error recovery after the edit now ends a \ref elsewhere
      ['⟨S⟩{}\\begin{⟨A⟩\\⟨E⟩c}r}\n\\ref{r\\begin{d{c\\begin{tabular}e\\end', ''],
      ['⟨S⟩\\label{{{}}{}{⟨A⟩n}\n\\begin{m \n\\begin{enumerate\\}\n', '$'],
      ['\\begin\\t{\\m ⟨A⟩\n\\end{d}}\\end{{{⟨S⟩}}\\begin{itemize\\begin}}}', '\\)'],
      ['\\begin{\\begin{{{}⟨A⟩\\[\n}e\\end{table}\n\\begin{itemize\\e i\\end{e}⟨S⟩ne{u}egi', '%'],
    ];
    for (const [marked, insert] of cases) {
      const at: Record<string, number> = {};
      let doc = '';
      for (const part of marked.split(/(⟨[ASE]⟩)/)) {
        if (/^⟨[ASE]⟩$/.test(part)) at[part[1]] = doc.length;
        else doc += part;
      }
      let state = start(doc, at.S);
      state = parsed(state.update({ changes: { from: at.A, to: at.E ?? at.A, insert }, selection: { anchor: at.A + insert.length } }).state);
      expectMatchesFullBuild(state, marked);
    }
  });

  it('two edits in one transaction (a remote update) stay in step', () => {
    let state = start(PAPER, PAPER.indexOf('More'));
    const a = PAPER.indexOf('Intro with');
    const b = PAPER.indexOf('See \\ref');
    state = parsed(state.update({ changes: [{ from: a, insert: '$q$ ' }, { from: b, to: b + 4, insert: '\\textbf{See}' }] }).state);
    expectMatchesFullBuild(state, 'two-site edit');
  });

  it('constructs the background parser reaches later render without an edit', () => {
    const doc = `${'plain line of prose\n'.repeat(400)}tail $a+b$ and \\textbf{end}\n`;
    let state = EditorState.create({ doc, extensions: [latex(), revealField, atomicField] });
    const tail = doc.indexOf('tail');
    const widgetsPastTail = (s: EditorState) => describeSet(s.field(atomicField).deco, s.doc.length)
      .filter((d) => Number(d.split('-')[0]) >= tail);
    expect(syntaxTreeAvailable(state, doc.length)).toBe(false);
    expect(widgetsPastTail(state)).toEqual([]);
    ensureSyntaxTree(state, doc.length, 5_000);
    state = state.update({}).state; // what the parse worker's transaction does
    expect(widgetsPastTail(state).some((d) => d.includes('MathWidget'))).toBe(true);
    expect(widgetsPastTail(state).length).toBe(3); // the formula plus the bold's two hidden braces
  });

  it('stay in step while the parser works through a long file', () => {
    const filler = PAPER.repeat(30);
    let state = EditorState.create({ doc: filler, selection: { anchor: 0 }, extensions: [latex(), revealField, atomicField] });
    for (const share of [0.1, 0.25, 0.5, 0.8, 1]) {
      ensureSyntaxTree(state, Math.floor(filler.length * share), 5_000);
      state = state.update({}).state;
      expectMatchesFullBuild(state, `parsed to ${share}`);
    }
    // and an edit while the tree is still partial
    state = EditorState.create({ doc: filler, selection: { anchor: 0 }, extensions: [latex(), revealField, atomicField] });
    state = state.update({ changes: { from: 10, insert: '$q$ ' } }).state;
    expectMatchesFullBuild(state, 'edit on a partial tree');
    ensureSyntaxTree(state, filler.length, 5_000);
    state = state.update({}).state;
    expectMatchesFullBuild(state, 'parsed after the edit');
  });

  it('a keystroke in prose keeps every widget object outside the edited line', () => {
    let state = start(PAPER, PAPER.indexOf('More'));
    const before = new Set<unknown>();
    state.field(atomicField).deco.between(0, state.doc.length, (_f, _t, d) => { before.add(d.spec.widget ?? d); });
    const at = PAPER.indexOf('and \\textsc');
    state = parsed(state.update({ changes: { from: at, insert: 'z' }, selection: { anchor: at + 1 } }).state);
    const line = state.doc.lineAt(at);
    let fresh = 0;
    state.field(atomicField).deco.between(0, state.doc.length, (f, t, d) => {
      if (!before.has(d.spec.widget ?? d) && (t < line.from || f > line.to)) fresh++;
    });
    expect(fresh).toBe(0);
  });
});
