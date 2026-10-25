#!/usr/bin/env node
/**
 * Aldine compile service — zero-dependency Node HTTP server wrapping latexmk.
 *
 * Contract:
 *   POST /compile  { projectDir, rootFile, engine? }  ->
 *     { ok, pdf: <path in OUT_DIR>, log, errors: [{file,line,message,type}], durationMs }
 *   GET  /health   -> { ok: true, texlive: { release: '2026' | 'unknown', scheme: 'full' | 'medium' | 'unknown' },
 *                        thumbnails: 'gs' | 'pdftoppm' | 'none' }
 *   GET  /catalog  -> { ok, generatedAt, classes: [{ id, cls, kind, license, sample }] }
 *
 * The compiler shares the projects volume (read) and an output cache volume
 * (write) with the app server, so no file transfer is needed.
 * Security: restricted shell-escape (whitelist only), no latexmk rc file, no
 * symbolic link out of the project, nonstopmode, wall-clock timeout, output
 * confined to OUT_DIR/<hash>.
 * After a successful typeset, page 1 is rendered beside the PDF in the
 * background (thumbnail.js).
 */
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getCatalog } = require('./catalog.js');
const preamble = require('./preamble.js');
const thumbnail = require('./thumbnail.js');

const PORT = process.env.PORT ? Number(process.env.PORT) : 4020;
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../../.data');
const TIMEOUT_MS = Number(process.env.COMPILE_TIMEOUT_MS || 120_000);
// Aux/PDF output lives inside the project tree (relative path) so TeX path
// restrictions (openout_any=p) never apply and incremental caches persist.
const OUT_SUBDIR = '.aldine-out';
// What TeX and the bibliography packages print when a pass left references,
// citations or the bibliography behind the source: a draft run then owes a full one.
const DRAFT_RERUN_HINT = /Rerun to get|Label\(s\) may have changed|Please \(?re\)?run (Biber|BibTeX)|rerun LaTeX/i;
// The Dockerfile writes the build arg TEXLIVE_SCHEME here; a checkout running
// server.js directly has no such file and reports "unknown".
const SCHEME_FILE = process.env.TEXLIVE_SCHEME_FILE || path.join(__dirname, 'texlive-scheme');

const LOG_MAX = 200_000;
const LOG_HEAD = 20_000;

/**
 * The log as the app keeps it. The head names the engine, the format and the
 * packages loaded; the tail has the last error and the page count. A log
 * over LOG_MAX loses its middle, cut at line ends.
 */
function clipLog(log) {
  if (log.length <= LOG_MAX) return log;
  const headEnd = log.lastIndexOf('\n', LOG_HEAD);
  const head = log.slice(0, headEnd > 0 ? headEnd : LOG_HEAD);
  const tailStart = log.indexOf('\n', log.length - (LOG_MAX - LOG_HEAD));
  const tail = log.slice(tailStart >= 0 ? tailStart + 1 : log.length - (LOG_MAX - LOG_HEAD));
  const cut = log.length - head.length - tail.length;
  return `${head}\n[… ${Math.ceil(cut / 1000)} KB of the log left out …]\n${tail}`;
}

function json(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': buf.length });
  res.end(buf);
}

/**
 * The "l.<n> <source>" line TeX prints after an error, split at the point it
 * stopped reading: the first half ends with the offending token, the second
 * half is indented to that column. Rejoined they are the source line, and
 * the token is the last control sequence of the first half — the one an
 * "Undefined control sequence." never names itself.
 */
