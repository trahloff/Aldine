/**
 * Venue catalog — which publisher classes this TeX Live installation actually
 * carries, so the app can offer a template per venue without vendoring a single
 * publisher file into the repo.
 *
 * Only the allowlist below is probed: an arbitrary kpsewhich sweep would expose
 * every class on the image, most of which nobody submits a paper to.
 * A scheme-basic install has almost none of them — an empty list is a normal
 * answer, never an error.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * id      — stable venue key; the app's template metadata is keyed by it, so it
 *           must not change when the image ships a newer, differently named file
 *           (aastex631.cls → aastex7.cls).
 * files   — candidates in preference order; the first one installed wins.
 * pkg     — TeX Live package name, for the license and upstream URL.
 */
const VENUES = [
  { id: 'elsarticle', pkg: 'elsarticle', files: ['elsarticle.cls'] },
  { id: 'ieeetran', pkg: 'ieeetran', files: ['IEEEtran.cls'] },
  { id: 'ieeeconf', pkg: 'ieeeconf', files: ['IEEEconf.cls'] },
  { id: 'acmart', pkg: 'acmart', files: ['acmart.cls'] },
  { id: 'revtex', pkg: 'revtex', files: ['revtex4-2.cls', 'revtex4-1.cls'] },
  { id: 'agujournal', pkg: 'agujournal', files: ['agujournal2019.cls', 'agujournal.cls'] },
  { id: 'copernicus', pkg: 'copernicus', files: ['copernicus.cls'] },
  { id: 'llncs', pkg: 'llncs', files: ['llncs.cls'] },
  { id: 'svjour3', pkg: 'svjour3', files: ['svjour3.cls'] },
  { id: 'mdpi', pkg: 'mdpi', files: ['mdpi.cls'] },
  { id: 'jmlr', pkg: 'jmlr', files: ['jmlr.cls'] },
  { id: 'amsart', pkg: 'amscls', files: ['amsart.cls'] },
  { id: 'siamart', pkg: 'siamart', files: ['siamart220329.cls', 'siamart190516.cls', 'siamart.cls'] },
  { id: 'jfm', pkg: 'jfm', files: ['jfm.cls'] },
  { id: 'aastex', pkg: 'aastex', files: ['aastex631.cls', 'aastex63.cls'] },
  { id: 'mnras', pkg: 'mnras', files: ['mnras.cls'] },
  { id: 'apa7', pkg: 'apa7', files: ['apa7.cls'] },
  { id: 'achemso', pkg: 'achemso', files: ['achemso.cls'] },
  { id: 'aiaa', pkg: 'aiaa', files: ['aiaa-tc.cls'] },
  { id: 'ascelike', pkg: 'ascelike', files: ['ascelike.cls'] },
  { id: 'asmeconf', pkg: 'asmeconf', files: ['asmeconf.cls'] },
  { id: 'spie', pkg: 'spie', files: ['spie.cls'] },
  // Conference kits ship as style files loaded on top of article.
  { id: 'neurips', pkg: 'neurips', files: ['neurips_2025.sty', 'neurips_2024.sty', 'neurips_2023.sty', 'neurips_2022.sty'] },
  { id: 'iclr', pkg: 'iclr', files: ['iclr2025_conference.sty', 'iclr2024_conference.sty', 'iclr2023_conference.sty'] },
  { id: 'acl', pkg: 'acl', files: ['acl.sty', 'acl_natbib.sty', 'acl2023.sty'] },
  { id: 'aaai', pkg: 'aaai', files: ['aaai25.sty', 'aaai24.sty', 'aaai.sty'] },
  { id: 'usenix', pkg: 'usenix', files: ['usenix2019_v3.sty', 'usenix.sty'] },
  { id: 'cvpr', pkg: 'cvpr', files: ['cvpr.sty', 'cvpr_eso.sty'] },
];

/** A sample bigger than this is a manual, not a starting point. */
const MAX_SAMPLE_BYTES = 100 * 1024;
const PROBE_TIMEOUT_MS = 30_000;

function run(cmd, args, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve({ ok: false, out: '' });
    }
    let out = '';
    let done = false;
    const finish = (ok) => { if (!done) { done = true; resolve({ ok, out }); } };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish(false); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.on('error', () => { clearTimeout(timer); finish(false); });
    child.on('close', () => { clearTimeout(timer); finish(true); });
  });
}

/**
 * kpsewhich prints one line per argument — the resolved path, or empty when the
 * file is not installed — so the answers line up with the queries positionally.
 */
/** null when kpsewhich itself did not run (missing, killed, timed out): not the same as "nothing installed". */
async function locate(files) {
  if (!files.length) return {};
  const { ok, out } = await run('kpsewhich', files);
  if (!ok) return null;
  const lines = out.split('\n');
  const found = {};
  files.forEach((f, i) => {
    const p = (lines[i] || '').trim();
    if (p && fs.existsSync(p)) found[f] = p;
  });
  return found;
}

