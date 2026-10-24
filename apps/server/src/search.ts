import fs from 'node:fs';
import { Worker } from 'node:worker_threads';
import * as store from './store.js';
import * as gitops from './gitops.js';
import { openDocContent, flushBranchDocs, applyEditsToDoc, refreshBranchDocsFromDisk, bumpFilesSignal, notifyCommitted, scheduleCommit, docView, withCrlf, inFileLineEndings } from './collab.js';
import { cleanCommitMessage, importPath, looksBinary, safeJoin } from './util.js';
import { searchGate, searchSlots } from './ratelimit.js';
import { buildPattern, rebaseMatches, type MatchTarget, type PickResult, type ScanInput, type ScanLimits, type ScanMatch, type ScanResult, type SearchOptions, type WorkerJob } from './search-scan.js';

export const SEARCH_LIMITS = {
  queryUnits: 500,
  replaceUnits: 1000,
  fileBytes: 1024 * 1024,
  scanUnits: 8 * 1024 * 1024,
  matches: 2000,
  matchUnits: 1000,
  replaceFiles: 200,
  resultUnits: 4 * 1024 * 1024,
  largeNames: 20,
  scanMs: Number(process.env.ALDINE_SEARCH_MS || '') || 2000,
  scanHeapMb: 128,
};

const scanLimits = (): ScanLimits => ({
  maxMatches: SEARCH_LIMITS.matches,
  maxScanUnits: SEARCH_LIMITS.scanUnits,
  maxMatchUnits: SEARCH_LIMITS.matchUnits,
  maxResultUnits: SEARCH_LIMITS.resultUnits,
});

/** A refusal the route sends as is. */
export class SearchError extends Error {
  constructor(public readonly status: number, public readonly body: { error: string; code?: string }) { super(body.error); }
}

const staleMatch = () => new SearchError(409, { error: 'The text changed since the search — search again', code: 'stale_match' });
const tooMuchText = () => new SearchError(413, { error: 'These files hold too much text for one replace — replace in fewer files' });

// Build output is regenerated on every typeset; a binary extension is never
// read at all, so a large figure costs nothing.
const BUILD_OUTPUT_RE = /\.(aux|log|out|toc|lof|lot|loa|bbl|bcf|blg|fls|fdb_latexmk|synctex(\.gz)?|run\.xml|nav|snm|vrb|xdv|idx|ilg|ind|glo|gls|glg|ist|acn|acr|alg|thm|brf|pdf)$/i;
const BINARY_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|tiff?|ico|eps|ps|zip|gz|tgz|xz|7z|ttf|otf|woff2?|pfb|mp4|mov|docx?|xlsx?|pptx?|odt)$/i;

/** Hidden files (any segment starting with "."), build output and binary extensions are never searched. */
export function searchablePath(rel: string): boolean {
  return !rel.split('/').some((s) => s.startsWith('.')) && !BUILD_OUTPUT_RE.test(rel) && !BINARY_EXT_RE.test(rel);
}

/**
 * The branch's searchable files in path order, and those skipped for size.
 * Regular files only: through a symlink a search would read, and a replace
 * write, whatever it points at (META_DIR, another project, a device), and the
 * commit would store the file's text as the link's target. listFiles never
 * descends into a linked directory, so checking the entry itself suffices.
 */
export function searchableFiles(projectId: string, branch: string): { paths: string[]; large: string[] } {
  const base = store.branchDir(projectId, branch);
  const paths: string[] = [];
  const large: string[] = [];
  for (const e of store.listFiles(projectId, branch)) {
    if (e.type !== 'file' || !searchablePath(e.path)) continue;
    let st: fs.Stats;
    try { st = fs.lstatSync(safeJoin(base, e.path)); } catch { continue; }
    if (!st.isFile()) continue;
    if (st.size > SEARCH_LIMITS.fileBytes) large.push(e.path); else paths.push(e.path);
  }
  return { paths, large };
}

