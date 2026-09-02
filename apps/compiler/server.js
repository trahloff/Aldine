#!/usr/bin/env node
/**
 * Aldine compile service — zero-dependency Node HTTP server wrapping latexmk.
 *
 * Contract:
 *   POST /compile  { projectDir, rootFile, engine? }  ->
 *     { ok, pdf: <path in OUT_DIR>, log, errors: [{file,line,message,type}], durationMs }
 *   GET  /health   -> { ok: true }
 *
 * The compiler shares the projects volume (read) and an output cache volume
 * (write) with the app server, so no file transfer is needed.
 * Security: restricted shell-escape (whitelist only), nonstopmode, wall-clock
 * timeout, output confined to OUT_DIR/<hash>.
 */
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT ? Number(process.env.PORT) : 4020;
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../../.data');
const TIMEOUT_MS = Number(process.env.COMPILE_TIMEOUT_MS || 120_000);
// Aux/PDF output lives inside the project tree (relative path) so TeX path
// restrictions (openout_any=p) never apply and incremental caches persist.
const OUT_SUBDIR = '.aldine-out';

function json(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': buf.length });
  res.end(buf);
}

/** Parse LaTeX log for errors/warnings with file/line where possible. */
function parseLog(log) {
  const errors = [];
  const lines = log.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // -file-line-error format: ./main.tex:31: Undefined control sequence.
    const fle = line.match(/^(?:\.\/)?([^:\s][^:]*\.\w+):(\d+):\s*(.*)$/);
    if (fle && !/^\d+$/.test(fle[1]) && !fle[3].startsWith('==>')) {
      let message = fle[3] || 'LaTeX error';
      // the offending token often follows on the next lines (e.g. "\thisisnotacommand")
      const next = (lines[i + 1] || '').trim();
      if (message && next.startsWith('\\') && !next.startsWith('\\l.')) message += ` — ${next}`;
      errors.push({ type: 'error', file: fle[1], line: Number(fle[2]), message });
      continue;
    }
    // ! LaTeX Error / ! Undefined control sequence, followed by l.<n>
    if (line.startsWith('!')) {
      let message = line.replace(/^!\s*/, '');
      let lineNo = null;
      for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
        const m = lines[j].match(/^l\.(\d+)/);
        if (m) { lineNo = Number(m[1]); break; }
      }
      errors.push({ type: 'error', line: lineNo, message });
    } else if (/^(LaTeX|Package|Class) .*Warning/.test(line)) {
      let message = line;
      const m = line.match(/on input line (\d+)/) || (lines[i + 1] || '').match(/on input line (\d+)/);
      errors.push({ type: 'warning', line: m ? Number(m[1]) : null, message: message.trim() });
    } else if (/^Underfull|^Overfull/.test(line)) {
      const m = line.match(/at lines (\d+)/);
      errors.push({ type: 'typesetting', line: m ? Number(m[1]) : null, message: line.trim() });
    }
  }
  return errors;
}

function run(cmd, args, opts, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts });
    // Decode via StringDecoder so a multibyte UTF-8 char split across two chunk
    // boundaries (accented names, UTF-8 paths in biber output) isn't mangled.
    const decoder = new (require('string_decoder').StringDecoder)('utf8');
    let out = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += decoder.write(d); });
    child.stderr.on('data', (d) => { out += decoder.write(d); });
    child.on('close', (code) => {
      clearTimeout(timer);
      out += decoder.end();
      resolve({ code: timedOut ? -1 : code, out, timedOut });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -2, out: String(err), timedOut: false });
    });
  });
}

// Bound concurrent latexmk runs so a burst can't OOM the container.
let running = 0;
const waiters = [];
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_COMPILES || 2);
async function acquire() {
  if (running >= MAX_CONCURRENT) await new Promise((r) => waiters.push(r));
  running++;
}
function release() {
  running--;
  const next = waiters.shift();
  if (next) next();
}

async function compile(body) {
  await acquire();
  try {
    return await compileInner(body);
  } finally {
    release();
  }
}