/** One tlmgr call for the whole image: package → { license, version, home }. */
async function packageData() {
  const { ok, out } = await run('tlmgr', ['info', '--only-installed', '--data', 'name,cat-license,cat-version,cat-contact-home']);
  if (!ok) return {};
  const byPkg = {};
  for (const line of out.split('\n')) {
    const [name, license, version, home] = line.split(',');
    if (!name) continue;
    byPkg[name.trim()] = {
      license: (license || '').trim() || null,
      version: (version || '').trim() || null,
      source: (home || '').trim() || null,
    };
  }
  return byPkg;
}

/**
 * texmf-dist/tex/latex/<pkg>/x.cls → texmf-dist/doc/latex/<pkg>/. The last
 * "tex" segment is the tree root, so replacing it by name (not by string
 * search) survives paths that contain "tex" elsewhere, which every TeX Live
 * path does.
 */
function docDir(clsPath) {
  const parts = path.dirname(clsPath).split(path.sep);
  const i = parts.lastIndexOf('tex');
  if (i < 0) return null;
  parts[i] = 'doc';
  const dir = parts.join(path.sep);
  return fs.existsSync(dir) ? dir : null;
}

/**
 * Only the sample file itself is shipped, so a sample that pulls in a sibling
 * (a body fragment, a teaser figure, the package's own .bib) would land in a
 * project whose first compile cannot find it. Such a sample is rejected and the
 * app falls back to its generated skeleton.
 */
const SIBLING_MACROS = /\\(input|include|includegraphics|subfile|lstinputlisting|verbatiminput)\s*[{[]/;

function selfContained(content) {
  // Comments are not compiled, and samples routinely park an \includegraphics
  // example behind a %.
  const src = content.replace(/(^|[^\\])%.*$/gm, '$1');
  if (SIBLING_MACROS.test(src)) return false;
  const bibs = src.matchAll(/\\(?:bibliography|addbibresource)\s*(?:\[[^\]]*\])?\{([^}]*)\}/g);
  for (const m of bibs) {
    for (const name of m[1].split(',')) {
      const n = name.trim().replace(/\.bib$/i, '');
      if (n && n !== 'references') return false;
    }
  }
  return true;
}

/** The smallest ready-to-edit document in the class's doc directory, if any. */
function findSample(clsPath) {
  const dir = docDir(clsPath);
  if (!dir) return null;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  const candidates = [];
  for (const e of entries) {
    if (!e.isFile() || !/\.tex$/i.test(e.name)) continue;
    if (!/(sample|template|example|skeleton|demo|starter)/i.test(e.name)) continue;
    let stat;
    try { stat = fs.statSync(path.join(dir, e.name)); } catch { continue; }
    if (stat.size > MAX_SAMPLE_BYTES) continue;
    candidates.push({ name: e.name, size: stat.size });
  }
  candidates.sort((a, b) => a.size - b.size || a.name.localeCompare(b.name));
  for (const c of candidates) {
    let content;
    try { content = fs.readFileSync(path.join(dir, c.name), 'utf8'); } catch { continue; }
    if (!/\\begin\s*\{document\}/.test(content)) continue;
    if (!selfContained(content)) continue;
    return { file: c.name, content };
  }
  return null;
}

async function build() {
  const wanted = [];
  for (const v of VENUES) for (const f of v.files) wanted.push(f);
  const found = await locate(wanted);
  if (found === null) return { ok: false, generatedAt: new Date().toISOString(), classes: [] };
  const classes = [];
  if (Object.keys(found).length) {
    const pkgs = await packageData();
    for (const v of VENUES) {
      const file = v.files.find((f) => found[f]);
      if (!file) continue;
      const meta = pkgs[v.pkg] || {};
      classes.push({
        id: v.id,
        // The name that goes into \documentclass / \usepackage, without the extension.
        cls: file.replace(/\.(cls|sty)$/i, ''),
        kind: /\.sty$/i.test(file) ? 'style' : 'class',
        pkg: v.pkg,
        license: meta.license || null,
        version: meta.version || null,
        source: meta.source || null,
        sample: findSample(found[file]),
      });
    }
  }
  return { ok: true, generatedAt: new Date().toISOString(), classes };
}

let cached = null;
let inflight = null;
let failedUntil = 0;
const RETRY_MS = 30_000;

/**
 * A good catalog is cached for the life of the process: the TeX installation
 * cannot change under it, and installing a package needs a restart anyway.
 * There is deliberately no refresh switch — the port is unauthenticated, and a
 * caller that could drop the cache could make every request spawn its own
 * kpsewhich and tlmgr sweep. A probe that did not run (ok:false) is held for
 * RETRY_MS instead, so a slow first boot does not become an empty gallery for
 * the life of the process.
 */
function getCatalog() {
  if (cached) return Promise.resolve(cached);
  const failed = () => ({ ok: false, generatedAt: new Date().toISOString(), classes: [] });
  if (Date.now() < failedUntil) return Promise.resolve(failed());
  if (!inflight) {
    inflight = build()
      .then((c) => { if (c.ok) cached = c; else failedUntil = Date.now() + RETRY_MS; inflight = null; return c; })
      .catch(() => { failedUntil = Date.now() + RETRY_MS; inflight = null; return failed(); });
  }
  return inflight;
}

module.exports = { getCatalog, selfContained, VENUES };
