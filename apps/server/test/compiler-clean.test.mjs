/**
 * POST /compile with clean: true (Recompile from scratch) removes the root
 * file's .aldine-out before latexmk runs: aux files, the precompiled preamble,
 * the thumbnail, links inside it. Source files stay, a link inside the output
 * directory is removed without following it, another root's output directory
 * is left alone, and an .aldine-out that is itself a link is refused.
 *
 * The real compiler script, with a latexmk on PATH that records whether the
 * previous run's .aux was still there and writes a PDF.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { check, eq } from './assert.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const compilerJs = path.resolve(here, '../../compiler/server.js');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-compiler-clean-')));
const dataDir = path.join(tmp, 'data');
const runs = path.join(tmp, 'runs');
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'latexmk'), `#!/bin/sh
for a in "$@"; do root="$a"; done
dir=$(dirname "$root"); base=$(basename "$root" .tex)
out="$dir/.aldine-out"
if [ -e "$out/$base.aux" ]; then echo stale >> "$ALDINE_TEST_RUNS"; else echo fresh >> "$ALDINE_TEST_RUNS"; fi
mkdir -p "$out"
echo aux > "$out/$base.aux"
echo '%PDF-1.5' > "$out/$base.pdf"
echo 'Output written on x.pdf (1 page, 9 bytes).' > "$out/$base.log"
`, { mode: 0o755 });

const doc = '\\documentclass{article}\\begin{document}x\\end{document}\n';
const project = (name, files) => {
  const dir = path.join(dataDir, 'projects', name);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
};

// a: a top-level root with a full output directory from earlier runs.
const a = project('a', {
  'main.tex': doc,
  'chapters/one.tex': 'One\n',
  '.aldine-out/main.aux': '\\abx@aux@stale\n',
  '.aldine-out/main.fdb_latexmk': 'fdb\n',
  '.aldine-out/.main.thumb.jpg': 'jpg',
  '.aldine-out/.main.thumb.json': '{}',
  '.aldine-out/fmt/main/main.fmt': 'fmt',
  '.aldine-out/fmt/main/manifest.json': '{}',
});
fs.symlinkSync('../main.tex', path.join(a, '.aldine-out', 'source-link'));
// b: the root in a subfolder; the top-level output directory belongs to another root.
const b = project('b', {
  'paper/main.tex': doc,
  'paper/.aldine-out/main.aux': 'stale\n',
  '.aldine-out/other.pdf': '%PDF-1.5',
});
// c: .aldine-out is a link to a source folder inside the project.
const c = project('c', { 'main.tex': doc, 'chapters/one.tex': 'One\n' });
fs.symlinkSync('chapters', path.join(c, '.aldine-out'));

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const port = await freePort();
const child = spawn(process.execPath, [compilerJs], {
  env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, PORT: String(port), DATA_DIR: dataDir, ALDINE_PREAMBLE_CACHE: '0', ALDINE_THUMBNAILS: '0', ALDINE_TEST_RUNS: runs },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => {
  child.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve(); });
  child.on('exit', (code) => reject(new Error(`compiler exited early: ${code}`)));
  setTimeout(() => reject(new Error('compiler did not start')), 20_000);
});

const post = async (body) => {
  const res = await fetch(`http://127.0.0.1:${port}/compile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const lastRun = () => fs.readFileSync(runs, 'utf8').trim().split('\n').pop();
const exists = (...p) => fs.existsSync(path.join(...p));

try {
  // ---- a plain typeset keeps what earlier runs left ----
  const plain = await post({ projectDir: 'projects/a', rootFile: 'main.tex' });
  eq(plain.status, 200, `a plain typeset answers (${JSON.stringify(plain.body)})`);
  eq(lastRun(), 'stale', 'latexmk found the previous .aux');
  check(exists(a, '.aldine-out', 'fmt', 'main', 'main.fmt'), 'the precompiled preamble stays');
  check(exists(a, '.aldine-out', '.main.thumb.jpg'), 'the thumbnail stays');
  check(exists(a, '.aldine-out', 'main.fdb_latexmk'), 'latexmk\'s database stays');

  // ---- from scratch: every generated file goes, the sources stay ----
  const clean = await post({ projectDir: 'projects/a', rootFile: 'main.tex', clean: true });
  eq(clean.status, 200, `a clean typeset answers (${JSON.stringify(clean.body)})`);
  eq(clean.body.ok, true, 'and succeeds');
  eq(lastRun(), 'fresh', 'latexmk started without the previous .aux');
  check(!exists(a, '.aldine-out', 'fmt'), 'the precompiled preamble is gone');
  check(!exists(a, '.aldine-out', '.main.thumb.jpg') && !exists(a, '.aldine-out', '.main.thumb.json'), 'the thumbnail is gone');
  check(!exists(a, '.aldine-out', 'main.fdb_latexmk'), 'latexmk\'s database is gone');
  check(!exists(a, '.aldine-out', 'source-link'), 'a link inside the output directory is removed');
  eq(fs.readFileSync(path.join(a, 'main.tex'), 'utf8'), doc, 'the file that link named is untouched');
  eq(fs.readFileSync(path.join(a, 'chapters', 'one.tex'), 'utf8'), 'One\n', 'other sources are untouched');
  eq(clean.body.pdf, '.aldine-out/main.pdf', 'the fresh run wrote its PDF');
  check(exists(a, '.aldine-out', 'main.pdf'), 'which is on disk');

  // ---- a root in a subfolder clears its own output directory only ----
  const sub = await post({ projectDir: 'projects/b', rootFile: 'paper/main.tex', clean: true });
  eq(sub.status, 200, `a clean typeset of paper/main.tex answers (${JSON.stringify(sub.body)})`);
  eq(lastRun(), 'fresh', 'paper/.aldine-out was cleared');
  check(exists(b, '.aldine-out', 'other.pdf'), 'the top-level output directory of another root is left alone');
  check(exists(b, 'paper', 'main.tex'), 'the root file stays');

  // ---- an .aldine-out that is a link is refused, and nothing is deleted ----
  const linked = await post({ projectDir: 'projects/c', rootFile: 'main.tex', clean: true });
  eq(linked.status, 400, 'a linked output directory is refused');
  check(/not the folder the compiler made/.test(linked.body.error), `with a sentence that says why (${linked.body.error})`);
  eq(fs.readFileSync(path.join(c, 'chapters', 'one.tex'), 'utf8'), 'One\n', 'the folder the link names keeps its files');
  check(fs.lstatSync(path.join(c, '.aldine-out')).isSymbolicLink(), 'and the link itself is not touched');

  // ---- only a literal true cleans ----
  fs.writeFileSync(path.join(a, '.aldine-out', 'keep.txt'), 'x');
  await post({ projectDir: 'projects/a', rootFile: 'main.tex', clean: 'yes' });
  check(exists(a, '.aldine-out', 'keep.txt'), 'clean: "yes" is no clean');

  console.log('compiler clean: ALL PASSED');
} finally {
  child.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}
