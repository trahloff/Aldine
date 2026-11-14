/**
 * POST /format: latexindent over a copy of one file's text, indentation only.
 *
 *   { text, indent?: '\t' | '  ' … (1–8 spaces), ext?: 'tex' | 'sty' | 'cls' } ->
 *     { ok: true, text } | { ok: false, reason, error }
 *   reason: 'unavailable' | 'too-large' | 'timeout' | 'busy' | 'failed' | 'changed-text' | 'invalid'
 *
 * The text never touches a project directory. It is written to a fresh
 * directory under the OS temp dir, latexindent runs there with HOME pointed
 * at that same empty directory, and the answer is its stdout:
 * - no -w/-wd (nothing is rewritten), no -o, no -l (no localSettings.yaml,
 *   latexindent.yaml or a named file), no -m (line breaks stay where they
 *   are), no -r (no replacements), no -y from the request: the only setting
 *   is defaultIndent, from a value checked against INDENT;
 * - HOME, XDG_CONFIG_HOME and LATEXINDENT_CONFIG are replaced, so no
 *   indentconfig.yaml of the account the service runs as is read;
 * - -g /dev/null: no indent.log, and no backup file without -w;
 * - a wall-clock limit kills the process group, and stdout is capped.
 * An answer that differs from the input in anything but whitespace is
 * refused: indentation-only mode moves no text, so such an answer is a
 * latexindent fault, and it must not reach a shared document.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_BYTES = Number(process.env.FORMAT_MAX_BYTES || 1_000_000);
const TIMEOUT_MS = Number(process.env.FORMAT_TIMEOUT_MS || 10_000);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_FORMATS || 2);
// Indentation grows a line by at most a few tabs per nesting level; past this
// the process is producing something else and is killed.
const OUT_FACTOR = 4;
const INDENT = /^(?:\t| {1,8})$/;
const EXTS = new Set(['tex', 'sty', 'cls']);

let running = 0;
/** latexindent's version once probed; null when it is missing or cannot run. */
let version = null;
let probeError = null;

function cleanEnv(home) {
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: home, LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8' };
  delete env.LATEXINDENT_CONFIG;
  delete env.USERPROFILE;
  return env;
}

/** Runs latexindent in `cwd`: stdout, stderr and how it ended. */
function runIndent(args, cwd, timeoutMs, maxOut) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('latexindent', args, { cwd, env: cleanEnv(cwd), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: -2, out: '', err: String(err), timedOut: false, overflow: false, missing: true });
      return;
    }
    const outChunks = [];
    let outLen = 0;
    let err = '';
    let timedOut = false;
    let overflow = false;
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    child.stdout.on('data', (d) => {
      outLen += d.length;
      if (outLen > maxOut) { overflow = true; kill(); return; }
      outChunks.push(d);
    });
    child.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -2, out: '', err: String(e), timedOut: false, overflow: false, missing: e && e.code === 'ENOENT' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out: Buffer.concat(outChunks).toString('utf8'), err, timedOut, overflow, missing: false });
    });
  });
}

/** Why latexindent cannot run here, from what it printed: a Perl module it needs is missing. */
function missingModule(stderr) {
  const m = /Can't locate (\S+)\.pm in @INC/.exec(stderr || '');
  return m ? m[1].replace(/\//g, '::') : null;
}

async function probe() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-format-'));
  try {
    const r = await runIndent(['--version'], dir, 15_000, 10_000);
    if (r.code === 0 && /\d+\.\d+/.test(r.out)) { version = r.out.trim().split(/\s|,/)[0]; probeError = null; return; }
    version = null;
    const mod = missingModule(r.err);
    probeError = r.missing ? 'not installed' : mod ? `Perl module ${mod} missing` : (r.err.trim().split('\n')[0] || `exit ${r.code}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** What /health reports. */
const info = () => (version ? { available: true, version } : { available: false, error: probeError || 'not probed' });

const whitespaceFree = (s) => s.replace(/\s+/g, '');
const sizeLimit = () => (MAX_BYTES >= 1_000_000 ? `over ${+(MAX_BYTES / 1_000_000).toFixed(1)} MB` : `over ${Math.round(MAX_BYTES / 1000)} KB`);

async function format(body) {
  const fail = (reason, error) => ({ ok: false, reason, error });
  const { text } = body || {};
  if (typeof text !== 'string') return fail('invalid', 'text must be a string');
  const indent = body.indent === undefined ? '\t' : body.indent;
  if (typeof indent !== 'string' || !INDENT.test(indent)) return fail('invalid', 'indent must be a tab or 1 to 8 spaces');
  const ext = body.ext === undefined ? 'tex' : body.ext;
  if (!EXTS.has(ext)) return fail('invalid', 'latexindent formats .tex, .sty and .cls files');
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_BYTES) return fail('too-large', sizeLimit());
  if (!version) return fail('unavailable', `latexindent ${probeError || 'is not available'}`);
  if (running >= MAX_CONCURRENT) return fail('busy', 'Other files are being formatted');
  // CodeMirror counts \r\n as one line break; latexindent indents before the \r.
  const input = text.replace(/\r\n?/g, '\n');
  running++;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-format-'));
  try {
    const file = `doc.${ext}`;
    fs.writeFileSync(path.join(dir, file), input);
    const args = ['-g', '/dev/null'];
    // YAML double quotes: "\t" is a tab, spaces are themselves.
    if (indent !== '\t') args.push(`-y=defaultIndent:"${indent}"`);
    args.push(file);
    const r = await runIndent(args, dir, TIMEOUT_MS, Math.max(bytes * OUT_FACTOR, 64_000));
    if (r.timedOut) return fail('timeout', `latexindent ran over ${Math.round(TIMEOUT_MS / 1000)} s`);
    if (r.missing) return fail('unavailable', 'latexindent is not installed');
    if (r.overflow) return fail('failed', 'latexindent wrote far more than the file holds');
    if (r.code !== 0) {
      const mod = missingModule(r.err);
      if (mod) return fail('unavailable', `latexindent needs the Perl module ${mod}`);
      return fail('failed', (r.err.trim().split('\n').find(Boolean) || `latexindent exited with ${r.code}`).slice(0, 300));
    }
    if (input.length && !r.out.length) return fail('failed', 'latexindent printed nothing');
    if (whitespaceFree(r.out) !== whitespaceFree(input)) return fail('changed-text', 'latexindent changed more than whitespace');
    return { ok: true, text: r.out };
  } finally {
    running--;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { format, probe, info, sizeLimit, MAX_BYTES, TIMEOUT_MS };
