/**
 * Precompiled preamble (apps/compiler/preamble.js): the preamble rules hold
 * everywhere; the compile cycle runs where TeX Live with mylatexformat is
 * installed (the compiler image, a full local TeX Live) and is skipped with
 * a note elsewhere.
 *
 * Cycle: the first typeset misses and builds the format in the background,
 * the next one loads it with the same PDF text and the same error lines, an
 * edit to a file the preamble \inputs or to the preamble itself misses again,
 * and a format that breaks a document the plain run typesets is dropped for
 * that preamble.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { check, eq } from './assert.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { preambleOf } = require('../../compiler/preamble.js');

// ---- preamble rules ----
const doc = (pre) => `${pre}\n\\begin{document}\nx\n\\end{document}\n`;
check(preambleOf(doc('\\documentclass{article}\n\\usepackage{amsmath}')).preamble !== null, 'a plain preamble can be precompiled');
check(preambleOf('%&custom\n' + doc('\\documentclass{article}')).preamble === null, 'a first-line format directive keeps its own format');
check(preambleOf('\\documentclass{article}\nno body').preamble === null, 'no \\begin{document}, no format');
for (const bad of ['\\makeindex', '\\usepackage{glossaries}', '\\usepackage[acronym]{glossaries-extra}', '\\usepackage{imakeidx}', '\\usepackage{amsmath,minted}', '\\begin{filecontents*}{x.bib}', '\\immediate\\write18{ls}', '\\RequirePackage{fontspec}', '\\externaldocument{other}']) {
  check(preambleOf(doc(`\\documentclass{article}\n${bad}`)).preamble === null, `${bad} is never precompiled`);
}
check(preambleOf(doc('\\documentclass{article}\n% \\makeindex')).preamble !== null, 'a commented-out \\makeindex does not count');

// ---- compile cycle ----
const has = (args) => spawnSync('kpsewhich', args, { encoding: 'utf8' }).stdout?.trim();
if (!has(['mylatexformat.ltx']) || !has(['tikz.sty'])) {
  console.log('Preamble cache: rules PASSED; compile cycle SKIPPED (no mylatexformat/tikz in this TeX Live)');
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-preamble-'));
const dataDir = path.join(tmp, 'data');
const proj = path.join(dataDir, 'p', 'paper');
fs.mkdirSync(proj, { recursive: true });
const PRE = ['\\documentclass{article}', '\\usepackage{amsmath,amssymb}', '\\usepackage{tikz}', '\\usetikzlibrary{arrows.meta,positioning}', '\\usepackage{hyperref}', '\\input{macros}'].join('\n');
const BODY = ['\\begin{document}', '\\section{One}\\label{one}', 'Real $\\R$ and \\NAME. See \\ref{one}.', '\\begin{tikzpicture}\\draw[->] (0,0) -- (1,1);\\end{tikzpicture}', '\\end{document}', ''].join('\n');
fs.writeFileSync(path.join(proj, 'macros.tex'), '\\newcommand{\\R}{\\mathbb{R}}\\newcommand{\\NAME}{FIRSTNAME}\n');
fs.writeFileSync(path.join(proj, 'main.tex'), `${PRE}\n${BODY}`);

const port = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const child = spawn(process.execPath, [path.resolve(here, '../../compiler/server.js')], { env: { ...process.env, PORT: String(port), DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((resolve, reject) => {
  child.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve(); });
  child.on('exit', (code) => reject(new Error(`compiler exited early: ${code}`)));
  setTimeout(() => reject(new Error('compiler did not start')), 20_000);
});
const compile = async () => {
  const res = await fetch(`http://127.0.0.1:${port}/compile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectDir: 'p', rootFile: 'paper/main.tex' }) });
  return res.json();
};
const fmtDir = path.join(proj, '.aldine-out', 'fmt', 'main');
const manifest = () => { try { return JSON.parse(fs.readFileSync(path.join(fmtDir, 'manifest.json'), 'utf8')); } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const untilBuilt = async (prevBuiltAt) => {
  for (let i = 0; i < 200; i++) { const m = manifest(); if (m && m.builtAt !== prevBuiltAt) return m; await sleep(100); }
  throw new Error('format was not built');
};
const pdfText = () => spawnSync('pdftotext', [path.join(proj, '.aldine-out', 'main.pdf'), '-'], { encoding: 'utf8' }).stdout;
const touchBody = (s) => fs.writeFileSync(path.join(proj, 'main.tex'), `${PRE}\n${BODY.replace('See', `${s} See`)}`);

try {
  let r = await compile();
  check(r.ok, `first typeset ok (${r.errors?.map((e) => e.message).join('; ')})`);
  eq(r.preambleCache, 'miss', 'the first typeset has no format yet');
  const plainText = pdfText();
  let m = await untilBuilt(undefined);
  check(m.inputs['macros.tex'], `the format records the \\input file (got ${Object.keys(m.inputs)})`);
  check(!Object.keys(m.inputs).some((f) => f.endsWith('main.tex')), 'the root itself is keyed by its preamble, not its bytes');

  touchBody('Edited.');
  r = await compile();
  check(r.ok, 'typeset on the format ok');
  eq(r.preambleCache, 'hit', 'an edit below the preamble loads the format');
  check(pdfText().replace('Edited. ', '') === plainText, 'the PDF text matches the plain run');
  check(manifest().verified === true, 'the first good run vouches for the format');

  // an error in the body keeps its line number on the format
  fs.writeFileSync(path.join(proj, 'main.tex'), `${PRE}\n${BODY.replace('See', '\\nosuchmacro See')}`);
  r = await compile();
  eq(r.preambleCache, 'hit', 'a verified format stays in use for a broken body');
  const err = r.errors.find((e) => e.type === 'error');
  check(err && err.file === 'paper/main.tex' && err.line === 9, `the error points at paper/main.tex:9 (got ${err?.file}:${err?.line})`);

  // a file the preamble reads changes: miss, rebuild, and the new macro shows
  fs.writeFileSync(path.join(proj, 'macros.tex'), '\\newcommand{\\R}{\\mathbb{R}}\\newcommand{\\NAME}{SECONDNAME}\n');
  touchBody('Again.');
  const before = m.builtAt;
  r = await compile();
  eq(r.preambleCache, 'miss', 'an edit to an \\input file of the preamble misses');
  check(pdfText().includes('SECONDNAME'), 'and typesets the new macro');
  m = await untilBuilt(before);
  touchBody('Once more.');
  r = await compile();
  eq(r.preambleCache, 'hit', 'the rebuilt format is used');
  check(pdfText().includes('SECONDNAME'), 'the rebuilt format carries the new macro');

  // the preamble itself changes: miss
  fs.writeFileSync(path.join(proj, 'main.tex'), `${PRE}\n\\usepackage{amsthm}\n${BODY}`);
  r = await compile();
  eq(r.preambleCache, 'miss', 'a preamble edit misses');
  m = await untilBuilt(m.builtAt);

  // a format that breaks the document: dropped for this preamble
  fs.writeFileSync(path.join(fmtDir, 'main.fmt'), 'not a format');
  fs.writeFileSync(path.join(fmtDir, 'manifest.json'), JSON.stringify({ ...m, verified: false }));
  fs.writeFileSync(path.join(proj, 'main.tex'), `${PRE}\n\\usepackage{amsthm}\n${BODY.replace('See', 'Broken. See')}`);
  r = await compile();
  check(r.ok, 'a broken format still yields a good typeset');
  eq(r.preambleCache, 'fallback', 'by falling back to the plain run');
  check(manifest().bad === true, 'and the format is marked bad');
  touchBody('After.');
  fs.writeFileSync(path.join(proj, 'main.tex'), `${PRE}\n\\usepackage{amsthm}\n${BODY.replace('See', 'After. See')}`);
  r = await compile();
  eq(r.preambleCache, 'bad', 'a bad format is not tried again for the same preamble');
} finally {
  child.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('Preamble cache: ALL PASSED');
process.exit(0);