async function compileInner(body) {
  const { projectDir, rootFile = 'main.tex', engine = 'pdf', haltOnError = false } = body;
  if (!projectDir || projectDir.includes('..')) throw new Error('invalid projectDir');
  if (rootFile.includes('..') || path.isAbsolute(rootFile)) throw new Error('invalid rootFile');
  const absDir = path.resolve(DATA_DIR, projectDir);
  if (!absDir.startsWith(path.resolve(DATA_DIR))) throw new Error('projectDir escapes DATA_DIR');
  if (!fs.existsSync(path.join(absDir, rootFile))) throw new Error(`root file not found: ${rootFile}`);

  // Root file may live in a subdirectory (e.g. paper/main.tex). -cd makes latexmk
  // chdir into that dir first, so \input{chapters/…}, \includegraphics, and bib
  // resolve relative to the main file — exactly like a local/Overleaf build. The
  // output dir is then relative to that subdir too.
  const rootDir = path.dirname(rootFile); // '.' when the root is top-level
  fs.mkdirSync(path.join(absDir, rootDir, OUT_SUBDIR), { recursive: true });

  const engineFlag = engine === 'xelatex' ? '-pdfxe' : engine === 'lualatex' ? '-pdflua' : '-pdf';
  const mkArgs = (force) => [
    engineFlag,
    ...(force ? ['-g'] : []), // -g: run even if latexmk thinks it's up-to-date
    '-interaction=nonstopmode',
    // Without -halt-on-error TeX runs to the end of the document and latexmk
    // still exits non-zero when errors occurred, so the caller gets a complete
    // PDF plus the error list (the default). With it, the run stops at the
    // first error and the PDF on disk is truncated at that page.
    ...(haltOnError ? ['-halt-on-error'] : []),
    '-file-line-error',
    // no -no-shell-escape: the image sets texmf shell_escape=p (restricted),
    // so only whitelisted programs (epstopdf, kpsewhich, bibtex, …) run.
    '-synctex=1',
    '-cd', // chdir to the root file's directory before compiling
    `-outdir=${OUT_SUBDIR}`,
    rootFile,
  ];
  const base = path.basename(rootFile).replace(/\.tex$/, '');
  const rel = (f) => path.join(rootDir, OUT_SUBDIR, f); // path relative to the project dir
  const outAbs = path.join(absDir, rootDir, OUT_SUBDIR);
  const pdfPath = path.join(outAbs, `${base}.pdf`);
  const logPath = path.join(outAbs, `${base}.log`);
  const readLog = (fallback) => { try { return fs.readFileSync(logPath, 'utf8'); } catch { return fallback; } };

  // First pass without -g: latexmk skips work that is already up to date, so an
  // unchanged document "recompiles" in ~a second instead of a full rebuild.
  const runOpts = { cwd: absDir, detached: true, env: { ...process.env, HOME: process.env.HOME || '/tmp' } };
  const t0 = Date.now();
  let { code, out, timedOut } = await run('latexmk', mkArgs(false), runOpts, TIMEOUT_MS);
  if (code === 0 && !timedOut && !fs.existsSync(pdfPath)) {
    // latexmk believed everything was current but the PDF is gone (cleaned
    // output dir / stale state) — force a real rebuild.
    ({ code, out, timedOut } = await run('latexmk', mkArgs(true), runOpts, TIMEOUT_MS));
  }
  // Stale-aux recovery: if the package set changed (e.g. dropping biblatex),
  // leftover .aux/.bcf artifacts make an otherwise-valid document fail with an
  // undefined-control-sequence in the .aux (\abx@aux@…, \bibcite, …). Wipe the
  // regenerable aux files once and rebuild — the .aux is not source of truth.
  if (code !== 0 && !timedOut && /(\\abx@aux@|\\bibcite|\\@writefile|undefined)/i.test(readLog(out)) && /\.(aux|bcf)\b/i.test(readLog(out))) {
    for (const ext of ['aux', 'bcf', 'bbl', 'blg', 'run.xml', 'toc', 'out', 'fls', 'fdb_latexmk']) {
      try { fs.rmSync(path.join(outAbs, `${base}.${ext}`), { force: true }); } catch { /* best effort */ }
    }
    ({ code, out, timedOut } = await run('latexmk', mkArgs(true), runOpts, TIMEOUT_MS));
  }
  const durationMs = Date.now() - t0;
  let log = readLog(out);
  const errors = parseLog(log);
  // -file-line-error paths are relative to the compile dir (the root file's
  // dir, thanks to -cd) — reduce in-project ones to project-relative paths so
  // the editor's error links and the AI-fix prompt name files the way the rest
  // of the app does. Installed .sty/.cls files stay as reported.
  for (const e of errors) {
    if (typeof e.file !== 'string' || !e.file) continue;
    const abs = path.resolve(absDir, rootDir, e.file);
    if (abs === absDir || abs.startsWith(absDir + path.sep)) e.file = path.relative(absDir, abs);
  }
  const ok = code === 0 && fs.existsSync(pdfPath);
  // A previous run's PDF/SyncTeX stay on disk when this run fails, so existence
  // alone says nothing about which run wrote them. "Fresh" = written by this
  // run (mtime at or after its start, with slack for coarse filesystem clocks).
  const freshSince = t0 - 2000;
  const isFresh = (f) => { try { return fs.statSync(f).mtimeMs >= freshSince; } catch { return false; } };
  const synctexPath = path.join(absDir, rootDir, OUT_SUBDIR, `${base}.synctex.gz`);
  return {
    ok,
    timedOut,
    exitCode: code,
    // paths relative to the project dir; the app server serves them
    pdf: fs.existsSync(pdfPath) ? rel(`${base}.pdf`) : null,
    pdfFresh: isFresh(pdfPath),
    synctex: fs.existsSync(synctexPath) ? rel(`${base}.synctex.gz`) : null,
    synctexFresh: isFresh(synctexPath),
    log: log.length > 200_000 ? log.slice(-200_000) : log,
    latexmkOutput: out.length > 20_000 ? out.slice(-20_000) : out,
    errors,
    durationMs,
  };
}

