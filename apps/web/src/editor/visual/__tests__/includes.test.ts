import { describe, it, expect, vi } from 'vitest';

const files: Record<string, string> = {};
vi.mock('../refresh', async (orig) => ({ ...(await orig<typeof import('../refresh')>()), pokeViews: vi.fn() }));
vi.mock('../../../api', () => ({
  api: {
    bib: () => Promise.resolve([]),
    readFile: vi.fn((_p: string, _b: string, path: string) => (path in files ? Promise.resolve(files[path]) : Promise.reject(new Error('404')))),
  },
}));

import { api } from '../../../api';
import { pokeViews } from '../refresh';
import { setVisualContext, setVisualFiles, withIncludes } from '../context';
import { preambleMacros } from '../preamble';

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('macros from the files a preamble inputs (vis-17)', () => {
  it('reads \\input files and the project\'s own packages, and again when one changes', async () => {
    files['paper/main.tex'] = '';
    files['paper/math_commands.tex'] = '\\def\\vx{{\\bm{x}}}\n% \\def\\gone{x}\n\\input{more}\n';
    files['paper/more.tex'] = '\\newcommand{\\R}{\\mathbb{R}}\n';
    files['paper/notation.sty'] = '\\newcommand{\\E}{\\mathbb{E}}\n';
    setVisualContext('p', 'main', 'paper/main.tex');
    const listing = (v: number) => [
      { path: 'paper/main.tex', mtime: 1 }, { path: 'paper/math_commands.tex', mtime: v },
      { path: 'paper/more.tex', mtime: 1 }, { path: 'paper/notation.sty', mtime: 1 },
    ];
    setVisualFiles('p', 'main', listing(1));
    const preamble = '\\documentclass{article}\n\\usepackage{amsmath,notation}\n\\input{math_commands.tex}\n';
    const names = () => Object.keys(preambleMacros(withIncludes(preamble)).defs).sort();

    // the first read starts the fetches; each file that arrives redraws, and brings in what it inputs
    expect(names()).toEqual([]);
    await settle();
    expect(vi.mocked(pokeViews)).toHaveBeenCalled();
    expect(names()).toEqual(['E', 'vx']);
    await settle();
    expect(names()).toEqual(['E', 'R', 'vx']);

    // nothing is read again until the listing says a file changed
    const reads = vi.mocked(api.readFile).mock.calls.length;
    names();
    setVisualFiles('p', 'main', listing(1));
    expect(vi.mocked(api.readFile).mock.calls.length).toBe(reads);
    files['paper/math_commands.tex'] = '\\def\\vy{{\\bm{y}}}\n';
    setVisualFiles('p', 'main', listing(2));
    await settle();
    expect(names()).toEqual(['E', 'vy']);
  });
});
