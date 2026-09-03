import { listFiles, readFile } from './store.js';

/** \documentclass or \begin{document} outside a `%` comment — a commented-out
 *  preamble in a snippet must not make it a root candidate. */
const HAS_DOCUMENTCLASS = /^[^%\n]*\\documentclass\b/m;
const HAS_BEGIN_DOCUMENT = /^[^%\n]*\\begin\{document\}/m;
// Journal templates open with comment banners well past 4 KB; scanning this
// much of each .tex keeps the cost bounded on a 200 MB archive.
const ROOT_SCAN_BYTES = 256 * 1024;
const ROOT_NAMES = /^(main|paper|manuscript|ms|article|thesis)$/i;

/**
 * Pick the root .tex of an imported archive. Candidates carry \documentclass;
 * among them prefer \begin{document} (a template's class stub has none), then
 * a conventional root name, then the shallowest path, then the smallest file
 * (a bundled sample/template outsizes the manuscript). Without any candidate,
 * the shallowest .tex — never a name that is not in the archive.
 */
export function guessRoot(files: Record<string, Buffer>): string | undefined {
  type Ranked = { path: string; key: number[] };
  const depth = (p: string) => p.split('/').length;
  const named = (p: string) => (ROOT_NAMES.test(p.split('/').pop()!.replace(/\.tex$/i, '')) ? 0 : 1);
  const before = (a: Ranked, b: Ranked) => {
    for (let i = 0; i < a.key.length; i++) if (a.key[i] !== b.key[i]) return a.key[i] < b.key[i];
    return a.path < b.path;
  };
  let best: Ranked | null = null;
  let fallback: Ranked | null = null;
  for (const [path, data] of Object.entries(files)) {
    if (!/\.tex$/i.test(path)) continue;
    const shallow: Ranked = { path, key: [depth(path), named(path), data.length] };
    if (!fallback || before(shallow, fallback)) fallback = shallow;
    const head = data.toString('utf8', 0, Math.min(data.length, ROOT_SCAN_BYTES));
    if (!HAS_DOCUMENTCLASS.test(head)) continue;
    const ranked: Ranked = { path, key: [HAS_BEGIN_DOCUMENT.test(head) ? 0 : 1, named(path), depth(path), data.length] };
    if (!best || before(ranked, best)) best = ranked;
  }
  return (best ?? fallback)?.path;
}

/**
 * The typeset root a branch should have, by the same ranking as an imported
 * archive, or '' with no .tex on the branch. Used wherever a root is derived
 * from what is on disk rather than named by the user: a rootless project at
 * typeset time, the first .tex created, and the root's deletion.
 */
export function detectRoot(id: string, branch: string): string {
  const files: Record<string, Buffer> = {};
  for (const f of listFiles(id, branch)) {
    if (f.type !== 'file' || !/\.tex$/i.test(f.path)) continue;
    try { files[f.path] = readFile(id, branch, f.path); } catch { /* removed between listing and reading */ }
  }
  return guessRoot(files) ?? '';
}
