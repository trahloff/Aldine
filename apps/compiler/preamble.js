/**
 * Precompiled preamble: the root file's preamble dumped into a TeX format
 * (mylatexformat), so a typeset loads its packages from one memory image
 * instead of reading and executing every .sty on every pass.
 *
 * pdfLaTeX only: XeTeX and LuaTeX cannot dump the OpenType fonts fontspec
 * loads. The format is named after the document (`-jobname=<base>`), because
 * packages that capture \jobname while loading would otherwise write their
 * files under the format's name.
 *
 * A format is used only when it was built from exactly this preamble, these
 * project files read by it (\input macros, a local .cls/.sty) and this TeX
 * installation; anything else is a miss, the run goes ahead without it, and
 * the format is rebuilt in the background for the next run. A format whose
 * first run fails where the plain run succeeds is marked bad for that
 * preamble and never used again until the preamble changes.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENABLED = process.env.ALDINE_PREAMBLE_CACHE !== '0';
const BUILD_TIMEOUT_MS = 60_000;
const BEGIN_DOC = '\\begin{document}';

// Preamble commands whose effect a dumped format cannot carry: write streams
// opened in the preamble (\makeindex, glossaries, nomencl) are closed when the
// format is dumped, so the index or glossary would silently come out empty;
// files written in the preamble (filecontents) would not be rewritten; shell
// and Lua calls would run once at dump time instead of on every typeset.
const UNSAFE = new RegExp([
  String.raw`\\make(index|glossaries|noidxglossaries|nomenclature)\b`,
  String.raw`\\(immediate|openout|newwrite|write18|ShellEscape|directlua|luaexec|tikzexternalize|externaldocument|nobibliography)\b`,
  String.raw`\\begin\{filecontents\*?\}`,
  String.raw`\\(usepackage|RequirePackage)(\[[^\]]*\])?\{[^}]*\b(imakeidx|makeidx|index|multind|splitidx|glossaries|glossaries-extra|nomencl|minted|pythontex|svg|filecontents|bibunits|multibib|chapterbib|xr|xr-hyper|bibentry|currfile|datetime2?|embedfile|attachfile2?|standalone|subfiles|docmute|fontspec|luacode|epstopdf|auto-pst-pdf|pstool)\b`,
].join('|'));

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

function run(cmd, args, opts, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts });
    let out = '';
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -2, out: String(err) }); });
  });
}

/** The installation a format belongs to: a format from another pdfTeX build
 *  or another base format is a fatal error at load, not a slow path. Null when
 *  mylatexformat is not installed (the cache is then off). */
let toolKeyPromise = null;
function toolKey() {
  if (!toolKeyPromise) {
    toolKeyPromise = (async () => {
      const mlf = await run('kpsewhich', ['mylatexformat.ltx'], {}, 10_000);
      if (mlf.code !== 0 || !mlf.out.trim()) return null;
      const version = await run('pdflatex', ['--version'], {}, 10_000);
      const fmt = await run('kpsewhich', ['-engine=pdftex', 'pdflatex.fmt'], {}, 10_000);
      let mtime = '';
      try { mtime = String(fs.statSync(fmt.out.trim()).mtimeMs); } catch { return null; }
      return sha1(`${version.out.split('\n')[0]}\n${fmt.out.trim()}\n${mtime}`);
    })();
  }
  return toolKeyPromise;
}

/** The preamble as the format would read it, or null when this document must
 *  not use a format at all (and the reason). */
function preambleOf(text) {
  if (text.startsWith('%&')) return { preamble: null, reason: 'first-line format directive' };
  const at = text.indexOf(BEGIN_DOC);
  if (at < 0) return { preamble: null, reason: 'no \\begin{document} in the root file' };
  const preamble = text.slice(0, at);
  const code = preamble.split('\n').map((l) => l.replace(/(^|[^\\])%.*$/, '$1')).join('\n');
  if (code.includes('\\endofdump')) return { preamble: null, reason: '\\endofdump in the preamble' };
  const unsafe = code.match(UNSAFE);
  if (unsafe) return { preamble: null, reason: `${unsafe[0]} cannot be precompiled` };
  return { preamble, reason: null };
}

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

function hashInputs(cwd, inputs) {
  const out = {};
  for (const rel of inputs) {
    try { out[rel] = sha1(fs.readFileSync(path.resolve(cwd, rel))); } catch { out[rel] = null; }
  }
  return out;
}

/**
 * Whether this compile can load the precompiled preamble. `cwd` is the root
 * file's directory (latexmk -cd), `outAbs` its output dir, `projectRoot` the
 * boundary of the files whose changes invalidate the format. Returns the
 * latexmk arguments and environment for a hit, and what `settle`/`build` need
 * afterwards.
 */