// fatal: a file that is not UTF-8 throughout is not text a replace may
// rewrite. ignoreBOM keeps a BOM as U+FEFF, as the live document has it, so
// offsets agree with Y.Text and the bytes round-trip.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const SNIFF_BYTES = 8000;
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

/** `text` null: not text a replace may rewrite. `text` is LF only, as an open
 *  document and the editor hold it, so offsets agree with theirs; a closed
 *  file adds `raw`, its text as on disk, and whether it is `crlf` throughout
 *  (docView). `cost`: what reading it took (bytes from disk, units of a live
 *  doc), counted against the scan budget whether or not it turned out to be
 *  text. */
type Current = { text: string | null; open: boolean; cost: number; raw?: string; crlf?: boolean } | 'large';

/** The disk copy, never through a symlink. A binary file costs the 8 KB its
 *  sniff read, not its whole length. */
function diskText(projectId: string, branch: string, rel: string): Current {
  let fd: number;
  try { fd = fs.openSync(safeJoin(store.branchDir(projectId, branch), rel), fs.constants.O_RDONLY | NOFOLLOW); } catch { return { text: null, open: false, cost: 0 }; }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { text: null, open: false, cost: 0 };
    if (st.size > SEARCH_LIMITS.fileBytes) return 'large';
    const head = Buffer.alloc(Math.min(st.size, SNIFF_BYTES));
    const n = fs.readSync(fd, head, 0, head.length, 0);
    if (looksBinary(head.subarray(0, n), st.size > n)) return { text: null, open: false, cost: n };
    const buf = n === st.size ? head : fs.readFileSync(fd);
    if (buf.length > SEARCH_LIMITS.fileBytes) return 'large';
    let raw: string;
    try { raw = utf8.decode(buf); } catch { return { text: null, open: false, cost: buf.length }; }
    const { text, crlf } = docView(raw);
    return { text, open: false, cost: buf.length, raw, crlf };
  } finally {
    fs.closeSync(fd);
  }
}

/** The file's current text: the live document when one is open (disk lags
 *  it by up to 8 s), else the disk copy. Never flushes. */
function currentText(projectId: string, branch: string, rel: string): Current {
  const live = openDocContent(projectId, branch, rel);
  if (live === null) return diskText(projectId, branch, rel);
  if (live.length > SEARCH_LIMITS.fileBytes) return 'large';
  if (live.slice(0, SNIFF_BYTES).includes('\0')) return { text: null, open: true, cost: 0 };
  // A doc is loaded with a lossy decoder: its U+FFFD may stand for bytes on
  // disk that are not UTF-8 (a Latin-1 file merely open in the editor), and
  // writing the doc back would replace them for good.
  if (live.includes('�')) {
    const disk = diskText(projectId, branch, rel);
    if (disk === 'large' || disk.text === null) return { text: null, open: true, cost: disk === 'large' ? 0 : disk.cost };
  }
  return { text: live, open: true, cost: live.length };
}

function regexReason(err: unknown): string {
  return String((err as Error)?.message || err).replace(/^Invalid regular expression: \/[\s\S]*\/[a-z]*: /, '');
}

export function parsePattern(q: unknown, opts: SearchOptions): RegExp {
  if (typeof q !== 'string' || q.length === 0) throw new SearchError(400, { error: 'Search for at least one character' });
  if (q.length > SEARCH_LIMITS.queryUnits) throw new SearchError(400, { error: `Search text is too long (${SEARCH_LIMITS.queryUnits} characters at most)` });
  try { return buildPattern(q, opts); } catch (err) { throw new SearchError(400, { error: `Invalid regular expression: ${regexReason(err)}` }); }
}

