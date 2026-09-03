import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { branchDir, readMeta, writeMeta } from './store.js';
import { detectRoot } from './root.js';
import { ensureWorktree } from './gitops.js';
import { flushBranchDocs } from './collab.js';

export interface CompileError { type: 'error' | 'warning' | 'typesetting'; line: number | null; message: string; file?: string }

export interface CompileResult {
  ok: boolean;
  timedOut?: boolean;
  exitCode?: number;
  pdf: string | null;      // path relative to branch dir (.aldine-out/main.pdf)
  pdfUrl: string | null;   // URL the client can fetch
  /** This run produced no PDF: pdfUrl is the last one that did, unchanged. */
  pdfStale?: boolean;
  /** Page count of this run's PDF (from the engine's log); absent when unknown or stale. */
  pages?: number;
  /** mtime (ms) of the file behind pdfUrl when it was last shown. With pdfStale
   *  a newer file on disk means that PDF was overwritten (a halt-on-error run
   *  truncates it), so the "previous" one no longer exists to link to. */
  pdfWrittenAt?: number;
  /** This run halted on an error after it had started writing the PDF: the
   *  file on disk is its partial output, and the previous typeset's PDF no
   *  longer exists anywhere but in clients that already loaded it. */
  pdfTruncated?: boolean;
  /** Identifies the run whose PDF pdfUrl serves; SyncTeX lookups pass it back
   *  so a jump is refused instead of resolving against a different run. */
  compileId?: number;
  synctex: string | null;  // path relative to branch dir; informational
  log: string;
  errors: CompileError[];
  durationMs: number;
  error?: string;
}

/** The engine's "Output written on x.pdf (N pages, …)" line — the last one
 *  wins (a rerun for cross-references logs several). Only the log tail is
 *  scanned: a 200 KB log with the line at the end must not cost a full pass.
 *  TeX wraps log lines at max_print_line (79 unless the compiler raises it),
 *  so a long output path may push "(N pages" onto the next line. */
export function pagesFromLog(log: string): number | null {
  const tail = log.length > 65_536 ? log.slice(-65_536) : log;
  let pages: number | null = null;
  for (const m of tail.matchAll(/Output written on [^\n]*?(?:\n[^\n]*?)?\(\n?(\d+)[ \n]pages?/g)) pages = Number(m[1]);
  return pages;
}

/** Where latexmk writes the PDF for rootFile: "paper/main.tex" → "paper/.aldine-out/main.pdf". */
export function outputPdfRel(rootFile: string): string {
  const dir = path.posix.dirname(rootFile || 'main.tex');
  const base = path.posix.basename(rootFile || 'main.tex').replace(/\.tex$/i, '');
  return path.posix.join(dir === '.' ? '' : dir, '.aldine-out', `${base}.pdf`);
}

/**
 * The PDF currently on disk for a branch, whichever run wrote it — what the
 * MCP get_pdf_url tool hands out without recompiling. `pages` comes from the
 * .log beside it and is null when that log belongs to a later failed run
 * ("No pages of output"). `partial` is set when that log records a run that
 * stopped on an error AND wrote this very file (mtimes within a second):
 * a halt-on-error run's truncated output, which is nobody's to hand out.
 * A run that halted before touching the PDF leaves an older PDF beside a
 * newer log, so the previous typeset stays available. The worktree must
 * exist already.
 */
export function outputOnDisk(projectId: string, branch: string, rootFile: string): { pdf: string; typesetAt: string; pages: number | null; partial: boolean } | null {
  const rel = outputPdfRel(rootFile);
  const abs = path.join(branchDir(projectId, branch), rel);
  let st: fs.Stats;
  try { st = fs.statSync(abs); } catch { return null; }
  let pages: number | null = null;
  let partial = false;
  try {
    const logPath = abs.replace(/\.pdf$/, '.log');
    const logSt = fs.statSync(logPath);
    const fd = fs.openSync(logPath, 'r');
    try {
      const len = Math.min(logSt.size, 65_536);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, logSt.size - len);
      const tail = buf.toString('utf8');
      pages = pagesFromLog(tail);
      // "! " lines are fatal only under -halt-on-error; without it TeX runs on
      // and the caller (which knows the project's setting) ignores this flag.
      partial = st.mtimeMs >= logSt.mtimeMs - 1000 && /^(?:! |==> Fatal error occurred)/m.test(tail);
    } finally { fs.closeSync(fd); }
  } catch { /* no log — page count unknown */ }
  return { pdf: rel, typesetAt: st.mtime.toISOString(), pages, partial };
}

/** projectDir sent to the compiler is relative to the shared data volume root. */
function relProjectDir(projectId: string, branch: string): string {
  return path.relative(config.dataDir, branchDir(projectId, branch));
}

/**
 * Serialize compiles per project::branch so two clients can't run latexmk in
 * the same .aldine-out dir concurrently (which corrupts aux files / the PDF).
 * A queued request coalesces onto the in-flight one's successor.
 */
