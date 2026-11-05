/**
 * Which project files open in the code editor: the listing marks every file
 * isTextFile does not know as binary, and the editor shows those as a
 * download panel. LaTeX's other source formats (Asymptote, knitr, .ltx, a
 * latexmkrc) are text; images and archives are not, nor is a dotfile with an
 * extension of its own.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-text-files-'));
delete process.env.AUTH_ENABLED;
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

const { isTextFile, rawFileType } = await import('../src/util.ts');
const { initDb } = await import('../src/db/index.ts');
await initDb();
const store = await import('../src/store.ts');

try {
  for (const p of ['paper.ltx', 'figs/plot.asy', 'analysis.Rnw', 'notes.Rmd', 'main.bbl', 'lang.ldf', 'index.ist', '.latexmkrc', 'sub/.latexmkrc', 'latexmkrc', '.chktexrc', 'Makefile', 'main.tex', '.gitignore']) {
    check(isTextFile(p), `${p} is text`);
  }
  for (const p of ['fig.png', 'paper.pdf', 'archive.zip', 'font.otf', '.DS_Store', 'thesis.docx']) {
    check(!isTextFile(p), `${p} is not text`);
  }
  eq(rawFileType('figs/plot.asy'), 'text/plain; charset=utf-8', 'an .asy is served as text');

  const meta = await store.createProject('Formats', {
    'main.tex': '\\documentclass{article}\\begin{document}\\input{figure.asy}\\end{document}\n',
    'figure.asy': 'size(100); draw(unitcircle);\n',
    '.latexmkrc': "$pdf_mode = 1;\n",
  });
  const listed = await store.listFiles(meta.id, 'main');
  const entry = (p) => listed.find((f) => f.path === p);
  eq(entry('figure.asy')?.binary, false, 'the listing marks figure.asy as text');
  eq(entry('.latexmkrc')?.binary, false, 'the listing marks .latexmkrc as text');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('text-files: all assertions passed');
process.exit(0);
