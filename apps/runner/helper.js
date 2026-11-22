#!/usr/bin/env node
'use strict';
/**
 * The steps of a job that touch job files, run by the control process as the
 * job user (RUNNER.md, D5 and D6), never as the control process's own user:
 *
 *   node helper.js unpack   stdin: FILE frames, END  -> writes the project
 *   node helper.js collect  stdin: HEADER {manifest, limits}, END
 *                           stdout: FILE and SKIP frames, HEADER {deleted}, END
 *   node helper.js wipe     empty every place a job can write
 *
 * Killing the job's processes is the control process's own step
 * (server.js, killAllJobProcesses): it runs before any of these and leaves
 * no job process alive, so no helper ever runs next to a job process.
 *
 * collect runs only after kill, so no job process can change a file while
 * it is read.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const frames = require('./frames.js');
const { pathProblem, skippedDir, MAX_DEPTH } = require('./paths.js');

const WORK = process.env.RUNNER_WORK || '/work';
const DEV = process.env.RUNNER_INSECURE_DEV === '1';
const PROJECT = path.join(WORK, 'project');
const HOME = path.join(WORK, 'home');
const MPL_CACHE = process.env.RUNNER_MPL_CACHE || '/opt/aldine-runner/mpl';
const MAX_ENTRIES = 20_000;

function readStdin(maxTotal) {
  return new Promise((resolve, reject) => {
    const reader = new frames.Reader({ maxFrame: maxTotal, maxTotal });
    const got = [];
    process.stdin.on('data', (c) => { try { got.push(...reader.push(c)); } catch (e) { reject(e); process.stdin.destroy(); } });
    process.stdin.on('end', () => (reader.ended ? resolve(got) : reject(new Error('input ended early'))));
    process.stdin.on('error', reject);
  });
}

async function unpack() {
  const got = await readStdin(80 * 1024 * 1024);
  for (const dir of [PROJECT, HOME, path.join(WORK, 'tmp')]) fs.mkdirSync(dir, { mode: 0o755 });
  const mplDir = path.join(HOME, '.config', 'matplotlib');
  fs.mkdirSync(mplDir, { recursive: true, mode: 0o755 });
  try {
    for (const name of fs.readdirSync(MPL_CACHE)) fs.copyFileSync(path.join(MPL_CACHE, name), path.join(mplDir, name));
  } catch { /* no prebuilt font cache: Matplotlib builds one on first use */ }
  for (const f of got) {
    if (f.type !== frames.FILE) continue;
    const problem = pathProblem(f.path);
    if (problem) throw new Error(`refused input path ${JSON.stringify(f.path)}: ${problem}`);
    const abs = path.join(PROJECT, f.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o755 });
    const fd = fs.openSync(abs, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644);
    try { fs.writeSync(fd, f.content); } finally { fs.closeSync(fd); }
  }
}