/**
 * Every scan, literal or regex, runs in a worker of its own, terminated when
 * it answers or when its budget runs out: a catastrophic pattern costs one
 * worker's time slice while the event loop keeps serving everyone else. A
 * literal needs it too — V8 matches a case-insensitive literal in
 * O(text × query). No V8 flag is changed: the linear-time regexp engine is a
 * process-wide switch.
 */
export function scanInWorker<T extends ScanResult | PickResult>(pattern: RegExp, regex: boolean, job: WorkerJob): Promise<T> {
  return new Promise((resolve, reject) => {
    const url = new URL(import.meta.url.endsWith('.ts') ? './search-scan.ts' : './search-scan.js', import.meta.url);
    const worker = new Worker(url, {
      workerData: { kind: 'aldine-search', source: pattern.source, flags: pattern.flags, job },
      resourceLimits: { maxOldGenerationSizeMb: SEARCH_LIMITS.scanHeapMb },
    });
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      settle();
    };
    const slow = regex ? 'This regular expression takes too long to run — simplify it' : 'This search takes too long to run — search for shorter text';
    const timer = setTimeout(() => finish(() => reject(new SearchError(422, { error: slow, code: 'search_timeout' }))), SEARCH_LIMITS.scanMs);
    worker.once('message', (r: T) => finish(() => resolve(r)));
    worker.once('error', (err: Error & { code?: string }) => finish(() => reject(err.code === 'ERR_WORKER_OUT_OF_MEMORY'
      ? new SearchError(422, { error: 'This search needs too much memory — narrow it', code: 'search_memory' })
      : err)));
    worker.once('exit', (code) => finish(() => reject(new Error(`search worker exited with code ${code}`))));
  });
}

/** One scan per client and four per process, held only around the worker: a
 *  replace waiting for the repo lock or committing holds no slot. */
async function withScanGate<T>(gateKey: string, fn: () => Promise<T>): Promise<T> {
  if (!searchGate.tryAcquire(gateKey)) throw new SearchError(429, { error: 'A search is still running — wait for it to finish' });
  if (!searchSlots.tryAcquire('all')) {
    searchGate.release(gateKey);
    throw new SearchError(429, { error: 'Too many searches are running on this server — try again in a moment' });
  }
  try { return await fn(); } finally {
    searchSlots.release('all');
    searchGate.release(gateKey);
  }
}

export interface SearchQuery extends SearchOptions { q: unknown }
export interface SearchResponse {
  files: ScanResult['files'];
  total: number;
  truncated: ScanResult['truncated'];
  /** `large` names at most SEARCH_LIMITS.largeNames of the `largeCount` files skipped for size. */
  skipped: { large: string[]; largeCount: number; longMatches: number };
}

/** Read the files' current text until the scan budget is spent; `stopped`
 *  when files were left unread for it. */
function readInputs(projectId: string, branch: string, paths: string[], large: string[]): { inputs: ScanInput[]; stopped: boolean } {
  const inputs: ScanInput[] = [];
  let cost = 0;
  for (const p of paths) {
    if (cost > SEARCH_LIMITS.scanUnits) return { inputs, stopped: true };
    const cur = currentText(projectId, branch, p);
    if (cur === 'large') { large.push(p); continue; }
    cost += cur.cost;
    if (cur.text !== null) inputs.push({ path: p, text: cur.text, open: cur.open });
  }
  return { inputs, stopped: false };
}

export async function searchProject(projectId: string, branch: string, query: SearchQuery, gateKey: string): Promise<SearchResponse> {
  const pattern = parsePattern(query.q, query);
  return withScanGate(gateKey, async () => {
    const { paths, large } = searchableFiles(projectId, branch);
    const read = readInputs(projectId, branch, paths, large);
    const r = await scanInWorker<ScanResult>(pattern, query.regex, { op: 'scan', files: read.inputs, limits: scanLimits() });
    large.sort((a, b) => a.localeCompare(b));
    return {
      files: r.files,
      total: r.total,
      truncated: r.truncated ?? (read.stopped ? 'bytes' : null),
      skipped: { large: large.slice(0, SEARCH_LIMITS.largeNames), largeCount: large.length, longMatches: r.longMatches },
    };
  });
}