async function prepare({ projectRoot, cwd, outAbs, base, rootPath, engine }) {
  const state = { use: false, status: 'off', reason: null, fmtDir: path.join(outAbs, 'fmt', base), base, cwd, projectRoot, rootPath };
  if (!ENABLED) return { ...state, reason: 'disabled' };
  if (engine !== 'pdf') return { ...state, reason: `engine ${engine}` };
  // The name lands in latexmk's $pdflatex, which latexmk runs through a shell.
  if (!/^[A-Za-z0-9._-]+$/.test(base)) return { ...state, reason: 'file name' };
  const key = await toolKey();
  if (!key) return { ...state, reason: 'mylatexformat not installed' };
  let text;
  try { text = fs.readFileSync(rootPath, 'utf8'); } catch { return { ...state, reason: 'root unreadable' }; }
  const { preamble, reason } = preambleOf(text);
  if (preamble === null) return { ...state, reason };
  const hash = sha1(`${key}\n${preamble}`);
  const manifest = readJson(path.join(state.fmtDir, 'manifest.json'));
  const ready = manifest && manifest.hash === hash && !manifest.bad
    && fs.existsSync(path.join(state.fmtDir, `${base}.fmt`))
    && JSON.stringify(hashInputs(cwd, Object.keys(manifest.inputs || {}))) === JSON.stringify(manifest.inputs || {});
  if (!ready) {
    const bad = manifest && manifest.hash === hash && manifest.bad;
    return { ...state, status: bad ? 'bad' : 'miss', reason: bad ? 'format failed for this preamble' : null, hash, manifest };
  }
  return {
    ...state,
    use: true,
    status: 'hit',
    hash,
    manifest,
    args: [`-pdflatex=pdflatex -fmt=${base} %O %S`],
    env: { TEXFORMATS: `${state.fmtDir}:` },
  };
}

function writeManifest(fmtDir, m) {
  const tmp = path.join(fmtDir, `manifest.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(m));
  fs.renameSync(tmp, path.join(fmtDir, 'manifest.json'));
}

/** After a run that used the format: the first success vouches for it; a
 *  failure the plain run does not share condemns it. */
function settle(state, { formatOk, plainOk }) {
  if (!state.use || !state.manifest) return;
  try {
    if (formatOk && !state.manifest.verified) writeManifest(state.fmtDir, { ...state.manifest, verified: true });
    else if (!formatOk && plainOk) writeManifest(state.fmtDir, { ...state.manifest, bad: true });
  } catch { /* the cache is an optimisation; a write failure only costs speed */ }
}

const building = new Set();
let active = 0;

/**
 * Build the format for the next run, off the request path. One build at a
 * time across the service and none twice for the same document; a build
 * that cannot start now is simply tried again after a later typeset.
 */
function scheduleBuild(state) {
  if (state.status !== 'miss' || building.has(state.fmtDir) || active > 0) return null;
  building.add(state.fmtDir);
  active++;
  const p = build(state).catch(() => {}).finally(() => { building.delete(state.fmtDir); active--; });
  pending.add(p);
  p.finally(() => pending.delete(p));
  return p;
}
const pending = new Set();
/** Resolves once every scheduled build has finished (tests). */
const idle = () => Promise.all([...pending]);

async function build(state) {
  const { fmtDir, base, cwd, projectRoot, rootPath, hash } = state;
  const work = `${fmtDir}.build-${process.pid}`;
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  try {
    const before = fs.readFileSync(rootPath, 'utf8');
    const rootArg = path.relative(cwd, rootPath);
    const { code } = await run('nice', ['-n', '10', 'pdflatex', '-ini', '-interaction=nonstopmode', '-halt-on-error', '-recorder',
      `-jobname=${base}`, `-output-directory=${work}`, '&pdflatex', 'mylatexformat.ltx', rootArg],
    { cwd, detached: true, env: { ...process.env, HOME: process.env.HOME || '/tmp' } }, BUILD_TIMEOUT_MS);
    const fmt = path.join(work, `${base}.fmt`);
    // The root changed while the format was dumped: it belongs to neither version.
    if (code !== 0 || !fs.existsSync(fmt) || fs.readFileSync(rootPath, 'utf8') !== before) return;
    const inputs = [];
    const rootAbs = path.resolve(rootPath);
    const outRoot = path.dirname(path.dirname(fmtDir)); // .aldine-out
    for (const line of fs.readFileSync(path.join(work, `${base}.fls`), 'utf8').split('\n')) {
      if (!line.startsWith('INPUT ')) continue;
      const abs = path.resolve(cwd, line.slice(6).trim());
      if (abs === rootAbs || !abs.startsWith(projectRoot + path.sep) || abs.startsWith(outRoot + path.sep)) continue;
      const rel = path.relative(cwd, abs);
      if (!inputs.includes(rel)) inputs.push(rel);
    }
    fs.mkdirSync(fmtDir, { recursive: true });
    // Manifest out first: between the two renames no run may pair the old
    // manifest with the new format.
    fs.rmSync(path.join(fmtDir, 'manifest.json'), { force: true });
    fs.renameSync(fmt, path.join(fmtDir, `${base}.fmt`));
    writeManifest(fmtDir, { hash, inputs: hashInputs(cwd, inputs), builtAt: new Date().toISOString(), verified: false, bad: false });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

module.exports = { prepare, settle, scheduleBuild, idle, preambleOf, ENABLED };