/** SyncTeX forward (code->pdf) and inverse (pdf->code) lookups. */
async function synctex(body) {
  const { projectDir, rootFile = 'main.tex', direction, line, column = 0, page, x, y } = body;
  if (!projectDir || projectDir.includes('..')) throw new Error('invalid projectDir');
  if (rootFile.includes('..') || path.isAbsolute(rootFile)) throw new Error('invalid rootFile');
  const absDir = path.resolve(DATA_DIR, projectDir);
  if (!absDir.startsWith(path.resolve(DATA_DIR))) throw new Error('projectDir escapes DATA_DIR');
  const rootDir = path.dirname(rootFile);
  const base = path.basename(rootFile).replace(/\.tex$/, '');
  const pdf = path.join(rootDir, OUT_SUBDIR, `${base}.pdf`);
  let args;
  if (direction === 'forward') {
    // synctex records inputs as TeX opened them — relative to the compile dir
    // (the root file's dir, thanks to latexmk -cd) — while the client names
    // files project-relative. The inverse direction undoes this below; mirror it.
    const input = path.relative(rootDir, body.file || rootFile) || path.basename(rootFile);
    args = ['view', '-i', `${line}:${column}:${input}`, '-o', pdf];
  } else {
    args = ['edit', '-o', `${page}:${x}:${y}:${pdf}`];
  }
  const { out } = await run('synctex', args, { cwd: absDir, detached: true }, 10_000);
  // parse "Page:1" / "x:..." / "Input:..." / "Line:..." records
  const records = [];
  let cur = null;
  for (const l of out.split('\n')) {
    const m = l.match(/^(Page|x|y|h|v|W|H|Input|Line|Column):(.*)$/);
    if (!m) continue;
    if (m[1] === 'Page' || m[1] === 'Input') { if (cur) records.push(cur); cur = {}; }
    if (cur) cur[m[1].toLowerCase()] = isNaN(Number(m[2])) ? m[2].trim() : Number(m[2]);
  }
  if (cur) records.push(cur);
  // Inverse lookups report the input as the compile dir + the path as TeX
  // opened it (e.g. …/paper/./chapters/ch1.tex — latexmk -cd runs in the root
  // file's dir). The un-normalized "/./" defeats suffix matching against
  // project paths, so reduce every in-project input to a clean project-relative
  // path; files outside the project (installed .sty/.cls) stay absolute.
  const compileDir = path.join(absDir, rootDir);
  for (const r of records) {
    if (typeof r.input !== 'string' || !r.input) continue;
    const abs = path.resolve(compileDir, r.input);
    if (abs === absDir || abs.startsWith(absDir + path.sep)) r.input = path.relative(absDir, abs);
  }
  return { ok: true, records };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true });
  if (req.method === 'POST' && (req.url === '/compile' || req.url === '/synctex')) {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', async () => {
      try {
        const body = JSON.parse(raw || '{}');
        const result = req.url === '/compile' ? await compile(body) : await synctex(body);
        json(res, 200, result);
      } catch (err) {
        json(res, 400, { ok: false, error: String(err && err.message || err) });
      }
    });
    return;
  }
  json(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, () => console.log(`[compiler] listening on :${PORT}, data=${DATA_DIR}`));