const quoted = (s: string) => {
  const chars = Array.from(s.replace(/\s+/g, ' '));
  return chars.length > 40 ? `${chars.slice(0, 40).join('')}…` : chars.join('');
};

/** `Replace "colour" with "color" in 3 files`; a regex shows as /…/, an empty replacement as Delete. */
export function replaceCommitMessage(query: string, replacement: string, paths: string[], opts: { regex?: boolean } = {}): string {
  const what = opts.regex ? `/${quoted(query)}/` : `"${quoted(query)}"`;
  const where = paths.length === 1 ? paths[0] : `${paths.length} files`;
  const msg = replacement === '' ? `Delete ${what} in ${where}` : `Replace ${what} with "${quoted(replacement)}" in ${where}`;
  return cleanCommitMessage(msg, 'Replace in files');
}

export interface ReplaceBody {
  branch?: string;
  q?: unknown;
  case?: unknown;
  word?: unknown;
  regex?: unknown;
  replace?: unknown;
  match?: { path?: unknown; text?: unknown; preview?: unknown; ordinal?: unknown; count?: unknown; alike?: unknown };
  paths?: unknown;
  author?: unknown;
}

export interface ReplaceResponse {
  replaced: number;
  skipped: number;
  files: Array<{ path: string; replaced: number; skipped: number }>;
  commit: string | null;
  pending: boolean;
}

/** A project-relative path a replace may touch: no `..`, no hidden segment. */
function targetPath(raw: unknown): string {
  const norm = typeof raw === 'string' ? importPath(raw) : null;
  if (norm === null || norm.split('/').some((s) => s.startsWith('.'))) throw new SearchError(403, { error: 'Invalid file path' });
  return norm;
}

const isCount = (v: unknown, min = 0): v is number => Number.isInteger(v) && (v as number) >= min;

/** The one match a Replace (one) names: its text and preview as the search
 *  showed them, its place among the file's matches of the same text, and how
 *  many of those shared its preview. */
function matchTarget(m: ReplaceBody['match']): { path: string; target: MatchTarget } {
  const p = (m && typeof m === 'object' ? m.preview : null) as { text?: unknown; start?: unknown; end?: unknown } | null;
  if (!m || typeof m !== 'object' || typeof m.text !== 'string' || !m.text || m.text.length > SEARCH_LIMITS.matchUnits
    || !p || typeof p !== 'object' || typeof p.text !== 'string' || p.text.length > SEARCH_LIMITS.matchUnits
    || !isCount(p.start) || !isCount(p.end) || p.end < p.start
    || !isCount(m.count, 1) || !isCount(m.ordinal) || m.ordinal >= m.count
    || !isCount(m.alike, 1) || m.alike > m.count) {
    throw new SearchError(400, { error: 'match needs path, text, preview, ordinal, count and alike as the search returned them' });
  }
  return { path: targetPath(m.path), target: { text: m.text, preview: { text: p.text, start: p.start, end: p.end }, ordinal: m.ordinal, count: m.count, alike: m.alike } };
}

/** `edits` ascending and disjoint. */
function splice(text: string, edits: Array<{ from: number; to: number; insert: string }>): string {
  let out = '';
  let at = 0;
  for (const e of edits) { out += text.slice(at, e.from) + e.insert; at = e.to; }
  return out + text.slice(at);
}

/** A closed file's new text, never through a symlink. */
function writeDisk(projectId: string, branch: string, rel: string, text: string): void {
  const fd = fs.openSync(safeJoin(store.branchDir(projectId, branch), rel), fs.constants.O_WRONLY | fs.constants.O_TRUNC | NOFOLLOW);
  try { fs.writeFileSync(fd, text); } finally { fs.closeSync(fd); }
}

