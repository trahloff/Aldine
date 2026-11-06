import { describe, expect, it, vi } from 'vitest';
import { CompletionContext } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { latexCompletions } from 'codemirror-lang-latex';
import type { TreeEntry } from '../../api';

vi.mock('../../api', () => ({
  api: {
    readFile: vi.fn(async (_id: string, _branch: string, path: string) => (path === 'macros.tex'
      ? '\\newcommand{\\R}{\\mathbb{R}}\n\\def\\half#1{\\frac{#1}{2}}\n% \\newcommand{\\gone}{x}\n'
      : '\\documentclass{article}\n')),
  },
}));

import { everydayCompletionSource, everydayLabels, macroCompletionSource, macrosIn, pathCandidates, pathCompletionSource, relativePath, setCompletionFiles } from '../completions';

const file = (path: string, extra: Partial<TreeEntry> = {}): TreeEntry => ({ path, type: 'file', ...extra });

async function complete(source: (ctx: CompletionContext) => unknown, doc: string) {
  const state = EditorState.create({ doc });
  const res = await source(new CompletionContext(state, doc.length, false)) as { from: number; options: Array<{ label: string; detail?: string }> } | null;
  return res;
}

describe('everyday commands', () => {
  it('offers \\footnote, \\url, \\cdot and the math alphabets, none twice', () => {
    const labels = everydayLabels();
    for (const l of ['\\footnote', '\\url', '\\href', '\\cdot', '\\mathbf', '\\mathcal', '\\mathbb', '\\text']) expect(labels).toContain(l);
    const pkg = new Set([...latexCompletions.commands, ...latexCompletions.mathCommands]);
    expect(labels.filter((l) => pkg.has(l))).toEqual([]);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('answers a command being typed, and nothing after a line break', async () => {
    expect((await complete(everydayCompletionSource, 'x \\foo'))?.from).toBe(2);
    expect(await complete(everydayCompletionSource, 'a & b \\\\')).toBeNull();
  });
});

describe('paths', () => {
  const files = [
    file('main.tex'), file('chapters/intro.tex'), file('figures/plot.png', { binary: true }), file('figures/raw.csv'),
    file('refs.bib'), file('.gitignore'), { path: 'figures', type: 'dir' } as TreeEntry,
  ];

  it('writes a path from the main document\'s folder', () => {
    expect(relativePath('', 'figures/a.png')).toBe('figures/a.png');
    expect(relativePath('paper', 'paper/figures/a.png')).toBe('figures/a.png');
    expect(relativePath('paper', 'shared/a.png')).toBe('../shared/a.png');
    expect(relativePath('paper/sub', 'paper/a.tex')).toBe('../a.tex');
  });

  it('lists the files each command takes, without the extension the command adds', () => {
    expect(pathCandidates('includegraphics', files, 'main.tex', 'main.tex')).toEqual(['figures/plot.png']);
    expect(pathCandidates('input', files, 'main.tex', 'main.tex')).toEqual(['chapters/intro.tex']);
    expect(pathCandidates('include', files, 'main.tex', 'main.tex')).toEqual(['chapters/intro']);
    expect(pathCandidates('bibliography', files, 'main.tex', 'main.tex')).toEqual(['refs']);
    expect(pathCandidates('addbibresource', files, 'main.tex', 'main.tex')).toEqual(['refs.bib']);
    expect(pathCandidates('lstinputlisting', files, 'main.tex', 'main.tex')).toEqual(['chapters/intro.tex', 'figures/raw.csv', 'main.tex', 'refs.bib']);
    // never the file itself or the main document
    expect(pathCandidates('input', files, 'main.tex', 'chapters/intro.tex')).toEqual([]);
    expect(pathCandidates('includegraphics', files, 'paper/main.tex', 'paper/main.tex')).toEqual(['../figures/plot.png']);
  });

  it('completes inside the braces, after options, and the last name of a list', async () => {
    setCompletionFiles('p', 'main', 'main.tex', files);
    const source = pathCompletionSource('p', 'main', () => 'main.tex');
    const graphics = await complete(source, '\\includegraphics[width=\\linewidth]{fig');
    expect(graphics?.options.map((o) => o.label)).toEqual(['figures/plot.png']);
    expect(graphics?.from).toBe('\\includegraphics[width=\\linewidth]{'.length);
    const bib = await complete(source, '\\bibliography{other, re');
    expect(bib?.from).toBe('\\bibliography{other, '.length);
    expect(await complete(source, '\\textbf{fig')).toBeNull();
    // another project's listing is not this one's
    expect(await complete(pathCompletionSource('q', 'main', () => 'main.tex'), '\\input{')).toBeNull();
  });
});

describe('the paper\'s own macros', () => {
  it('reads \\newcommand, \\def, an optional first argument and \\NewDocumentCommand, never a comment', () => {
    const text = [
      '\\newcommand{\\R}{\\mathbb{R}}',
      '\\newcommand\\norm[1]{\\lVert #1\\rVert}',
      '\\renewcommand{\\vec}[1]{\\mathbf{#1}}',
      '\\newcommand{\\todo}[2][red]{\\textcolor{#1}{#2}}',
      '\\DeclareMathOperator{\\Tr}{Tr}',
      '\\def\\half#1{\\frac{#1}{2}}',
      '\\NewDocumentCommand{\\pair}{m m}{(#1, #2)}',
      '% \\newcommand{\\gone}{x}',
      '\\makeatletter\\def\\@internal{x}\\makeatother',
    ].join('\n');
    const byName = Object.fromEntries(macrosIn(text).map((m) => [m.name, m.args]));
    expect(byName).toEqual({ R: 0, norm: 1, vec: 1, todo: 1, Tr: 0, half: 1, pair: 2 });
  });

  it('lists this file\'s macros and the project\'s, skipping what the built-in list has', async () => {
    setCompletionFiles('p', 'main', 'main.tex', [file('main.tex'), file('macros.tex', { mtime: 1 })]);
    const source = macroCompletionSource('p', 'main', () => 'main.tex');
    const res = await complete(source, '\\newcommand{\\vecx}{x}\n\\renewcommand{\\alpha}{a}\n\\v');
    const labels = res?.options.map((o) => o.label);
    expect(labels).toEqual(['\\vecx', '\\R', '\\half']);
    expect(res?.options.find((o) => o.label === '\\R')?.detail).toBe('macros.tex');
  });
});
