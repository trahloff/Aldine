/**
 * POST /stop on the compile service ends the typesets of the one project
 * directory it names: the running latexmk (and what it started) is killed,
 * a typeset waiting for a slot leaves the queue without running, and every
 * other project's typeset goes on. A stopped typeset answers stopped: true.
 *
 * The real compiler script, with a latexmk on PATH that only waits.
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
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-compiler-stop-')));
const dataDir = path.join(tmp, 'data');
const started = path.join(tmp, 'started');
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);
// Records the project it runs in, then waits far longer than the test.
fs.writeFileSync(path.join(bin, 'latexmk'), '#!/bin/sh\nbasename "$PWD" >> "$ALDINE_TEST_STARTED"\nexec sleep 60\n', { mode: 0o755 });

for (const name of ['a', 'b', 'c']) {
  fs.mkdirSync(path.join(dataDir, 'projects', name), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'projects', name, 'main.tex'), '\\documentclass{article}\\begin{document}x\\end{document}\n');
}

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const port = await freePort();
const child = spawn(process.execPath, [compilerJs], {
  env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, PORT: String(port), DATA_DIR: dataDir, ALDINE_PREAMBLE_CACHE: '0', ALDINE_TEST_STARTED: started, MAX_CONCURRENT_COMPILES: '2' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => {
  child.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve(); });
  child.on('exit', (code) => reject(new Error(`compiler exited early: ${code}`)));
  setTimeout(() => reject(new Error('compiler did not start')), 20_000);
});

const post = async (route, body) => {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
/** A typeset in flight, and whether it has answered yet. */
const typeset = (name) => {
  const t = { done: false, result: null };
  t.promise = post('/compile', { projectDir: `projects/${name}`, rootFile: 'main.tex' }).then((r) => { t.done = true; t.result = r; return r; });
  return t;
};
const startedRuns = () => { try { return fs.readFileSync(started, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
const until = async (cond, what, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};
const within = (p, ms, what) => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} took over ${ms} ms`)), ms))]);

try {
  const a = typeset('a');
  const b = typeset('b');
  await until(() => startedRuns().length === 2, 'both typesets to start');
  const c = typeset('c'); // both slots are taken: c waits
  await new Promise((r) => setTimeout(r, 300));
  check(!c.done, 'the third typeset waits for a slot');

  // Stopping the waiting one takes it out of the queue; latexmk never ran for it.
  eq((await post('/stop', { projectDir: 'projects/c' })).body, { ok: true, stopped: 1 }, 'the stop names one typeset');
  const cStopped = await within(c.promise, 3_000, 'the queued typeset');
  eq(cStopped.status, 200, 'a stopped typeset is an answer, not a failure');
  eq(cStopped.body.stopped, true, 'it says it was stopped');
  eq(cStopped.body.ok, false, 'and is not a success');
  check(!startedRuns().includes('c'), 'latexmk never started for the queued one');

  // Stopping a running one kills it, and only it.
  eq((await post('/stop', { projectDir: 'projects/a' })).body, { ok: true, stopped: 1 }, 'the stop names the running typeset of a');
  const aStopped = await within(a.promise, 5_000, 'the running typeset');
  eq(aStopped.body.stopped, true, 'the running typeset says it was stopped');
  eq(aStopped.body.ok, false, 'and is not a success');
  eq(aStopped.body.log, '', 'with no log from an earlier run');
  await new Promise((r) => setTimeout(r, 300));
  check(!b.done, 'another project\'s typeset goes on');

  // A directory with nothing running: nothing to stop.
  eq((await post('/stop', { projectDir: 'projects/a' })).body, { ok: true, stopped: 0 }, 'a stop with nothing running stops nothing');
  eq((await post('/stop', { projectDir: '../outside' })).status, 400, 'a directory outside the data volume is refused');

  // The project typesets again after its stop.
  const again = typeset('a');
  await until(() => startedRuns().filter((n) => n === 'a').length === 2, 'the next typeset of a to start');
  eq((await post('/stop', { projectDir: 'projects/a' })).body.stopped, 1, 'and that one can be stopped too');
  eq((await within(again.promise, 5_000, 'the second typeset of a')).body.stopped, true, 'it answers stopped');

  eq((await post('/stop', { projectDir: 'projects/b' })).body.stopped, 1, 'b is stopped last');
  eq((await within(b.promise, 5_000, 'the typeset of b')).body.stopped, true, 'b answers stopped');
  console.log('compiler-stop: OK');
} finally {
  child.kill('SIGKILL');
  fs.rmSync(tmp, { recursive: true, force: true });
}
