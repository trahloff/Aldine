/**
 * The compile service runs nothing from the project but TeX, and TeX reaches
 * no file outside the project.
 *
 * - latexmk reads no rc file: every invocation carries -norc, and with a real
 *   TeX Live a project's .latexmkrc or latexmkrc (Perl) does not run.
 * - A symbolic link under the project that resolves outside it, into its
 *   .git, or nowhere, is refused before latexmk starts and before anything
 *   is written, nested or inside the output directory. A link to a file in
 *   the project still typesets.
 *
 * The real compiler script, once with a recording latexmk on PATH (runs
 * everywhere) and once with TeX Live when it is installed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { check, eq } from './assert.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const compilerJs = path.resolve(here, '../../compiler/server.js');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-compiler-sandbox-')));
const dataDir = path.join(tmp, 'data');
const DOC = '\\documentclass{article}\n\\begin{document}\nBODY-TEXT\n\\end{document}\n';

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const children = [];
async function startCompiler(env) {
  const port = await freePort();
  const child = spawn(process.execPath, [compilerJs], { env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ALDINE_PREAMBLE_CACHE: '0', ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  children.push(child);
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve(); });
    child.on('exit', (code) => reject(new Error(`compiler exited early: ${code}`)));
    setTimeout(() => reject(new Error('compiler did not start')), 20_000);
  });
  return async (projectDir, rootFile = 'main.tex') => {
    const res = await fetch(`http://127.0.0.1:${port}/compile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectDir, rootFile }) });
    return { status: res.status, body: await res.json() };
  };
}

/** A project directory under DATA_DIR/projects with these files. */
function project(name, files = {}) {
  const dir = path.join(dataDir, 'projects', name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries({ 'main.tex': DOC, ...files })) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

const victim = project('victim', { 'secret.tex': 'VICTIM-SECRET\n' });
const marker = path.join(tmp, 'rc-ran');
const rc = `open(my $fh, '>', '${marker}'); print $fh "ran\\n"; close $fh; print "ALDINE-RC-RAN\\n";\n`;

try {
  // ---- a recording latexmk ----
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  const argsLog = path.join(tmp, 'latexmk-args');
  fs.writeFileSync(path.join(bin, 'latexmk'), '#!/bin/sh\nprintf "%s\\n" "$@" >> "$ALDINE_TEST_ARGS"\necho "--end--" >> "$ALDINE_TEST_ARGS"\n', { mode: 0o755 });
  const compile = await startCompiler({ PATH: `${bin}${path.delimiter}${process.env.PATH}`, ALDINE_TEST_ARGS: argsLog });
  const runs = () => { try { return fs.readFileSync(argsLog, 'utf8').split('--end--\n').filter(Boolean).map((r) => r.trim().split('\n')); } catch { return []; } };

  project('rc', { '.latexmkrc': rc });
  await compile('projects/rc');
  const rcRuns = runs();
  check(rcRuns.length > 0, 'latexmk ran for an ordinary project');
  for (const args of rcRuns) check(args.includes('-norc'), `every latexmk run reads no rc file (got ${JSON.stringify(args)})`);

  // ---- links out of the project ----
  const refused = async (name, link, msg) => {
    const before = runs().length;
    const { status, body } = await compile(`projects/${name}`);
    eq(status, 400, `${msg}: refused`);
    check(body.ok === false && body.error.includes(`${link} is a symbolic link to a path outside the project`), `${msg}: the error names ${link} (got ${JSON.stringify(body.error)})`);
    eq(runs().length, before, `${msg}: latexmk never started`);
  };

  let dir = project('linkdir');
  fs.symlinkSync(path.join(dataDir, 'projects'), path.join(dir, 'all'));
  fs.writeFileSync(path.join(dir, 'main.tex'), DOC.replace('BODY-TEXT', '\\input{all/victim/secret}'));
  await refused('linkdir', 'all', 'a folder link to every project');
  check(!fs.existsSync(path.join(dir, '.aldine-out')), 'nothing was written for the refused project');

  dir = project('linknested', { 'sections/intro.tex': 'INTRO\n' });
  fs.symlinkSync(path.join(victim, 'secret.tex'), path.join(dir, 'sections', 'refs.bib'));
  await refused('linknested', path.join('sections', 'refs.bib'), 'a nested file link to another project');

  dir = project('linkout');
  fs.mkdirSync(path.join(dir, '.aldine-out'));
  fs.symlinkSync(path.join(victim, 'planted.tex'), path.join(dir, '.aldine-out', 'main.log'));
  await refused('linkout', path.join('.aldine-out', 'main.log'), 'a dangling output link into another project');
  check(!fs.existsSync(path.join(victim, 'planted.tex')), 'no file appeared in the other project');

  dir = project('linkoutdir');
  fs.symlinkSync(victim, path.join(dir, '.aldine-out'));
  await refused('linkoutdir', '.aldine-out', 'an output directory that is a link to another project');
  eq(fs.readdirSync(victim).sort(), ['main.tex', 'secret.tex'], 'the other project is untouched');

  dir = project('linkrel', { 'sub/x.tex': 'x\n' });
  fs.symlinkSync('../../victim/secret.tex', path.join(dir, 'sub', 'up.tex'));
  await refused('linkrel', path.join('sub', 'up.tex'), 'a relative link that climbs out');

  dir = project('linkgit', { '.git/config': '[core]\n\tbare = false\n' });
  fs.symlinkSync('.git/config', path.join(dir, 'notes.tex'));
  await refused('linkgit', 'notes.tex', 'a link to the project\'s own .git/config');
  eq(fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8'), '[core]\n\tbare = false\n', 'the git config is untouched');

  dir = project('linkgitdir', { '.git/HEAD': 'ref: refs/heads/main\n' });
  fs.symlinkSync('.git', path.join(dir, 'meta'));
  await refused('linkgitdir', 'meta', 'a link to the project\'s .git folder');

  // ---- links inside the project ----
  dir = project('inside', { 'chapters/one.tex': 'CHAPTER-ONE\n' });
  fs.symlinkSync('chapters/one.tex', path.join(dir, 'chapter.tex'));
  fs.symlinkSync('chapters', path.join(dir, 'parts'));
  const before = runs().length;
  const inside = await compile('projects/inside');
  eq(inside.status, 200, `links that stay in the project are typeset (got ${JSON.stringify(inside.body.error)})`);
  check(runs().length > before, 'latexmk ran for a project whose links stay inside it');

  // ---- real TeX Live ----
  const hasTex = ['latexmk', 'pdflatex'].every((t) => spawnSync(t, ['--version'], { stdio: 'ignore' }).status === 0);
  if (!hasTex) {
    console.log('compiler-sandbox: recorded runs PASSED; TeX Live runs SKIPPED (no latexmk/pdflatex)');
  } else {
    const real = await startCompiler({});
    for (const name of ['.latexmkrc', 'latexmkrc']) {
      const p = `rc-${name.replace('.', 'dot-')}`;
      project(p, { [name]: rc });
      const { status, body } = await real(`projects/${p}`);
      check(status === 200 && body.ok, `a project with ${name} typesets (${body.error ?? body.errors?.map((e) => e.message).join('; ')})`);
      check(!fs.existsSync(marker), `the project's ${name} did not run`);
      check(!body.latexmkOutput.includes('ALDINE-RC-RAN') && /Rc files read:\s+NONE/.test(body.latexmkOutput), `latexmk read no rc file for ${name} (got ${JSON.stringify(body.latexmkOutput.slice(0, 200))})`);
    }
    dir = project('real-inside', { 'chapters/one.tex': 'CHAPTER-ONE\n' });
    fs.symlinkSync('chapters/one.tex', path.join(dir, 'chapter.tex'));
    fs.writeFileSync(path.join(dir, 'main.tex'), DOC.replace('BODY-TEXT', '\\input{chapter}'));
    const { status, body } = await real('projects/real-inside');
    check(status === 200 && body.ok && fs.existsSync(path.join(dir, '.aldine-out', 'main.pdf')), `a link to a file in the project typesets (${body.error ?? ''})`);
    console.log('compiler-sandbox: recorded and TeX Live runs PASSED');
  }
} finally {
  for (const c of children) c.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