const compileChain = new Map<string, Promise<unknown>>();

/**
 * Last successful pdfUrl per project::branch. A failed latexmk run leaves the
 * previous PDF on disk (the compiler reports it by existence, not by `ok`), so
 * minting a fresh cache-buster would present that old PDF as this run's result
 * and misalign SyncTeX with the source. In-memory: after a restart the first
 * failed compile reports no PDF rather than an unknown one.
 */
const lastGoodPdfUrl = new Map<string, { url: string; compileId: number; writtenAt?: number }>();

/** compileId of the run whose SyncTeX file is on disk, per project::branch. */
const lastSynctexId = new Map<string, number>();

let lastCompileId = 0;
/** Strictly increasing even within one millisecond, so two quick runs never share a URL. */
function nextCompileId(): number {
  lastCompileId = Math.max(Date.now(), lastCompileId + 1);
  return lastCompileId;
}

/**
 * Drop remembered URLs when the files behind them go: deleting a branch
 * removes its worktree (and .aldine-out), so a branch recreated under the
 * same name must not inherit a URL that now 404s. Without `branch`, every
 * branch of the project is forgotten.
 */
export function forgetPdfUrls(projectId: string, branch?: string): void {
  if (branch !== undefined) { lastGoodPdfUrl.delete(`${projectId}::${branch}`); lastSynctexId.delete(`${projectId}::${branch}`); return; }
  for (const key of lastGoodPdfUrl.keys()) if (key.startsWith(`${projectId}::`)) lastGoodPdfUrl.delete(key);
  for (const key of lastSynctexId.keys()) if (key.startsWith(`${projectId}::`)) lastSynctexId.delete(key);
}

export interface CompilerInfo {
  /** The compiler answered /health. */
  ok: boolean;
  /** TeX Live release year ("2026") and scheme ("full" | "medium"); "unknown"
   *  when the compiler predates the report or runs outside the image. */
  texlive: { release: string; scheme: string };
}

const UNKNOWN_TEXLIVE = { release: 'unknown', scheme: 'unknown' };
// A reachable compiler's TeX Live does not change while it runs; an
// unreachable one is retried soon so the settings panel recovers with it.
const COMPILER_INFO_TTL_MS = 5 * 60_000;
const COMPILER_INFO_RETRY_MS = 5_000;
let compilerInfoCache: { until: number; value: CompilerInfo } | null = null;
let compilerInfoInflight: Promise<CompilerInfo> | null = null;

/** Release and scheme of the connected compiler's TeX Live, cached. */
export function compilerInfo(): Promise<CompilerInfo> {
  const now = Date.now();
  if (compilerInfoCache && compilerInfoCache.until > now) return Promise.resolve(compilerInfoCache.value);
  if (compilerInfoInflight) return compilerInfoInflight;
  compilerInfoInflight = (async () => {
    let value: CompilerInfo;
    try {
      const res = await fetch(`${config.compilerUrl}/health`, { signal: AbortSignal.timeout(5_000) });
      const raw = (await res.json()) as { ok?: boolean; texlive?: { release?: unknown; scheme?: unknown } };
      const str = (v: unknown) => (typeof v === 'string' && v ? v : 'unknown');
      value = { ok: !!raw.ok, texlive: { release: str(raw.texlive?.release), scheme: str(raw.texlive?.scheme) } };
    } catch {
      value = { ok: false, texlive: UNKNOWN_TEXLIVE };
    }
    compilerInfoCache = { until: Date.now() + (value.ok ? COMPILER_INFO_TTL_MS : COMPILER_INFO_RETRY_MS), value };
    return value;
  })().finally(() => { compilerInfoInflight = null; });
  return compilerInfoInflight;
}

export function compileProject(projectId: string, branch: string): Promise<CompileResult> {
  const key = `${projectId}::${branch}`;
  const prev = compileChain.get(key) || Promise.resolve();
  const result = prev.catch(() => undefined).then(() => runCompile(projectId, branch));
  // The chain tail must never reject (would surface as an unhandled rejection);
  // the caller gets `result` (which may reject and is awaited/handled by the route).
  const tail = result.catch(() => undefined).then(() => {
    if (compileChain.get(key) === tail) compileChain.delete(key);
  });
  compileChain.set(key, tail);
  return result;
}

