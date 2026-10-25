/**
 * Page-1 thumbnails in the compile service (apps/compiler/thumbnail.js).
 *
 * - A successful typeset renders page 1 under -dSAFER into a dot-named JPEG
 *   and sidecar beside the PDF, after the typeset has answered. The sidecar's
 *   size is the image's own and its `v` is the version the app server
 *   derives from the bytes; a root file in a subdirectory gets its own pair.
 * - A typeset whose PDF did not change renders nothing again; a failed
 *   typeset keeps the previous thumbnail; one that logged errors but wrote a
 *   fresh PDF is rendered, as the editor shows that PDF.
 * - A renderer that fails, or hangs past THUMBNAIL_TIMEOUT_MS, leaves no
 *   thumbnail and no temporary file, and the typeset answers at once either
 *   way. A typeset that starts while a render hangs stops it instead of
 *   waiting for it.
 * - Something that is not a PDF never reaches the renderer.
 * - Without gs or pdftoppm, or with ALDINE_THUMBNAILS=0, typesetting works
 *   and /health reports "none".
 *
 * The real compiler script with a scripted latexmk and gs on PATH (runs
 * everywhere), then the real gs or pdftoppm on hand-made PDFs when either is
 * installed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { check, eq } from './assert.mjs';
import { readThumbMeta, thumbFiles, thumbVersion } from '../src/thumbnail.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const compilerJs = path.resolve(here, '../../compiler/server.js');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-thumbnail-')));
const dataDir = path.join(tmp, 'data');
const modes = path.join(tmp, 'modes');
fs.mkdirSync(modes);
const setMode = (tool, mode) => fs.writeFileSync(path.join(modes, tool), mode);

// 12x17 px, so a size taken from the page instead of the image would show.
const TINY_JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAARAAwDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAL/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCtAIUAA//Z', 'base64');
fs.writeFileSync(path.join(tmp, 'tiny.jpg'), TINY_JPEG);

/** A PDF with `pages` pages of w x h points, a filled box on each; `rotate` sets /Rotate. */
function minimalPdf({ w = 595.28, h = 841.89, pages = 1, rotate = 0, mark = '' } = {}) {
  const objs = [];
  const kids = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  for (let i = 0; i < pages; i++) {
    const page = 3 + i * 2;
    const content = `0.2 0.2 0.2 rg ${w * 0.1} ${h * 0.7} ${w * 0.8} ${h * 0.1} re f % ${mark}\n`;
    kids.push(`${page} 0 R`);
    objs[page] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}]${rotate ? ` /Rotate ${rotate}` : ''} /Contents ${page + 1} 0 R >>`;
    objs[page + 1] = `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`;
  }
  objs[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`;
  let out = '%PDF-1.4\n';
  const offsets = [];
  for (let n = 1; n < objs.length; n++) {
    offsets[n] = Buffer.byteLength(out);
    out += `${n} 0 obj\n${objs[n]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objs.length; n++) out += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// ---- scripted tools: node scripts, so PATH can hold nothing else ----
const bin = path.join(tmp, 'bin');
const binNoGs = path.join(tmp, 'bin-nogs');
fs.mkdirSync(bin);
fs.mkdirSync(binNoGs);
const node = `#!${process.execPath}\n`;
// latexmk: "ok" writes the PDF named by $ALDINE_TEST_PDF (a fresh mtime each
// time), "noop" leaves the output as it is, "fail" exits non-zero untouched.
const latexmk = `${node}const fs = require('fs'), path = require('path');
const mode = (() => { try { return fs.readFileSync(path.join(process.env.ALDINE_TEST_MODES, 'latexmk'), 'utf8').trim(); } catch { return 'ok'; } })();
const root = process.argv[process.argv.length - 1];
const out = path.join(path.dirname(root), '.aldine-out');
const base = path.basename(root).replace(/\\.tex$/i, '');
if (mode === 'errors') { fs.writeFileSync(path.join(out, base + '.pdf'), fs.readFileSync(process.env.ALDINE_TEST_PDF)); fs.writeFileSync(path.join(out, base + '.log'), '! Undefined control sequence.\\nl.3 \\\\oops\\nOutput written on ' + base + '.pdf (1 page, 900 bytes).\\n'); process.exit(12); }
if (mode === 'fail') { fs.writeFileSync(path.join(out, base + '.log'), '! Undefined control sequence.\\nl.3 \\\\oops\\n'); process.exit(12); }
if (mode === 'ok') { fs.writeFileSync(path.join(out, base + '.pdf'), fs.readFileSync(process.env.ALDINE_TEST_PDF)); fs.writeFileSync(path.join(out, base + '.log'), 'Output written on ' + base + '.pdf (1 page, 900 bytes).\\n'); }
`;
// gs: logs every call; "ok" answers -dPDFINFO for an A4 page and writes the
// tiny JPEG as the render, "fail" exits 1, "hang" records its pid and sleeps.
const gs = `${node}const fs = require('fs'), path = require('path');
const m = process.env.ALDINE_TEST_MODES;
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('10.07.1'); process.exit(0); }
fs.appendFileSync(path.join(m, 'gs-calls'), JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
const mode = (() => { try { return fs.readFileSync(path.join(m, 'gs'), 'utf8').trim(); } catch { return 'ok'; } })();
if (mode === 'fail') { console.error('Unrecoverable error'); process.exit(1); }
if (mode === 'hang') { fs.writeFileSync(path.join(m, 'gs-pid'), String(process.pid)); setTimeout(() => {}, 60_000); return; }
if (args.includes('-dPDFINFO')) { console.log('Page 1 MediaBox: [0 0 595.276001 841.890015]'); process.exit(0); }
const o = args.find((a) => a.startsWith('-sOutputFile='));
fs.copyFileSync(process.env.ALDINE_TEST_JPEG, o.slice('-sOutputFile='.length).replace(/%%/g, '%'));
`;
for (const dir of [bin, binNoGs]) fs.writeFileSync(path.join(dir, 'latexmk'), latexmk, { mode: 0o755 });
fs.writeFileSync(path.join(bin, 'gs'), gs, { mode: 0o755 });

const pdfFile = path.join(tmp, 'doc.pdf');
const writePdf = (mark) => fs.writeFileSync(pdfFile, minimalPdf({ mark }));
writePdf('one');

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const children = [];
async function startCompiler(pathDirs, env = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [compilerJs], {
    env: { PATH: pathDirs.join(path.delimiter), HOME: tmp, PORT: String(port), DATA_DIR: dataDir, ALDINE_PREAMBLE_CACHE: '0', THUMBNAIL_TIMEOUT_MS: '1500', ALDINE_TEST_MODES: modes, ALDINE_TEST_PDF: pdfFile, ALDINE_TEST_JPEG: path.join(tmp, 'tiny.jpg'), ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  children.push(child);
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve(); });
    child.on('exit', (code) => reject(new Error(`compiler exited early: ${code}`)));
    setTimeout(() => reject(new Error('compiler did not start')), 20_000);
  });
  const base = `http://127.0.0.1:${port}`;
  return {
    health: async () => (await fetch(`${base}/health`)).json(),
    compile: async (projectDir, rootFile = 'main.tex') => {
      const t0 = Date.now();
      const res = await fetch(`${base}/compile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectDir, rootFile }) });
      return { status: res.status, body: await res.json(), ms: Date.now() - t0 };
    },
  };
}

function project(name, files = { 'main.tex': '\\documentclass{article}\\begin{document}x\\end{document}\n' }) {
  const dir = path.join(dataDir, 'projects', name);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting: ${what}`);
}
const read = (f) => { try { return fs.readFileSync(f); } catch { return null; } };
const gsCalls = () => (read(path.join(modes, 'gs-calls'))?.toString() || '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const leftovers = (outDir) => fs.readdirSync(outDir).filter((f) => f.includes('.thumb.tmp'));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

try {
  const c = await startCompiler([bin]);
  eq((await c.health()).thumbnails, 'gs', '/health names the renderer');

  // ---- a successful typeset renders page 1 ----
  const dir = project('p1');
  const out = path.join(dir, '.aldine-out');
  const jpg = path.join(dir, thumbFiles('main.tex').jpg);
  const json = path.join(dir, thumbFiles('main.tex').json);
  eq(path.dirname(jpg), out, 'the app server looks for the image in the output directory');
  let r = await c.compile('projects/p1');
  eq(r.body.ok, true, 'the typeset succeeds');
  await until(() => fs.existsSync(json), 'the sidecar appears');
  const side = JSON.parse(fs.readFileSync(json, 'utf8'));
  eq([side.w, side.h], [12, 17], "the sidecar's size is the image's own");
  check(fs.readFileSync(jpg).equals(TINY_JPEG), 'the rendered image is in place');
  eq(side.v, crypto.createHash('sha256').update(TINY_JPEG).digest('hex').slice(0, 16), 'v is the leading 16 hex digits of the SHA-256');
  eq(side.v, thumbVersion(fs.readFileSync(jpg)), 'the app server derives the same v from the bytes');
  eq(await readThumbMeta(dir, 'main.tex'), { w: 12, h: 17, v: side.v }, 'the app server reads the sidecar the compiler wrote');
  let calls = gsCalls();
  eq(calls.length, 2, 'one size probe, one render');
  for (const call of calls) check(call.args.includes('-dSAFER'), `every gs call runs under -dSAFER: ${call.args.join(' ')}`);
  check(calls.every((call) => call.args.includes('-dFirstPage=1') && call.args.includes('-dLastPage=1')), 'only page 1 is read');
  const render = calls[1].args;
  check(render.includes('-sDEVICE=jpeg'), 'the render writes a JPEG');
  const dpi = Number(render.find((a) => a.startsWith('-r')).slice(2));
  check(Math.abs((595.276 * dpi) / 72 - 512) < 1, `the resolution makes the page 512px wide (dpi ${dpi})`);
  eq(fs.realpathSync(calls[1].cwd), out, 'gs runs in the output directory');
  check(render.includes('./main.pdf') && render.includes('-sOutputFile=./.main.thumb.tmp.jpg'), 'gs gets relative, dot-prefixed names');
  eq(leftovers(out), [], 'no temporary file is left');

  // ---- an unchanged PDF is not rendered again ----
  setMode('latexmk', 'noop');
  r = await c.compile('projects/p1');
  eq(r.body.ok, true, 'an up-to-date typeset succeeds');
  await sleep(400);
  eq(gsCalls().length, 2, 'an unchanged PDF is not rendered again');

  // ---- a failed typeset keeps the previous thumbnail ----
  const before = { jpg: read(jpg), json: read(json) };
  setMode('latexmk', 'fail');
  r = await c.compile('projects/p1');
  eq(r.body.ok, false, 'the typeset fails');
  await sleep(400);
  eq(gsCalls().length, 2, 'a failed typeset renders nothing');
  check(read(jpg)?.equals(before.jpg) && read(json)?.equals(before.json), 'and the previous thumbnail stays');

  // ---- a typeset that logged errors but wrote a fresh PDF is rendered, as the PDF pane shows it ----
  setMode('latexmk', 'errors');
  writePdf('with-errors');
  r = await c.compile('projects/p1');
  eq(r.body.ok, false, 'the typeset reports its errors');
  eq(r.body.pdfFresh, true, 'and wrote a fresh PDF');
  await until(() => gsCalls().length > 2 && !read(json)?.equals(before.json), 'the fresh PDF is rendered');

  // ---- a renderer that fails leaves no thumbnail, and the typeset is unaffected ----
  setMode('latexmk', 'ok');
  setMode('gs', 'fail');
  writePdf('two');
  r = await c.compile('projects/p1');
  eq(r.body.ok, true, 'the typeset succeeds although the render will fail');
  eq(r.body.errors.filter((e) => e.type === 'error'), [], 'a render failure is not a typeset error');
  await until(() => !fs.existsSync(json) && !fs.existsSync(jpg), 'a failed render removes the thumbnail');
  eq(leftovers(out), [], 'and leaves no temporary file');

  // ---- a renderer that hangs is killed at the timeout; the typeset never waits ----
  setMode('gs', 'hang');
  fs.rmSync(path.join(modes, 'gs-pid'), { force: true });
  writePdf('three');
  r = await c.compile('projects/p1');
  eq(r.body.ok, true, 'the typeset succeeds');
  check(r.ms < 1000, `the typeset answers before the render finishes (${r.ms} ms)`);
  await until(() => fs.existsSync(path.join(modes, 'gs-pid')), 'the hanging render starts');
  const hung = Number(fs.readFileSync(path.join(modes, 'gs-pid'), 'utf8'));
  await until(() => !alive(hung), 'the hanging renderer is killed at THUMBNAIL_TIMEOUT_MS', 5000);
  await sleep(100);
  check(!fs.existsSync(json) && !fs.existsSync(jpg), 'a timed-out render leaves no thumbnail');
  eq(leftovers(out), [], 'and no temporary file');

  // ---- a typeset that starts while a render hangs stops it ----
  fs.rmSync(path.join(modes, 'gs-pid'), { force: true });
  writePdf('four');
  r = await c.compile('projects/p1');
  await until(() => fs.existsSync(path.join(modes, 'gs-pid')), 'the next hanging render starts');
  const second = Number(fs.readFileSync(path.join(modes, 'gs-pid'), 'utf8'));
  setMode('gs', 'ok');
  writePdf('five');
  r = await c.compile('projects/p1');
  eq(r.body.ok, true, 'the next typeset succeeds');
  check(r.ms < 1000, `it did not wait for the hanging render (${r.ms} ms)`);
  check(!alive(second), 'the hanging render was stopped when the typeset started');
  await until(() => fs.existsSync(json), "the new typeset's thumbnail appears");
  eq(leftovers(out), [], 'no temporary file is left');

  // ---- a root file in a subdirectory ----
  const sub = project('p2', { 'paper/main.tex': '\\documentclass{article}\\begin{document}x\\end{document}\n' });
  r = await c.compile('projects/p2', 'paper/main.tex');
  eq(r.body.ok, true, 'a subdirectory root typesets');
  const subJson = path.join(sub, thumbFiles('paper/main.tex').json);
  eq(path.relative(sub, subJson), path.join('paper', '.aldine-out', '.main.thumb.json'), 'beside the root file');
  await until(() => fs.existsSync(subJson), "the subdirectory root's sidecar appears");
  check(fs.existsSync(path.join(sub, thumbFiles('paper/main.tex').jpg)), 'and its image');

  // ---- what is not a PDF never reaches the renderer ----
  project('p3');
  fs.writeFileSync(pdfFile, '%!PS\n(owned) print\n');
  const callsBefore = gsCalls().length;
  r = await c.compile('projects/p3');
  eq(r.body.ok, true, 'the typeset itself succeeds');
  await sleep(400);
  eq(gsCalls().length, callsBefore, 'a file without a PDF header is not handed to gs');
  check(!fs.existsSync(path.join(dataDir, 'projects', 'p3', thumbFiles('main.tex').json)), 'and has no thumbnail');
  writePdf('six');

  // ---- no renderer: typesetting works, there is no thumbnail ----
  const bare = await startCompiler([binNoGs]);
  eq((await bare.health()).thumbnails, 'none', 'without gs or pdftoppm /health says none');
  project('p4');
  r = await bare.compile('projects/p4');
  eq(r.body.ok, true, 'a compiler without a renderer typesets');
  await sleep(400);
  check(!fs.existsSync(path.join(dataDir, 'projects', 'p4', thumbFiles('main.tex').json)), 'and writes no thumbnail');

  const off = await startCompiler([bin], { ALDINE_THUMBNAILS: '0' });
  eq((await off.health()).thumbnails, 'none', 'ALDINE_THUMBNAILS=0 turns rendering off');
  project('p5');
  const offCalls = gsCalls().length;
  r = await off.compile('projects/p5');
  eq(r.body.ok, true, 'it typesets');
  await sleep(400);
  eq(gsCalls().length, offCalls, 'and never runs gs');

  // ---- the real renderer, when this host has one ----
  const has = (cmd, arg) => spawnSync(cmd, [arg], { stdio: 'ignore' }).status === 0;
  const real = has('gs', '--version') ? 'gs' : has('pdftoppm', '-v') ? 'pdftoppm' : null;
  if (!real) {
    console.log('  (no gs or pdftoppm on this host: the real-renderer checks are skipped)');
  } else {
    const thumbnail = createRequire(import.meta.url)('../../compiler/thumbnail.js');
    eq(await thumbnail.probe(), real, `the module finds ${real}`);
    const realDir = path.join(tmp, 'real');
    const realOut = path.join(realDir, '.aldine-out');
    fs.mkdirSync(realOut, { recursive: true });
    const shapes = {
      a4: [minimalPdf({ pages: 2 }), 512, 724],
      letter: [minimalPdf({ w: 612, h: 792 }), 512, 663],
      slides: [minimalPdf({ w: 362.83, h: 272.13 }), 512, 384],
      rotated: [minimalPdf({ w: 612, h: 792, rotate: 90 }), 512, 396],
      strip: [minimalPdf({ w: 100, h: 1000 }), 154, 1536],
    };
    for (const [name, [bytes]] of Object.entries(shapes)) {
      fs.writeFileSync(path.join(realOut, `${name}.pdf`), bytes);
      thumbnail.schedule(realOut, name);
    }
    await sleep(50);
    await thumbnail.idle();
    for (const [name, [, w, h]] of Object.entries(shapes)) {
      const s = await readThumbMeta(realDir, `${name}.tex`);
      check(!!s, `${real} rendered ${name}`);
      if (!s) continue;
      check(Math.abs(s.w - w) <= 2 && Math.abs(s.h - h) <= 3, `${real}: ${name} is about ${w}x${h} (got ${s.w}x${s.h})`);
      const img = fs.readFileSync(path.join(realDir, thumbFiles(`${name}.tex`).jpg));
      eq(thumbnail.jpegSize(img), { w: s.w, h: s.h }, `${name}: the sidecar matches the JPEG`);
      eq(s.v, thumbVersion(img), `${name}: v matches the bytes`);
    }
  }
} finally {
  for (const child of children) child.kill('SIGKILL');
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('thumbnail-compiler: all assertions passed');
process.exit(0);
