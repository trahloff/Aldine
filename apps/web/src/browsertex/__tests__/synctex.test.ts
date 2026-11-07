import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { projectPath, synctexLookup } from '../synctex';

/**
 * The fixture is pdfLaTeX's SyncTeX for paper/main.tex, which \input's
 * paper/chapters/ch1.tex, with its inputs recorded under a directory only
 * the engine knew (a browser's in-memory /home/web_user/project_dir). The
 * expected numbers are what synctex 1.5's CLI printed for the same file.
 */
const gz = new Uint8Array(readFileSync(fileURLToPath(new URL('./fixtures/main.synctex.gz', import.meta.url))));
const files = new Set(['paper/main.tex', 'paper/chapters/ch1.tex']);
const view = (file: string, line: number) => synctexLookup(gz, 'paper/main.tex', files, { direction: 'forward', file, line });
const edit = (page: number, x: number, y: number) => synctexLookup(gz, 'paper/main.tex', files, { direction: 'inverse', page, x, y });

describe('SyncTeX lookups', () => {
  it.each([
    ['paper/main.tex', 4, 1, 154.745285, 156.585541, 8.855677],
    ['paper/main.tex', 7, 1, 179.153778, 180.495880, 8.855677],
    ['paper/chapters/ch1.tex', 2, 1, 157.014542, 235.262650, 8.855677],
    ['paper/chapters/ch1.tex', 4, 1, 171.155960, 247.217819, 8.855677],
    ['paper/main.tex', 12, 2, 155.492462, 134.764618, 8.744962],
  ])('forward %s:%i lands where synctex view puts it', async (file, line, page, x, y, H) => {
    const [r] = await view(file, line);
    expect(r.page).toBe(page);
    expect(r.y as number).toBeCloseTo(y, 2);
    expect(Math.abs((r.x as number) - x)).toBeLessThanOrEqual(5);
    expect(r.h as number).toBeCloseTo(133.768356, 2);
    expect(r.W as number).toBeCloseTo(343.711060, 2);
    expect(r.H as number).toBeCloseTo(H, 2);
  });

  it('gives both output lines of a wrapped source line', async () => {
    expect((await view('paper/main.tex', 5)).map((r) => Math.round(r.y as number)).sort()).toEqual([157, 169]);
  });

  it('falls through a line with no output to the next one', async () => {
    expect((await view('paper/main.tex', 8))[0]?.page).toBe(1);
  });

  it('has nothing for a file outside the run', async () => {
    expect(await view('paper/other.tex', 3)).toEqual([]);
  });

  it.each([
    [1, 150, 120, 'paper/main.tex', 3],
    [1, 200, 300, 'paper/chapters/ch1.tex', 4],
    [1, 300, 380, 'paper/chapters/ch1.tex', 4],
    [2, 150, 120, 'paper/main.tex', 12],
    [1, 10, 10, 'paper/main.tex', 11],
  ])('inverse %i:%i:%i names the line synctex edit names', async (page, x, y, input, line) => {
    const [r] = await edit(page, x, y);
    expect({ input: r.input, line: r.line }).toEqual({ input, line });
  });

  it('answers nothing for a page the PDF lacks', async () => {
    expect(await edit(9, 100, 100)).toEqual([]);
  });

  it('maps recorded inputs to project paths', () => {
    const has = (set: string[]) => (rel: string) => set.includes(rel);
    expect(projectPath('/home/web_user/project_dir/paper/./main.tex', 'paper', has(['paper/main.tex']))).toBe('paper/main.tex');
    expect(projectPath('/texlive/texmf-dist/tex/latex/base/article.cls', 'paper', has(['paper/main.tex']))).toBeNull();
    expect(projectPath('./chapters/ch1.tex', 'paper', has([]))).toBe('paper/chapters/ch1.tex');
    expect(projectPath('../../etc/passwd', 'paper', has([]))).toBeNull();
  });
});
