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
  /** Identifies the run whose PDF pdfUrl serves; SyncTeX lookups pass it back
   *  so a jump is refused instead of resolving against a different run. */
  compileId?: number;
  synctex: string | null;  // path relative to branch dir; informational
  log: string;
  errors: CompileError[];
  durationMs: number;
  error?: string;
}

/** The PDF the compiler writes for a root, relative to the branch dir (the compiler's `pdf` field). */
function expectedPdfRel(rootFile: string): string {
  const base = path.posix.basename(rootFile).replace(/\.tex$/i, '');
  return path.posix.join(path.posix.dirname(rootFile), '.aldine-out', `${base}.pdf`);
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
const lastGoodPdfUrl = new Map<string, { url: string; compileId: number; pdf: string }>();

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
  // A run that wrote a PDF is shown even when it logged errors: TeX ran to the
  // end, so the document is complete and the errors sit in the list beside
  // it. With stopOnFirstError the PDF on disk is truncated at the first error,
  // so only an error-free run is shown and the previous one stays on screen.
  // The remembered URL names a PDF path. It stands for this run only when
  // that path is the one this root produces: switching the main document and
  // back would otherwise serve the other document as a clean success.
  const remembered = lastGoodPdfUrl.get(key) ?? null;
  const expectedPdf = body.pdf ?? expectedPdfRel(meta.rootFile);
  const previous = remembered && remembered.pdf === expectedPdf ? remembered : null;
  if (!previous && remembered) lastGoodPdfUrl.delete(key);
  if (body.pdf && pdfFresh && (body.ok || !meta.stopOnFirstError)) {
    const pdfUrl = `${config.basePath}/api/projects/${projectId}/output?branch=${encodeURIComponent(branch)}&path=${encodeURIComponent(body.pdf)}&t=${compileId}`;
    lastGoodPdfUrl.set(key, { url: pdfUrl, compileId, pdf: body.pdf });
    return { ...body, pdfUrl, compileId };
  }
  // latexmk found nothing to redo: the PDF on disk is this run's result even
  // though nothing was rewritten. It keeps its URL and compileId — a fresh
  // cache-buster would refetch identical bytes and unbind SyncTeX, and
  // calling it stale would flag every typeset of an unchanged document.
  if (body.ok && body.pdf) {
    const id = previous?.compileId ?? compileId;
    const pdfUrl = previous?.url ?? `${config.basePath}/api/projects/${projectId}/output?branch=${encodeURIComponent(branch)}&path=${encodeURIComponent(body.pdf)}&t=${id}`;
    if (!previous) lastGoodPdfUrl.set(key, { url: pdfUrl, compileId: id, pdf: body.pdf });
    if (!lastSynctexId.has(key) && body.synctex) lastSynctexId.set(key, id);
    return { ...body, pdfUrl, compileId: id };
  }
  // No PDF from this run. The previous one is offered only while its file is
  // still there: a halted run under stopOnFirstError deletes the output, and
  // a URL to a deleted file is worse than no URL.
  const kept = previous && fs.existsSync(path.join(branchDir(projectId, branch), previous.pdf)) ? previous : null;
  if (!kept) lastGoodPdfUrl.delete(key);
  return { ...body, pdfUrl: kept?.url ?? null, pdfStale: kept !== null, compileId: kept?.compileId };
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
  // Only the lookup fields cross to the compiler: projectDir and rootFile are
  // the server's to set, and a body that carried its own would read another
  // project's SyncTeX records.
  const { direction, file, line, column, page, x, y } = rest;
  const res = await fetch(`${config.compilerUrl}/synctex`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectDir: relProjectDir(projectId, branch),
      rootFile: meta.rootFile,
      direction, file, line, column, page, x, y,
    }),
  });
  return res.json();
}
