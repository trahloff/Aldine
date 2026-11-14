/**
 * POST /format on the compile service runs latexindent over a copy of the
 * text and answers its stdout, and nothing a document or a project holds
 * changes how it runs.
 *
 * - The copy is in a fresh directory outside DATA_DIR, removed afterwards;
 *   HOME points at it; the command line has no -w, -l, -m, -r or -o, logs
 *   to /dev/null, and sets only defaultIndent.
 * - Over the size cap nothing runs; past the time limit the process is
 *   killed; an answer that changed more than whitespace is refused; without
 *   latexindent the answer says it is unavailable.
 * - With a real latexindent (the compiler image has one; a BasicTeX host
 *   does not, and that part is skipped): nested environments are indented,
 *   verbatim, lstlisting, \verb and comments are left as they were, and a
 *   localSettings.yaml / latexindent.yaml in the service's directory or an
 *   indentconfig.yaml in its HOME is not read.
 *
 * Plain node (no tsx): runs inside the compiler image as well as here.
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
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-compiler-format-')));
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(dataDir);

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const children = [];
async function startCompiler(env, cwd = tmp) {
  const port = await freePort();
  const child = spawn(process.execPath, [compilerJs], { cwd, env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ALDINE_PREAMBLE_CACHE: '0', ALDINE_THUMBNAILS: '0', ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  children.push(child);
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve(); });
    child.on('exit', (code) => reject(new Error(`compiler exited early: ${code}`)));
    setTimeout(() => reject(new Error('compiler did not start')), 20_000);
  });
  const base = `http://127.0.0.1:${port}`;
  return {
    health: async () => (await fetch(`${base}/health`)).json(),
    format: async (body) => {
      const res = await fetch(`${base}/format`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    },
  };
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (cond, what, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};
const leftovers = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('aldine-format-'));

try {
  // ---- a recording latexindent ----
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(tmp, 'log');
  fs.writeFileSync(path.join(bin, 'latexindent'), `#!/bin/sh
if [ "$1" = "--version" ]; then echo "9.9.9, fake"; exit 0; fi
printf '%s\\n' "$PWD" > "$ALDINE_TEST_LOG.cwd"
printf '%s\\n' "$HOME" > "$ALDINE_TEST_LOG.home"
printf '%s\\n' "$@" > "$ALDINE_TEST_LOG.args"
for f; do file="$f"; done
cp "$file" "$ALDINE_TEST_LOG.input"
if grep -q SLEEP "$file"; then echo $$ > "$ALDINE_TEST_LOG.pid"; exec sleep 30; fi
if grep -q REWRITE "$file"; then echo "other words"; exit 0; fi
if grep -q FAIL "$file"; then echo "boom: it broke" >&2; exit 3; fi
awk '{ if ($0 ~ /^\\\\item/) printf "\\t%s\\n", $0; else print }' "$file"
`, { mode: 0o755 });
  const before = leftovers();
  const fake = await startCompiler({ PATH: `${bin}${path.delimiter}${process.env.PATH}`, ALDINE_TEST_LOG: log, FORMAT_TIMEOUT_MS: '700', FORMAT_MAX_BYTES: '5000' });

  eq((await fake.health()).latexindent, { available: true, version: '9.9.9' }, '/health names the latexindent it found');

  let r = await fake.format({ text: '\\begin{itemize}\r\n\\item a\r\n\\end{itemize}\r\n', indent: '\t', ext: 'tex' });
  eq(r.body, { ok: true, text: '\\begin{itemize}\n\t\\item a\n\\end{itemize}\n' }, 'the answer is latexindent\'s stdout, line ends as CodeMirror counts them');
  const args = fs.readFileSync(`${log}.args`, 'utf8').trim().split('\n');
  eq(args, ['-g', '/dev/null', 'doc.tex'], 'only the log redirect and the file: no -w, -l, -m, -r, -o or -y');
  const cwd = fs.readFileSync(`${log}.cwd`, 'utf8').trim();
  check(!path.resolve(cwd).startsWith(dataDir) && path.basename(cwd).startsWith('aldine-format-'), `latexindent runs in a fresh directory outside DATA_DIR (got ${cwd})`);
  const home = fs.readFileSync(`${log}.home`, 'utf8').trim();
  // macOS: /var is /private/var, and $PWD says which of the two it went through.
  check(home === cwd || home.endsWith(cwd) || cwd.endsWith(home), `HOME is that directory, so no account settings are read (got ${home})`);
  check(!fs.existsSync(cwd), 'the directory is gone afterwards');

  r = await fake.format({ text: '\\item a\n', indent: '  ', ext: 'sty' });
  eq(fs.readFileSync(`${log}.args`, 'utf8').trim().split('\n'), ['-g', '/dev/null', '-y=defaultIndent:"  "', 'doc.sty'], 'spaces are passed as defaultIndent, the extension kept');

  for (const [body, what] of [
    [{ text: 'x', indent: '\t\t' }, 'two tabs'],
    [{ text: 'x', indent: '"\nx: y' }, 'YAML in the indent'],
    [{ text: 'x', indent: '         ' }, 'nine spaces'],
    [{ text: 'x', ext: 'bib' }, 'a .bib file'],
    [{ text: 'x', ext: '../tex' }, 'a path as the extension'],
    [{ text: 42 }, 'text that is no string'],
  ]) eq((await fake.format(body)).body.reason, 'invalid', `refused: ${what}`);

  fs.rmSync(`${log}.input`, { force: true });
  r = await fake.format({ text: 'x'.repeat(5001), indent: '\t' });
  eq(r.body.reason, 'too-large', 'over the size cap');
  check(!fs.existsSync(`${log}.input`), 'latexindent never ran for it');
  r = await fake.format({ text: 'ü'.repeat(2600), indent: '\t' });
  eq(r.body.reason, 'too-large', 'the cap counts UTF-8 bytes, not characters');
  r = await fake.format({ text: 'x'.repeat(20_000), indent: '\t' }).catch(() => ({ body: { reason: 'too-large' } }));
  eq(r.body.reason, 'too-large', 'a body far over the cap is not read to the end');

  const t0 = Date.now();
  r = await fake.format({ text: 'SLEEP\n', indent: '\t' });
  eq(r.body.reason, 'timeout', 'past the time limit');
  check(Date.now() - t0 < 5_000, `the answer comes at the limit, not when latexindent ends (${Date.now() - t0} ms)`);
  const pid = Number(fs.readFileSync(`${log}.pid`, 'utf8'));
  await until(() => !alive(pid), 'the timed-out latexindent to be killed');

  eq((await fake.format({ text: 'REWRITE\n', indent: '\t' })).body.reason, 'changed-text', 'an answer with other words in it is refused');
  r = await fake.format({ text: 'FAIL\n', indent: '\t' });
  eq([r.body.reason, r.body.error], ['failed', 'boom: it broke'], 'a failing run answers its first line of stderr');
  await until(() => leftovers().length === before.length, 'every temp directory to be removed');

  // ---- no latexindent ----
  const none = path.join(tmp, 'nobin');
  fs.mkdirSync(none);
  fs.symlinkSync(process.execPath, path.join(none, 'node'));
  const missing = await startCompiler({ PATH: none });
  eq((await missing.health()).latexindent.available, false, '/health says latexindent is missing');
  eq((await missing.format({ text: 'x', indent: '\t' })).body.reason, 'unavailable', 'formatting answers unavailable');

  // ---- the real latexindent ----
  const real = spawnSync('latexindent', ['--version'], { encoding: 'utf8', env: { ...process.env, HOME: tmp } });
  if (real.status !== 0) {
    console.log(`SKIP real latexindent: ${real.error ? 'not installed' : (real.stderr || '').split('\n')[0]}`);
  } else {
    // Settings that would show if read: a project-style local file in the
    // service's working directory and an account-wide indentconfig.yaml.
    const workdir = path.join(tmp, 'workdir');
    const home = path.join(tmp, 'home');
    fs.mkdirSync(workdir);
    fs.mkdirSync(home);
    for (const f of ['localSettings.yaml', 'latexindent.yaml', '.latexindent.yaml']) fs.writeFileSync(path.join(workdir, f), 'defaultIndent: "XXXX"\n');
    fs.writeFileSync(path.join(home, 'my.yaml'), 'defaultIndent: "YYYY"\n');
    fs.writeFileSync(path.join(home, 'indentconfig.yaml'), `paths:\n- ${path.join(home, 'my.yaml')}\n`);
    fs.writeFileSync(path.join(home, '.indentconfig.yaml'), `paths:\n- ${path.join(home, 'my.yaml')}\n`);
    const li = await startCompiler({ HOME: home, LATEXINDENT_CONFIG: path.join(home, 'indentconfig.yaml') }, workdir);
    check((await li.health()).latexindent.available, 'the real latexindent is found');

    const doc = [
      '\\documentclass{article}',
      '\\begin{document}',
      '\\begin{itemize}',
      '\\item one % a comment: \\begin{itemize}',
      '\\item two \\verb|\\begin{x}   {| tail',
      '\\begin{enumerate}',
      '\\item nested',
      '\\end{enumerate}',
      '\\end{itemize}',
      '\\begin{verbatim}',
      '   keep   this',
      '\\begin{itemize}',
      'trailing   ',
      '\\end{verbatim}',
      '\\begin{lstlisting}',
      '  int main() {',
      'return 0; }',
      '\\end{lstlisting}',
      '% \\begin{figure}',
      '\\begin{figure}',
      '\\centering',
      '\\end{figure}',
      '\\end{document}',
      '',
    ].join('\n');
    r = await li.format({ text: doc, indent: '  ', ext: 'tex' });
    check(r.body.ok, `formats (${JSON.stringify(r.body)})`);
    const out = r.body.text.split('\n');
    check(!/XXXX|YYYY/.test(r.body.text), 'no local or account settings were read');
    eq(out.length, doc.split('\n').length, 'no line was added or removed');
    eq(out[3], '  \\item one % a comment: \\begin{itemize}', 'an item is indented, its comment kept');
    eq(out[4], '  \\item two \\verb|\\begin{x}   {| tail', '\\verb keeps its spaces and braces');
    check(/^ {3,}\\begin\{enumerate\}$/.test(out[5]) && /^ {5,}\\item nested$/.test(out[6]), `a nested list is indented deeper (got ${JSON.stringify(out.slice(5, 7))})`);
    eq(out.slice(9, 14), ['\\begin{verbatim}', '   keep   this', '\\begin{itemize}', 'trailing   ', '\\end{verbatim}'], 'verbatim is left byte for byte');
    eq(out.slice(14, 18), ['\\begin{lstlisting}', '  int main() {', 'return 0; }', '\\end{lstlisting}'], 'lstlisting is left byte for byte');
    eq(out.slice(18, 21), ['% \\begin{figure}', '\\begin{figure}', '  \\centering'], 'a commented-out \\begin opens nothing');
    r = await li.format({ text: r.body.text, indent: '  ', ext: 'tex' });
    eq(r.body.text, (await li.format({ text: doc, indent: '  ' })).body.text, 'formatting again changes nothing');
    eq((await li.format({ text: '\\begin{itemize}\n\\item a\n\\end{itemize}', indent: '\t' })).body.text, '\\begin{itemize}\n\t\\item a\n\\end{itemize}', 'a tab indent, and no line end added at the end');
    for (const f of fs.readdirSync(workdir)) check(/yaml$/.test(f), `nothing written beside the service (found ${f})`);
    console.log('real latexindent: checked');
  }
  console.log('compiler-format: ok');
} finally {
  for (const c of children) c.kill('SIGKILL');
  fs.rmSync(tmp, { recursive: true, force: true });
}