/**
 * Replace one match or every match in a set of files, as one commit under
 * the person's name. Live documents change through a CRDT edit (collaborators
 * see it, nothing is written underneath them), closed files on disk. The
 * scan runs on snapshots taken inside the repo lock; the apply re-reads each
 * file in the same tick it writes it, and drops any match whose text a
 * collaborator touched meanwhile. The named commit is built from the held
 * before/after texts, so its diff is exactly the replacements.
 */
export async function replaceInProject(projectId: string, branch: string, body: ReplaceBody, author: string | undefined, gateKey: string): Promise<ReplaceResponse> {
  const opts: SearchOptions = { caseSensitive: body.case === true, wholeWord: body.word === true, regex: body.regex === true };
  if (typeof body.replace !== 'string') throw new SearchError(400, { error: 'Send the replacement text as replace' });
  // A document holds LF only; a CRLF file gets its CRs back when it is written.
  const replacement = body.replace.replace(/\r\n?/g, '\n');
  if (replacement.length > SEARCH_LIMITS.replaceUnits) throw new SearchError(400, { error: `Replacement text is too long (${SEARCH_LIMITS.replaceUnits.toLocaleString('en-US')} characters at most)` });
  if ((body.match === undefined) === (body.paths === undefined)) throw new SearchError(400, { error: 'Send either match or paths, not both' });
  let one: { path: string; target: MatchTarget } | null = null;
  let targets: string[];
  if (body.match !== undefined) {
    one = matchTarget(body.match);
    targets = [one.path];
  } else {
    const ps = body.paths;
    if (!Array.isArray(ps) || ps.length === 0 || ps.some((p) => typeof p !== 'string')) throw new SearchError(400, { error: 'paths must list the files to replace in' });
    if (ps.length > SEARCH_LIMITS.replaceFiles) throw new SearchError(400, { error: `Replace all takes at most ${SEARCH_LIMITS.replaceFiles} files at once` });
    targets = [...new Set(ps.map(targetPath))];
  }
  const pattern = parsePattern(body.q, opts);
  const query = body.q as string;
  const manual = (await store.readMeta(projectId)).manualCommits === true;
  const replace = { template: replacement, regex: opts.regex };

  return gitops.withRepoLock(projectId, async (): Promise<ReplaceResponse> => {
    flushBranchDocs(projectId, branch);
    const searchable = new Set(searchableFiles(projectId, branch).paths);
    const present = targets.filter((p) => searchable.has(p));
    const gone = targets.filter((p) => !searchable.has(p));
    if (one && gone.length) throw staleMatch();
    // Keeps a collaborator's earlier unsaved typing in these files out of the
    // person's named commit, as batch_write does for the agent.
    if (!manual && present.length) {
      await gitops.checkpointPathsHeld(projectId, branch, present);
      flushBranchDocs(projectId, branch);
    }
    const read = readInputs(projectId, branch, present, []);
    if (read.stopped) throw tooMuchText();
    const snaps = new Map(read.inputs.map((f) => [f.path, f.text]));
    for (const p of present) if (!snaps.has(p)) gone.push(p);

    const perFile = new Map<string, ScanMatch[]>();
    if (one) {
      const { path, target } = one;
      const text = snaps.get(path);
      if (text === undefined) throw staleMatch();
      const r = await withScanGate(gateKey, () => scanInWorker<PickResult>(pattern, opts.regex, { op: 'pick', text, target, limits: scanLimits(), replace }));
      if ('stale' in r) throw staleMatch();
      const size = text.length + (r.match.replacement ?? '').length - (r.match.to - r.match.from);
      if (size > SEARCH_LIMITS.resultUnits) throw new SearchError(413, { error: `"${path}" would grow past 4 MB` });
      perFile.set(path, [r.match]);
    } else {
      const inputs = [...snaps].map(([path, text]) => ({ path, text }));
      const scan = await withScanGate(gateKey, () => scanInWorker<ScanResult>(pattern, opts.regex, { op: 'scan', files: inputs, limits: scanLimits(), replace }));
      if (scan.truncated === 'bytes') throw tooMuchText();
      if (scan.truncated === 'matches') throw new SearchError(413, { error: `More than ${SEARCH_LIMITS.matches.toLocaleString('en-US')} matches — narrow the search` });
      if (scan.tooLarge) throw new SearchError(413, { error: `"${scan.tooLarge}" would grow past 4 MB` });
      for (const f of scan.files) perFile.set(f.path, f.matches);
    }

    // --- synchronous from here to the end of the loop: each file is re-read
    // and written in one tick, so no keystroke lands between the check and
    // the edit. Whether a file goes through its document is decided now: one
    // opened while the scan ran is changed through it. The flush puts what
    // was typed into any open doc during the scan on disk, so the refresh
    // below finds every doc equal to its file except the ones rewritten here;
    // without it, the refresh would reset those docs to their older disk copy.
    flushBranchDocs(projectId, branch);
    const files: ReplaceResponse['files'] = gone.map((path) => ({ path, replaced: 0, skipped: 1 }));
    const written: Array<{ path: string; before: string; after: string }> = [];
    const reseed: string[] = [];
    let replaced = 0;
    let skipped = gone.length;
    for (const [path, matches] of perFile) {
      const now = currentText(projectId, branch, path);
      if (now === 'large' || now.text === null) { skipped += matches.length; files.push({ path, replaced: 0, skipped: matches.length }); continue; }
      const cur = now.text;
      const { kept, skipped: dropped } = rebaseMatches(snaps.get(path)!, cur, matches);
      skipped += dropped;
      replaced += kept.length;
      files.push({ path, replaced: kept.length, skipped: dropped });
      if (!kept.length) continue;
      const edits = kept.map((m) => ({ from: m.from, to: m.to, insert: m.replacement ?? '' }));
      // Written and committed in the file's own line endings: in the LF text
      // every line of a CRLF file would count as changed. A file with mixed
      // endings is saved with LF, as the editor saves it at its first edit.
      const inFile = (t: string) => (now.open ? inFileLineEndings(projectId, branch, path, t) : now.crlf ? withCrlf(t) : t);
      const before = now.raw ?? inFile(cur);
      let after = splice(cur, edits);
      if (now.open && applyEditsToDoc(projectId, branch, path, edits) === 'applied') {
        after = inFile(openDocContent(projectId, branch, path) ?? after);
      } else {
        after = inFile(after);
        writeDisk(projectId, branch, path, after);
        reseed.push(path);
      }
      written.push({ path, before, after });
    }
    if (reseed.length) refreshBranchDocsFromDisk(projectId, branch, reseed);

    let commit: string | null = null;
    if (written.length && !manual) {
      const message = replaceCommitMessage(query, replacement, written.map((w) => w.path), { regex: opts.regex });
      try {
        const res = await gitops.commitWriteHeld(projectId, branch, written, message, author);
        if (res.committed && res.hash) {
          commit = res.hash.slice(0, 7);
          notifyCommitted(projectId, branch);
        }
      } catch (err) {
        // Left for the anonymous autosave, not the attribution ledger: that
        // holds agent work under one author per branch, so the person's
        // paths in it would be committed under the agent's name, or the
        // agent's under theirs.
        console.warn(`[search] commit of ${written.map((w) => w.path).join(', ')} failed, left for the autosave: ${(err as Error).message}`);
        scheduleCommit(projectId, branch);
      }
    }
    // After the commit, so a client refetching History on the signal sees it.
    if (written.length) bumpFilesSignal(projectId, branch);
    files.sort((a, b) => a.path.localeCompare(b.path));
    return { replaced, skipped, files, commit, pending: manual && written.length > 0 };
  });
}
