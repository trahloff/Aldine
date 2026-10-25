/**
 * Page 1 of a successful typeset as a JPEG about WIDTH pixels wide, written
 * beside the PDF for the project list. Ghostscript renders it under -dSAFER
 * (both TeX Live bases ship it for epstopdf); poppler's pdftoppm stands in on
 * a host without gs. With neither, or ALDINE_THUMBNAILS=0, there is no
 * thumbnail and typesetting is unaffected.
 *
 * A render starts after the typeset has answered and never holds a compile
 * slot. It reads the PDF in place, so a typeset starting in the same output
 * directory first stops the render still running there (cancel). A render
 * that fails or outlasts RENDER_TIMEOUT_MS removes the thumbnail, which then
 * never stands for a typeset it does not show; a stopped or skipped render
 * leaves the files as they were.
 *
 * Both files are dot-named: under openout_any=p TeX may not open a name that
 * starts with a dot, so a document cannot write either of them.
 *   .<base>.thumb.jpg   the image
 *   .<base>.thumb.json  { v, w, h, pdf: { size, mtimeMs } }
 * v is the first 16 hex digits of the image's SHA-256, the value the app
 * server derives from the bytes it serves (apps/server/src/thumbnail.ts).
 * The image is renamed into place before the sidecar, so a sidecar never
 * describes an image that is not there yet.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// A sheet on the list is at most about 234 CSS px wide on a desktop and 171 on a
// phone: 512px covers both at 2x and a phone at 3x.
const WIDTH = 512;
// A page taller than 3:1 is scaled to this height and comes out narrower.
const MAX_HEIGHT = 1536;
const QUALITY = 75;
const RENDER_TIMEOUT_MS = Number(process.env.THUMBNAIL_TIMEOUT_MS || 10_000);
// One renderer process at a time beside the TeX runs; a burst beyond
// MAX_QUEUED skips its renders, and the next typeset of each retries.
const MAX_CONCURRENT = 1;
const MAX_QUEUED = 64;

const files = (base) => ({
  jpg: `.${base}.thumb.jpg`,
  json: `.${base}.thumb.json`,
  tmpPrefix: `.${base}.thumb.tmp`,
  tmp: `.${base}.thumb.tmp.jpg`,
  tmpJson: `.${base}.thumb.tmp.json`,
});

const version = (jpeg) => crypto.createHash('sha256').update(jpeg).digest('hex').slice(0, 16);

/** Pixel size from the first frame header, or null when `buf` is not a JPEG. */
function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xff) { i += 1; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null;
    // SOF0-SOF15; C4 (DHT), C8 (JPG) and CC (DAC) share the range and are not frames.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const h = buf.readUInt16BE(i + 5);
      const w = buf.readUInt16BE(i + 7);
      return w > 0 && h > 0 ? { w, h } : null;
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

/**
 * Page 1's size in points as shown (/Rotate applied), from Ghostscript's
 * -dPDFINFO report, or null. The report also prints the document's own
 * strings, so a crafted title can forge the line: the result only sizes
 * the author's own thumbnail, and the caller clamps the resolution.
 */
function pageSize(report) {
  const m = report.match(/^Page 1 MediaBox: \[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\](.*)$/m);
  if (!m) return null;
  let w = Math.abs(Number(m[3]) - Number(m[1]));
  let h = Math.abs(Number(m[4]) - Number(m[2]));
  const rotate = Number((m[5].match(/Rotate = (-?\d+)/) || [])[1] || 0);
  if (Math.abs(rotate) % 180 === 90) [w, h] = [h, w];
  return Number.isFinite(w) && Number.isFinite(h) && w >= 1 && h >= 1 ? { w, h } : null;
}

/** Runs to completion, the deadline, or job.kill (a typeset taking over the directory). */
function run(cmd, args, cwd, deadline, job) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: process.env.HOME || '/tmp' } });
    } catch (err) {
      resolve({ code: -2, out: String(err) });
      return;
    }
    let out = '';
    const collect = (d) => { if (out.length < 65_536) out += d; };
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } } };
    const timer = setTimeout(kill, Math.max(0, deadline - Date.now()));
    if (job) {
      job.kill = kill;
      if (job.cancelled) kill();
    }
    const done = (code) => {
      clearTimeout(timer);
      if (job && job.kill === kill) job.kill = null;
      resolve({ code, out });
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('close', (code, signal) => done(signal ? -1 : code));
    child.on('error', (err) => { out += String(err); done(-2); });
  });
}