function errorContext(lines, i) {
  for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
    const m = lines[j].match(/^l\.(\d+)(?:\s(.*))?$/);
    if (!m) continue;
    const head = (m[2] || '').replace(/\s+$/, '');
    // ^^M is TeX's end-of-line marker, not source text
    const tail = (lines[j + 1] || '').trim().replace(/\^\^M$/, '');
    const token = (head.match(/(\\[A-Za-z@]+|\\[^A-Za-z@\s])\s*$/) || [])[1] || null;
    return { line: Number(m[1]), context: (head + tail).trim() || null, token };
  }
  return { line: null, context: null, token: null };
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
      const ctx = errorContext(lines, i);
      if (ctx.token && /^Undefined control sequence/.test(message) && !message.includes(' — ')) message += ` — ${ctx.token}`;
      errors.push({ type: 'error', file: fle[1], line: Number(fle[2]), message, ...(ctx.context ? { context: ctx.context } : {}) });
      continue;
    }
    // ! LaTeX Error / ! Undefined control sequence, followed by l.<n>
    if (line.startsWith('!')) {
      let message = line.replace(/^!\s*/, '');
      const ctx = errorContext(lines, i);
      if (ctx.token && /^Undefined control sequence/.test(message)) message += ` — ${ctx.token}`;
      errors.push({ type: 'error', line: ctx.line, message, ...(ctx.context ? { context: ctx.context } : {}) });
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

/**
 * Parse the bibliography log (.blg, written by both bibtex and biber) for
 * errors. They never reach the LaTeX log: a malformed .bib entry makes bibtex
 * write no .bbl at all, and the LaTeX log then shows only the fallout — one
 * "Citation undefined" warning per citation, hundreds of them, none of which
 * names the file and line to fix. bibtex's own `Warning--` lines are the noise
 * the user cannot act on and stay out.
 */
function parseBibLog(log) {
  const errors = [];
  for (const line of log.split('\n')) {
    // bibtex: "I was expecting a `,' or a `}'---line 42 of file refs.bib".
    // A `Warning--` continuation is "--line N of file X" (two dashes) and so
    // does not match.
    const located = line.match(/^(.*\S)---line (\d+) of file (\S+)/);
    if (located) {
      errors.push({ type: 'error', file: located[3], line: Number(located[2]), message: `BibTeX: ${located[1].trim()}` });
      continue;
    }
    // bibtex failures with no place to point at: a missing .bst or .bib file.
    if (/^(I couldn't open|Sorry---you)/.test(line)) {
      errors.push({ type: 'error', line: null, message: `BibTeX: ${line.trim()}` });
      continue;
    }
    // biber: "[0] ... ERROR - Cannot find 'refs.bib'!"
    const biber = line.match(/\b(ERROR|WARN) - (.*\S)/);
    if (biber) {
      // biber reads a re-encoded copy of each .bib and names that copy:
      // "BibTeX subsystem: /tmp/biber_tmp_X/refs.bib_123.utf8, line 16,
      // warning: undefined macro "June"". The copy's name is the .bib's name
      // (folder dropped) and the line is the .bib's own.
      const at = biber[2].match(/(?:^|[\/\\\s])([^\/\\\s]+\.bib)\S*, line (\d+)/);
      errors.push({ type: biber[1] === 'ERROR' ? 'error' : 'warning', ...(at ? { file: at[1], line: Number(at[2]) } : { line: null }), message: `Biber: ${biber[2].trim()}` });
    }
  }
  return errors;
}

/**
 * Whether the engine got past the preamble: TeX logs every \openout, and the
 * first one (the .aux) happens at \begin{document}. A run that died before
 * it rewrote no .bcf/.aux, so the bibliography tool did not run for it and
 * whatever the .blg holds is a previous run's.
 */
function documentBodyReached(log) {
  return /^\\openout\d+ = /m.test(log);
}

/**
 * latexmk's own reason for failing, for a run whose logs parse to no error at
 * all — a missing input file, an engine that would not start. Without it the
 * UI can only say "typesetting failed" and leave the user nothing to act on.
 */
function latexmkFailure(out) {
  const at = out.lastIndexOf('Collected error summary');
  if (at < 0) return [];
  const items = [];
  for (const line of out.slice(at).split('\n').slice(1)) {
    if (!/^\s+\S/.test(line)) break;
    const text = line.trim();
    if (!text.startsWith('Refer to')) items.push(text);
  }
  return items.map((message) => ({ type: 'error', line: null, message: `Typesetting failed: ${message}` }));
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

/**
 * TeX Live release and scheme, resolved once at startup. The release comes
 * from kpsewhich (the TEXMFDIST path carries the year), falling back to tlmgr;
 * the scheme from SCHEME_FILE. Neither is worth failing startup over: a host
 * without TeX Live still answers /health, just with "unknown".
 */
const texlive = { release: 'unknown', scheme: 'unknown' };
async function probeTexLive() {
  try {
    const scheme = fs.readFileSync(SCHEME_FILE, 'utf8').trim();
    if (/^[a-z]+$/.test(scheme)) texlive.scheme = scheme;
  } catch { /* not built from the Dockerfile */ }
  const year = (text) => (text.match(/\b(20\d\d)\b/) || [])[1];
  const dist = await run('kpsewhich', ['-var-value=TEXMFDIST'], {}, 10_000);
  let release = dist.code === 0 ? year(dist.out) : undefined;
  if (!release) {
    const tl = await run('tlmgr', ['--version'], {}, 10_000);
    release = tl.code === 0 ? year(tl.out) : undefined;
  }
  if (release) texlive.release = release;
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

/**
 * A root file is a relative path inside the project. A segment starting with
 * "-" is refused because the name ends up on a latexmk command line, and
 * latexmk reads "-pdflatex=<program>" as an option that runs <program>: with
 * it, whoever can name the main document runs commands in this container.
 * The "./" prefix in mkArgs is the second lock on the same door.
 */
function invalidRootFile(rootFile) {
  if (typeof rootFile !== 'string' || !rootFile) return true;
  if (rootFile.includes('..') || path.isAbsolute(rootFile)) return true;
  return rootFile.split(/[\\/]/).some((seg) => seg.startsWith('-'));
}

/**
 * The first symbolic link under `absDir` (project-relative) that does not
 * resolve to a path inside it, a dangling one included, or null. openin_any
 * and openout_any judge the name TeX was given, and every open follows
 * links, so a link is how a name inside the project would reach a file
 * outside it. `.git` belongs to git: it is not walked, and a link into it
 * counts as outside. openout_any refuses the name `.git/config`, but not a
 * write through `x.tex -> .git/config`, and the app server's next git command
 * runs what that config names.
 */
function linkOutOfProject(absDir) {
  const root = fs.realpathSync(absDir);
  const gitDir = path.join(root, '.git');
  const under = (p, dir) => p === dir || p.startsWith(dir + path.sep);
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        let target = null;
        try { target = fs.realpathSync(abs); } catch { /* dangling: a write through it creates its target */ }
        if (target === null || !under(target, root) || under(target, gitDir)) return path.relative(root, abs);
      } else if (e.isDirectory() && e.name !== '.git') {
        const hit = walk(abs);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(root);
}

async function compileInner(body) {
  const { projectDir, rootFile = 'main.tex', engine = 'pdf', haltOnError = false, draft = false } = body;
  if (!projectDir || projectDir.includes('..')) throw new Error('invalid projectDir');
  if (invalidRootFile(rootFile)) throw new Error('invalid rootFile');
  const absDir = path.resolve(DATA_DIR, projectDir);
  if (!absDir.startsWith(path.resolve(DATA_DIR))) throw new Error('projectDir escapes DATA_DIR');
  if (!fs.existsSync(path.join(absDir, rootFile))) throw new Error(`root file not found: ${rootFile}`);
  // Before anything is written: the output directory itself may be a link.
  const outside = linkOutOfProject(absDir);
  if (outside) throw new Error(`Cannot typeset: ${outside} is a symbolic link to a path outside the project. Delete it from the project's repository and pull, then typeset again.`);

  // Root file may live in a subdirectory (e.g. paper/main.tex). -cd makes latexmk
  // chdir into that dir first, so \input{chapters/…}, \includegraphics, and bib
  // resolve relative to the main file — exactly like a local/Overleaf build. The
  // output dir is then relative to that subdir too.
  const rootDir = path.dirname(rootFile); // '.' when the root is top-level
  fs.mkdirSync(path.join(absDir, rootDir, OUT_SUBDIR), { recursive: true });

  const engineFlag = engine === 'xelatex' ? '-pdfxe' : engine === 'lualatex' ? '-pdflua' : '-pdf';
  const mkArgs = (force, withFormat = usingFormat) => [
    // No rc file is read: not the system's or the user's, and not the
    // project's latexmkrc/.latexmkrc. An rc file is Perl that runs with this
    // service's own rights, outside shell_escape, openin_any and openout_any,
    // which bind TeX only. Every setting comes from this command line.
    '-norc',
    engineFlag,
    ...(force ? ['-g'] : []), // -g: run even if latexmk thinks it's up-to-date
    // Draft: one engine pass on the previous run's .aux/.bbl, no biber/bibtex.
    // latexmk's fdb still records what is out of date, so the next full run
    // picks up the reruns and the bibliography this one skipped.
    ...(draft ? ['-e', '$max_repeat=1; $bibtex_use=0;'] : []),
    '-interaction=nonstopmode',
    // Without -halt-on-error TeX runs to the end of the document and latexmk
    // still exits non-zero when errors occurred, so the caller gets a complete
    // PDF plus the error list (the default). With it, the run stops at the
    // first error and the PDF on disk is truncated at that page.
    //
    // -f is the other half of running to completion, and only nonstopmode
    // without it looks like it works: latexmk gives up after the pass that
    // errored ("Errors, so I did not complete making targets"), so bibtex and
    // the reruns that resolve citations and cross-references never happen. A
    // paper with one bad macro then renders every \cite as [?] and every
    // \ref as ??. latexmk still exits non-zero, so `ok` stays false.
    ...(haltOnError ? ['-halt-on-error'] : ['-f']),
    '-file-line-error',
    // no -no-shell-escape: the image sets texmf shell_escape=p (restricted),
    // so only whitelisted programs (epstopdf, kpsewhich, bibtex, …) run.
    '-synctex=1',
    '-cd', // chdir to the root file's directory before compiling
    `-outdir=${OUT_SUBDIR}`,
    ...(withFormat ? pre.args : []),
    `./${rootFile}`, // never bare: a name starting with "-" must stay a file, not an option
  ];
  // Case-insensitive: the root picker accepts MAIN.TEX, and latexmk writes
  // MAIN.pdf for it; stripping only ".tex" would look for MAIN.TEX.pdf.
  const base = path.basename(rootFile).replace(/\.tex$/i, '');
  const rel = (f) => path.join(rootDir, OUT_SUBDIR, f); // path relative to the project dir
  const outAbs = path.join(absDir, rootDir, OUT_SUBDIR);
  const pdfPath = path.join(outAbs, `${base}.pdf`);
  const logPath = path.join(outAbs, `${base}.log`);
  const readLog = (fallback) => { try { return fs.readFileSync(logPath, 'utf8'); } catch { return fallback; } };

  // First pass without -g: latexmk skips work that is already up to date, so an
  // unchanged document "recompiles" in ~a second instead of a full rebuild.
  const pre = await preamble.prepare({ projectRoot: absDir, cwd: path.join(absDir, rootDir), outAbs, base, rootPath: path.join(absDir, rootFile), engine });
  let usingFormat = pre.use;
  const optsFor = (withFormat) => ({ cwd: absDir, detached: true, env: { ...process.env, HOME: process.env.HOME || '/tmp', max_print_line: '10000', ...(withFormat ? pre.env : {}) } });
  let runOpts = optsFor(usingFormat);
  // Freshness reference on the SAME filesystem clock as the outputs: a file
  // touched now. Comparing output mtimes against Date.now() needs slack for
  // coarse or skewed clocks, and that slack lets a run started right after
  // the last one mistake an untouched PDF for its own output.
  const sentinel = path.join(outAbs, '.aldine-run');
  fs.writeFileSync(sentinel, '');
  const freshSince = fs.statSync(sentinel).mtimeMs;
  // A draft's single pass leaves latexmk's fdb believing the files settled, so
  // the full run after one must force the cycle or it keeps the draft's ??.
  const draftMark = path.join(outAbs, '.aldine-draft');
  const afterDraft = !draft && fs.existsSync(draftMark);
  // The previous run's thumbnail render reads the PDF this run rewrites.
  await thumbnail.cancel(outAbs);
  const t0 = Date.now();
  let { code, out, timedOut } = await run('latexmk', mkArgs(afterDraft), runOpts, TIMEOUT_MS);
  if (code === 0 && !timedOut && !fs.existsSync(pdfPath)) {
    // latexmk believed everything was current but the PDF is gone (cleaned
    // output dir / stale state) — force a real rebuild.
    ({ code, out, timedOut } = await run('latexmk', mkArgs(true), runOpts, TIMEOUT_MS));
  }
  // Stale-aux recovery: if the package set changed (e.g. dropping biblatex),
  // leftover .aux/.bcf artifacts make an otherwise-valid document fail with an
  // undefined-control-sequence in the .aux (\abx@aux@…, \bibcite, …). Wipe the
  // regenerable aux files once and rebuild — the .aux is not source of truth.
  // The bare word "undefined" and a mention of the .aux are in nearly every
  // failing log; only an error located in the .aux/.bcf next to one of its own
  // macros is the stale-artifact case. Otherwise every failing compile would
  // pay a second full -g build (each invocation is a complete multi-pass run
  // under -f).
  const staleAux = (l) => /\.(aux|bcf):\d+:/i.test(l) && /(\\abx@aux@|\\bibcite|\\@writefile)/.test(l);
  if (code !== 0 && !timedOut && staleAux(readLog(out))) {
    for (const ext of ['aux', 'bcf', 'bbl', 'blg', 'run.xml', 'toc', 'out', 'fls', 'fdb_latexmk']) {
      try { fs.rmSync(path.join(outAbs, `${base}.${ext}`), { force: true }); } catch { /* best effort */ }
    }
    ({ code, out, timedOut } = await run('latexmk', mkArgs(true), runOpts, TIMEOUT_MS));
  }
  // A run on a format nobody has vouched for yet that fails gets the plain
  // run: if that one succeeds, the format is what broke the document.
  const capped = (o) => draft && /Maximum runs of \S+ reached/i.test(o);
  let preambleCache = pre.status;
  if (usingFormat) {
    const formatOk = code === 0 || capped(out);
    if (!formatOk && !timedOut && !pre.manifest.verified) {
      usingFormat = false;
      runOpts = optsFor(false);
      ({ code, out, timedOut } = await run('latexmk', mkArgs(true), runOpts, TIMEOUT_MS));
      const plainOk = code === 0 || capped(out);
      preamble.settle(pre, { formatOk, plainOk });
      preambleCache = 'fallback';
    } else {
      preamble.settle(pre, { formatOk, plainOk: false });
    }
  }
  const durationMs = Date.now() - t0;
  let log = readLog(out);
  // A previous run's outputs stay on disk when this run fails, so existence
  // alone says nothing about which run wrote them. "Fresh" = written by this
  // run: mtime at or after the sentinel's (same clock, second granularity at
  // worst, and a write in the sentinel's own second still counts).
  const isFresh = (f) => { try { return fs.statSync(f).mtimeMs >= freshSince; } catch { return false; } };
  const bibLogPath = path.join(outAbs, `${base}.blg`);
  const errors = parseLog(log);
  // This run's .blg, or an older one that latexmk still holds against the
  // document: latexmk does not re-run bibtex/biber until the .bib changes, and
  // until then reports "gave an error in previous invocation", whose located
  // errors are the ones in that older .blg. A stale .blg from a .bib the user
  // already fixed cannot reach here, because fixing the .bib re-runs the rule.
  // A run that died in the preamble never reached the bibliography step, so
  // the .blg on disk — whatever its mtime says on a coarse-clock volume — is
  // not this run's.
  const bibRuleFailed = /\b(bibtex|biber)\b[^\n]*gave an error/i.test(out);
  if (documentBodyReached(log) && (isFresh(bibLogPath) || bibRuleFailed)) {
    try { errors.push(...parseBibLog(fs.readFileSync(bibLogPath, 'utf8'))); } catch { /* unreadable is not an error */ }
  }
  // -file-line-error paths are relative to the compile dir (the root file's
  // dir, thanks to -cd) — reduce in-project ones to project-relative paths so
  // the editor's error links and the AI-fix prompt name files the way the rest
  // of the app does. Installed .sty/.cls files stay as reported.
  for (const e of errors) {
    if (typeof e.file !== 'string' || !e.file) continue;
    const abs = path.resolve(absDir, rootDir, e.file);
    if (abs === absDir || abs.startsWith(absDir + path.sep)) e.file = path.relative(absDir, abs);
    // An error inside a generated file (the .bbl bibtex just wrote, an .aux)
    // has a real line number in a file the user cannot open or fix. Say which
    // file it was and drop the link, so the row explains the fallout while the
    // .bib error above it stays the one to click.
    if (e.file.split(path.sep).includes(OUT_SUBDIR)) {
      e.message = `${path.basename(e.file)} (generated)${e.line != null ? ` line ${e.line}` : ''}: ${e.message}`;
      e.file = null;
      e.line = null;
    }
  }
  // One broken .bib entry makes every pass report the same generated-file error;
  // identical rows tell the user nothing the first one did not.
  const seen = new Set();
  const deduped = errors.filter((e) => {
    const key = `${e.type}\u0000${e.file ?? ''}\u0000${e.line ?? ''}\u0000${e.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  errors.length = 0;
  errors.push(...deduped);
  // A draft that stopped at its one pass exits non-zero with "Maximum runs"
  // although TeX itself succeeded; that is the draft working, not an error.
  const draftCapped = draft && /Maximum runs of \S+ reached/i.test(out) && !errors.some((e) => e.type === 'error');
  const ok = (code === 0 || draftCapped) && fs.existsSync(pdfPath);
  const needsFullRun = draft && ok && (draftCapped || (isFresh(logPath) && DRAFT_RERUN_HINT.test(log)));
  if (needsFullRun) fs.writeFileSync(draftMark, '');
  else if (!draft && ok) fs.rmSync(draftMark, { force: true });
  // Never report a failure the user cannot read: a run that fails with nothing
  // in either log falls back to latexmk's own summary.
  if (!ok && !timedOut && !errors.some((e) => e.type === 'error')) errors.push(...latexmkFailure(out));
  if (!usingFormat && pre.status === 'miss' && !timedOut && documentBodyReached(log)) preamble.scheduleBuild(pre);
  // The thumbnail follows the PDF pane: a run that went to the end of the
  // document and wrote a fresh PDF is shown even when it logged errors, so it
  // is rendered too. A run that halted, timed out or wrote nothing keeps the
  // previous image.
  const complete = ok || (!haltOnError && !timedOut && isFresh(pdfPath) && !/no output PDF file produced|No pages of output/i.test(log));
  if (complete) thumbnail.schedule(outAbs, base);
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
    log: clipLog(log),
    latexmkOutput: out.length > 20_000 ? out.slice(-20_000) : out,
    errors,
    durationMs,
    preambleCache,
    ...(draft ? { draft: true, needsFullRun } : {}),
  };
}

/** SyncTeX forward (code->pdf) and inverse (pdf->code) lookups. */
async function synctex(body) {
  const { projectDir, rootFile = 'main.tex', direction, line, column = 0, page, x, y } = body;
  if (!projectDir || projectDir.includes('..')) throw new Error('invalid projectDir');
  if (invalidRootFile(rootFile)) throw new Error('invalid rootFile');
  const absDir = path.resolve(DATA_DIR, projectDir);
  if (!absDir.startsWith(path.resolve(DATA_DIR))) throw new Error('projectDir escapes DATA_DIR');
  const rootDir = path.dirname(rootFile);
  const base = path.basename(rootFile).replace(/\.tex$/i, '');
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
  if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true, texlive, thumbnails: thumbnail.rendererName() });
  if (req.method === 'GET' && (req.url === '/catalog' || req.url.startsWith('/catalog?'))) {
    return getCatalog().then((c) => json(res, 200, c), (err) => json(res, 500, { ok: false, error: String(err && err.message || err) }));
  }

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

// The log parsers are pure and worth testing without a TeX Live image; the
// server only starts when this file is run directly (the image's CMD).
module.exports = { parseLog, parseBibLog, latexmkFailure, invalidRootFile, documentBodyReached, clipLog, preambleIdle: preamble.idle, thumbnailsIdle: thumbnail.idle };

if (require.main === module) {
  Promise.allSettled([probeTexLive(), thumbnail.probe()]).then(() => {
    server.listen(PORT, () => console.log(`[compiler] listening on :${PORT}, data=${DATA_DIR}, texlive=${texlive.release} (${texlive.scheme}), thumbnails=${thumbnail.rendererName()}`));
  });
}