async function collect() {
  const got = await readStdin(16 * 1024 * 1024);
  const head = got.find((f) => f.type === frames.HEADER)?.value;
  if (!head) throw new Error('collect needs a header');
  const manifest = new Map(Object.entries(head.manifest || {}));
  const { maxFiles, maxFileBytes, maxTotalBytes } = head.limits;
  const out = process.stdout;
  const write = (buf) => new Promise((resolve) => { if (out.write(buf)) resolve(); else out.once('drain', resolve); });
  let files = 0, bytes = 0, entries = 0;
  const seen = new Set();

  async function walk(dir, rel, depth) {
    let names;
    try { names = fs.readdirSync(dir).sort(); } catch { await write(frames.skip(rel || '.', 'folder could not be read')); return; }
    for (const name of names) {
      const r = rel ? `${rel}/${name}` : name;
      if (++entries > MAX_ENTRIES) { if (entries === MAX_ENTRIES + 1) await write(frames.skip(r, `more than ${MAX_ENTRIES} files and folders; the rest were not looked at`)); return; }
      const abs = path.join(dir, name);
      let st;
      try { st = fs.lstatSync(abs); } catch { continue; }
      if (st.isDirectory()) {
        if (skippedDir(name)) continue;
        if (depth + 1 >= MAX_DEPTH) { await write(frames.skip(r, 'folders nested too deep')); continue; }
        await walk(abs, r, depth + 1);
        continue;
      }
      seen.add(r);
      if (name.startsWith('.')) continue;
      if (st.isSymbolicLink()) { await write(frames.skip(r, 'symbolic links are not copied')); continue; }
      if (!st.isFile()) { await write(frames.skip(r, 'not a regular file')); continue; }
      const problem = pathProblem(r);
      if (problem) { await write(frames.skip(r, problem)); continue; }
      let fd;
      try { fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch { await write(frames.skip(r, 'could not be opened')); continue; }
      try {
        const fst = fs.fstatSync(fd);
        if (!fst.isFile()) { await write(frames.skip(r, 'not a regular file')); continue; }
        if (fst.nlink !== 1) { await write(frames.skip(r, 'hard links are not copied')); continue; }
        // The size limit stops writes at exactly the limit: such a file is cut off.
        if (fst.size >= maxFileBytes) { await write(frames.skip(r, `reached the ${Math.round(maxFileBytes / 1048576)} MB file size limit, so it is probably cut off`)); continue; }
        const content = Buffer.alloc(fst.size);
        let off = 0;
        while (off < fst.size) {
          const n = fs.readSync(fd, content, off, fst.size - off, off);
          if (n === 0) break;
          off += n;
        }
        const data = content.subarray(0, off);
        const hash = crypto.createHash('sha256').update(data).digest('hex');
        if (manifest.get(r) === hash) continue;
        if (files + 1 > maxFiles || bytes + data.length > maxTotalBytes) { await write(frames.skip(r, 'over the limit for files a run may bring back')); continue; }
        files += 1;
        bytes += data.length;
        await write(frames.file(r, data));
      } finally { fs.closeSync(fd); }
    }
  }

  await walk(PROJECT, '', 0);
  let deleted = 0;
  for (const p of manifest.keys()) if (!seen.has(p)) deleted += 1;
  await write(frames.header({ deleted }));
  await new Promise((resolve) => out.end(frames.end(), resolve));
}

/** Empties /work with GNU chmod and rm, which walk deep trees relative to
 *  open folders (no PATH_MAX limit). The control process checks the result. */
function wipe() {
  if (DEV) { for (const n of fs.readdirSync(WORK)) fs.rmSync(path.join(WORK, n), { recursive: true, force: true }); return; }
  const { status: c } = spawnSync('chmod', ['-R', 'u+rwx', '--', WORK], { stdio: 'ignore' });
  const names = fs.readdirSync(WORK).map((n) => path.join(WORK, n));
  if (names.length) {
    const { status } = spawnSync('rm', ['-rf', '--one-file-system', '--', ...names], { stdio: 'ignore' });
    if (status !== 0) throw new Error(`rm exited ${status} (chmod ${c})`);
  }
  if (!DEV) {
    for (const d of ['/dev/shm', '/dev/mqueue']) {
      let entries = [];
      try { entries = fs.readdirSync(d); } catch { continue; }
      if (entries.length) spawnSync('rm', ['-rf', '--one-file-system', '--', ...entries.map((n) => path.join(d, n))], { stdio: 'ignore' });
    }
    spawnSync('ipcrm', ['--all'], { stdio: 'ignore' });
  }
}

const mode = process.argv[2];
const steps = { unpack, collect, wipe };
if (!steps[mode]) { process.stderr.write(`unknown step ${mode}\n`); process.exit(2); }
Promise.resolve()
  .then(() => steps[mode]())
  .then(() => process.exit(0), (err) => { process.stderr.write(`${err && err.message || err}\n`); process.exit(1); });