let probed = null;
/** 'gs', 'pdftoppm' or null, decided once. */
function probe() {
  if (!probed) {
    probed = (async () => {
      if (process.env.ALDINE_THUMBNAILS === '0') return null;
      const deadline = () => Date.now() + 10_000;
      if ((await run('gs', ['--version'], undefined, deadline())).code === 0) return 'gs';
      if ((await run('pdftoppm', ['-v'], undefined, deadline())).code === 0) return 'pdftoppm';
      return null;
    })();
  }
  return probed;
}

let renderer = null;
/** What /health reports: the renderer once probed, else 'none'. */
const rendererName = () => renderer || 'none';

/** Ghostscript runs PostScript as readily as PDF; only a PDF reaches it. */
function isPdf(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(5);
    return fs.readSync(fd, head, 0, 5, 0) === 5 && head.toString('latin1') === '%PDF-';
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

async function renderGs(cwd, pdf, out, deadline, job) {
  const info = await run('gs', ['-q', '-dSAFER', '-dBATCH', '-dNOPAUSE', '-dNODISPLAY', '-dPDFINFO', '-dFirstPage=1', '-dLastPage=1', pdf], cwd, deadline, job);
  if (job.cancelled) return false;
  const size = info.code === 0 ? pageSize(info.out) : null;
  // 88 dpi is about WIDTH for A4 and Letter, for a report this cannot read.
  const dpi = Math.min(600, Math.max(1, size ? Math.min((WIDTH * 72) / size.w, (MAX_HEIGHT * 72) / size.h) : 88));
  const r = await run('gs', [
    '-q', '-dSAFER', '-dBATCH', '-dNOPAUSE', '-dNOPROMPT',
    '-sDEVICE=jpeg', `-dJPEGQ=${QUALITY}`, `-r${dpi.toFixed(4)}`,
    '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4',
    '-dFirstPage=1', '-dLastPage=1',
    // "%d" in an output name is a page-number format to Ghostscript.
    `-sOutputFile=${out.replace(/%/g, '%%')}`,
    pdf,
  ], cwd, deadline, job);
  return r.code === 0;
}

async function renderPoppler(cwd, pdf, outPrefix, out, deadline, job) {
  // -scale-to sizes the long side of the page as shown; -scale-to-x would
  // size the unrotated width. The first pass at WIDTH tells the shape.
  const args = (long) => ['-f', '1', '-l', '1', '-singlefile', '-jpeg', '-jpegopt', `quality=${QUALITY}`, '-scale-to', String(long), pdf, outPrefix];
  if ((await run('pdftoppm', args(WIDTH), cwd, deadline, job)).code !== 0 || job.cancelled) return false;
  const first = jpegSize(fs.readFileSync(path.join(cwd, out)));
  if (!first) return false;
  if (first.h <= first.w) return true;
  const long = Math.min(MAX_HEIGHT, Math.round((WIDTH * first.h) / first.w));
  return (await run('pdftoppm', args(long), cwd, deadline, job)).code === 0;
}

async function render(job) {
  const kind = await probe();
  renderer = kind;
  if (!kind || job.cancelled) return;
  const { outAbs, base } = job;
  const f = files(base);
  const at = (name) => path.join(outAbs, name);
  const deadline = Date.now() + RENDER_TIMEOUT_MS;
  const pdf = `./${base}.pdf`;
  let ok = false;
  try {
    if (!isPdf(at(`${base}.pdf`))) return;
    const rendered = kind === 'gs'
      ? await renderGs(outAbs, pdf, `./${f.tmp}`, deadline, job)
      : await renderPoppler(outAbs, pdf, `./${f.tmpPrefix}`, f.tmp, deadline, job);
    if (!rendered || job.cancelled) return;
    const img = fs.readFileSync(at(f.tmp));
    const size = jpegSize(img);
    if (!size) return;
    fs.writeFileSync(at(f.tmpJson), JSON.stringify({ v: version(img), w: size.w, h: size.h, pdf: job.pdf }));
    if (job.cancelled) return;
    // Synchronous from here on: no cancel can land between the two renames.
    fs.renameSync(at(f.tmp), at(f.jpg));
    fs.renameSync(at(f.tmpJson), at(f.json));
    ok = true;
  } catch {
    ok = false;
  } finally {
    // Sidecar before image: a reader that finds the sidecar can still find the image.
    const gone = !ok && !job.cancelled ? [f.json, f.jpg] : [];
    for (const name of [f.tmp, f.tmpJson, ...gone]) { try { fs.rmSync(at(name), { force: true }); } catch { /* best effort */ } }
  }
}

let active = 0;
const waiters = [];
async function acquire() {
  if (active >= MAX_CONCURRENT) await new Promise((r) => waiters.push(r));
  active++;
}
function release() {
  active--;
  const next = waiters.shift();
  if (next) next();
}

/** Whether the thumbnail on disk was rendered from exactly this PDF. */
function upToDate(outAbs, base, st) {
  const f = files(base);
  try {
    const side = JSON.parse(fs.readFileSync(path.join(outAbs, f.json), 'utf8'));
    return !!side.pdf && side.pdf.size === st.size && side.pdf.mtimeMs === st.mtimeMs && fs.existsSync(path.join(outAbs, f.jpg));
  } catch {
    return false;
  }
}

/** The render, if any, per PDF: `<outAbs>\0<base>`. */
const jobs = new Map();
const keyOf = (outAbs, base) => `${outAbs}\0${base}`;

function stop(job) {
  job.cancelled = true;
  if (job.kill) job.kill();
}

/**
 * Queue a render of `<outAbs>/<base>.pdf` after a successful typeset. Never
 * throws; returns at once. The work starts on a later turn of the event
 * loop, after the typeset's response has been written.
 */
function schedule(outAbs, base) {
  try {
    const st = fs.statSync(path.join(outAbs, `${base}.pdf`));
    if (upToDate(outAbs, base, st)) return;
    const key = keyOf(outAbs, base);
    const prev = jobs.get(key);
    if (waiters.length >= MAX_QUEUED) return;
    if (prev) stop(prev);
    const job = { outAbs, base, pdf: { size: st.size, mtimeMs: st.mtimeMs }, cancelled: false, started: false, kill: null, done: null };
    job.done = new Promise((r) => setImmediate(r))
      .then(async () => {
        if (prev) await prev.done;
        await acquire();
        try {
          if (job.cancelled) return;
          job.started = true;
          await render(job);
        } finally {
          release();
        }
      })
      .catch(() => { /* a thumbnail is never worth an unhandled rejection */ })
      .finally(() => { if (jobs.get(key) === job) jobs.delete(key); });
    jobs.set(key, job);
  } catch { /* no PDF to render */ }
}

/**
 * Stop the renders reading PDFs in `outAbs`, before a typeset rewrites them.
 * Waits only for a render that has started (its process dies at once); a
 * queued one is marked and skips when its turn comes.
 */
async function cancel(outAbs) {
  const here = [...jobs.values()].filter((j) => j.outAbs === outAbs);
  for (const job of here) stop(job);
  await Promise.all(here.filter((j) => j.started).map((j) => j.done));
}

const idle = () => Promise.all([...jobs.values()].map((j) => j.done));

module.exports = { schedule, cancel, idle, probe: async () => (renderer = await probe()), rendererName, jpegSize, pageSize, version, files, WIDTH, MAX_HEIGHT };