async function runCompile(projectId: string, branch: string): Promise<CompileResult> {
  const meta = await readMeta(projectId);
  await ensureWorktree(projectId, branch);
  flushBranchDocs(projectId, branch);
  // A rootless project (blank, or its last .tex deleted) adopts a .tex here as
  // well as on file creation: files also arrive through git (pull, GitHub
  // sync) without passing the file routes.
  if (!meta.rootFile) {
    const root = detectRoot(projectId, branch);
    if (!root) throw new Error('No .tex file to typeset. Create one to start writing.');
    meta.rootFile = root;
    await writeMeta(meta);
  }

  const res = await fetch(`${config.compilerUrl}/compile`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectDir: relProjectDir(projectId, branch),
      rootFile: meta.rootFile,
      engine: meta.engine,
      haltOnError: !!meta.stopOnFirstError,
    }),
  });
  const raw = (await res.json()) as Partial<Omit<CompileResult, 'pdfUrl'>> & { error?: string; pdfFresh?: boolean; synctexFresh?: boolean };
  // Normalize: the compiler may return a bare {ok:false,error} on a 4xx — always
  // hand the client a well-formed CompileResult so the UI never sees undefined fields.
  const body: Omit<CompileResult, 'pdfUrl' | 'pdfStale'> = {
    ok: !!raw.ok,
    timedOut: raw.timedOut,
    exitCode: raw.exitCode,
    pdf: raw.pdf ?? null,
    synctex: raw.synctex ?? null,
    log: raw.log ?? (raw.error ? `Compiler error: ${raw.error}` : ''),
    errors: Array.isArray(raw.errors) ? raw.errors : [],
    durationMs: raw.durationMs ?? 0,
    error: raw.error,
  };
  const key = `${projectId}::${branch}`;
  const compileId = nextCompileId();
  // Older compilers report only `ok`; treat their successful output as fresh.
  const pdfFresh = raw.pdfFresh ?? body.ok;
  const synctexFresh = raw.synctexFresh ?? body.ok;
  if (synctexFresh && body.synctex) lastSynctexId.set(key, compileId);
  const previous = lastGoodPdfUrl.get(key) ?? null;
  const pdfAbs = body.pdf ? path.join(branchDir(projectId, branch), body.pdf) : null;
  const mtime = () => { try { return pdfAbs ? fs.statSync(pdfAbs).mtimeMs : undefined; } catch { return undefined; } };
  // The compiler's pdfFresh carries a 2 s slack for coarse filesystem clocks,
  // so a run started within 2 s of the last one reads an untouched PDF as
  // fresh. When the shown file's mtime is remembered, the mtime settles it.
  const now = mtime();
  const rewritten = !!body.pdf && pdfFresh && (now === undefined || previous?.writtenAt === undefined || now > previous.writtenAt + 1);
  const mintUrl = (id: number) => `/api/projects/${projectId}/output?branch=${encodeURIComponent(branch)}&path=${encodeURIComponent(body.pdf!)}&t=${id}`;
  const shown = (url: string, id: number) => {
    const writtenAt = mtime();
    lastGoodPdfUrl.set(key, { url, compileId: id, writtenAt });
    const pages = pagesFromLog(body.log);
    return { ...body, pdfUrl: url, compileId: id, ...(pages !== null ? { pages } : {}), ...(writtenAt !== undefined ? { pdfWrittenAt: writtenAt } : {}) };
  };
  // A run that wrote a PDF is shown even when it logged errors: TeX ran to the
  // end, so the document is complete and the errors sit in the list beside
  // it. With stopOnFirstError the PDF on disk is truncated at the first error,
  // so only an error-free run is shown and the previous one stays on screen.
  if (rewritten && (body.ok || !meta.stopOnFirstError)) return shown(mintUrl(compileId), compileId);
  // latexmk found nothing to redo (ok, the PDF on disk, none of it rewritten):
  // that PDF is this run's result, not a stale one. It keeps its URL and
  // compileId when known — a fresh cache-buster would refetch identical bytes
  // and unbind the SyncTeX file, which is that earlier run's too.
  if (body.ok && body.pdf) {
    const id = previous?.compileId ?? compileId;
    return shown(previous?.url ?? mintUrl(id), id);
  }
  return {
    ...body,
    pdfUrl: previous?.url ?? null,
    pdfStale: previous !== null,
    compileId: previous?.compileId,
    ...(previous?.writtenAt !== undefined ? { pdfWrittenAt: previous.writtenAt } : {}),
    // Reaching here with a rewritten file means the halted run wrote it.
    ...(rewritten ? { pdfTruncated: true } : {}),
  };
}

/** `{ stale: true }` when the caller's preview (compileId) is not the run whose SyncTeX is on disk. */
export async function synctexLookup(projectId: string, branch: string, payload: Record<string, unknown>): Promise<{ stale?: boolean; ok?: boolean; error?: string } & Record<string, unknown>> {
  const meta = await readMeta(projectId);
  const { compileId, ...rest } = payload;
  if (typeof compileId === 'number') {
    const current = lastSynctexId.get(`${projectId}::${branch}`);
    if (current !== undefined && current !== compileId) {
      return { ok: false, stale: true, error: 'The preview and the typeset output are from different runs — typeset again to jump accurately' };
    }
  }
  payload = rest;
  const res = await fetch(`${config.compilerUrl}/synctex`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectDir: relProjectDir(projectId, branch),
      rootFile: meta.rootFile,
      ...payload,
    }),
  });
  return res.json();
}
