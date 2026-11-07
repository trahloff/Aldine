import { ApiError, type CompileResult } from '../api';
import { withBase } from '../basePath';
import { pdfjs } from '../util/pdfjs';
import { BUNDLE_TYPE, encodeBundle } from './bundle';
import { runEngine, stopEngine, typesetInfo, typesetsHere, type EngineOutput } from './host';
import { synctexLookup } from './synctex';

/**
 * Typesetting in this browser (ALDINE_TYPESET=browser). Every typeset runs
 * here and is shown from memory at once; some are published to the server
 * (apps/server/src/browsertex/), for the people and features that read the
 * PDF there: tabs without TeX, the project list's thumbnail and download,
 * share links, the agent. Publishing is thinned out: only runs that
 * produced a final PDF (a full run, or a draft that owes none), only from the
 * branch's publishing tab, the latest of a burst, at most every
 * PUBLISH_EVERY_MS, and never twice for the same inputs.
 */

/** GET /api/projects/:id/compile/snapshot, and a claimed run (with id and draft). */
export interface Snapshot {
  branch: string;
  rootFile: string;
  engine: string;
  haltOnError: boolean;
  files: Array<{ path: string; size: number; key: string }>;
  runId?: number;
}
interface ClaimedJob extends Snapshot { id: string; draft: boolean }

const PUBLISH_EVERY_MS = 10_000;
const THUMB_WIDTH = 512;
const FETCH_PARALLEL = 6;

/** Files of past runs, per project and branch, by the server's change key. */
const held = new Map<string, Map<string, { key: string; data: Uint8Array }>>();

/** Runs shown from memory, by runId: what SyncTeX and publishing need of them. */
/** `inputs` names what the run was typeset from: two runs with the same are
 *  the same document (their PDFs still differ, by the date TeX stamps in). */
interface LocalRun { projectId: string; branch: string; rootFile: string; draft: boolean; final: boolean; runId: number; out: EngineOutput; files: Set<string>; inputs: string; url: string; durationMs: number }
const localRuns = new Map<number, LocalRun>();

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(withBase(url), init);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = ((await res.json()) as { error?: string }).error || msg; } catch { /* keep */ }
    throw new ApiError(msg, res.status);
  }
  return res.json() as Promise<T>;
}

async function filesFor(projectId: string, snap: Snapshot): Promise<Array<{ path: string; contents: Uint8Array | string }>> {
  const cacheKey = `${projectId}::${snap.branch}`;
  const cache = held.get(cacheKey) ?? new Map();
  held.set(cacheKey, cache);
  const wanted = new Set(snap.files.map((f) => f.path));
  for (const p of cache.keys()) if (!wanted.has(p)) cache.delete(p);
  const missing = snap.files.filter((f) => cache.get(f.path)?.key !== f.key);
  let next = 0;
  const worker = async () => {
    while (next < missing.length) {
      const f = missing[next++];
      const res = await fetch(withBase(`/api/projects/${projectId}/file?branch=${encodeURIComponent(snap.branch)}&path=${encodeURIComponent(f.path)}`));
      // Deleted since the snapshot: TeX will say what it misses.
      if (res.ok) cache.set(f.path, { key: f.key, data: new Uint8Array(await res.arrayBuffer()) });
    }
  };
  await Promise.all(Array.from({ length: Math.min(FETCH_PARALLEL, missing.length) }, worker));
  const strict = new TextDecoder('utf-8', { fatal: true });
  return snap.files.filter((f) => cache.has(f.path)).map((f) => {
    const data = cache.get(f.path)!.data.slice();
    // The engine reads \usepackage lines from the root file only when it is
    // text; a root file that is not UTF-8 stays bytes, as TeX reads it.
    if (f.path === snap.rootFile) {
      try { return { path: f.path, contents: strict.decode(data) }; } catch { /* bytes */ }
    }
    return { path: f.path, contents: data };
  });
}

async function engineRun(projectId: string, snap: Snapshot, draft: boolean): Promise<{ out: EngineOutput; durationMs: number }> {
  const info = await typesetInfo();
  if (!info) throw new ApiError('This server does not typeset in the browser', 400);
  const files = await filesFor(projectId, snap);
  const started = performance.now();
  let out: EngineOutput;
  try {
    out = await runEngine(info, { files, main: snap.rootFile, engine: snap.engine, draft });
  } catch (err: any) {
    if (err?.stopped) throw err;
    out = { exitCode: -1, pdf: null, synctex: null, log: '', blg: '', transcript: `The TeX engine in this browser failed: ${err?.message ?? err}` };
  }
  return { out, durationMs: performance.now() - started };
}

/** Page 1 as a JPEG for the project list, or null when it cannot be drawn. */
async function thumbnail(pdf: Uint8Array): Promise<{ jpeg: Uint8Array; w: number; h: number } | null> {
  try {
    const doc = await pdfjs.getDocument({ data: pdf.slice() }).promise;
    try {
      const page = await doc.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: THUMB_WIDTH / base.width });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.min(Math.round(viewport.height), THUMB_WIDTH * 3);
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.75));
      if (!blob) return null;
      return { jpeg: new Uint8Array(await blob.arrayBuffer()), w: canvas.width, h: canvas.height };
    } finally {
      void doc.destroy();
    }
  } catch {
    return null;
  }
}

async function upload(projectId: string, meta: Record<string, unknown>, out: EngineOutput, durationMs: number): Promise<CompileResult> {
  const thumb = out.exitCode === 0 && out.pdf ? await thumbnail(out.pdf) : null;
  const enc = new TextEncoder();
  const entries: Array<[string, Uint8Array]> = [
    ['meta', enc.encode(JSON.stringify({ ...meta, exitCode: out.exitCode, durationMs, ...(thumb ? { thumb: { w: thumb.w, h: thumb.h } } : {}) }))],
    ['log', enc.encode(out.log)],
    ['transcript', enc.encode(out.transcript)],
  ];
  if (out.blg) entries.push(['blg', enc.encode(out.blg)]);
  if (out.pdf) entries.push(['pdf', out.pdf]);
  if (out.synctex) entries.push(['synctex', out.synctex]);
  if (thumb) entries.push(['thumb', thumb.jpeg]);
  return getJson<CompileResult>(`/api/projects/${projectId}/compile/publish`, {
    method: 'POST',
    headers: { 'content-type': BUNDLE_TYPE },
    body: new Blob([encodeBundle(entries) as BlobPart]),
  });
}

// ---- publishing ----

/** Whether this tab is the one of its branch that publishes (Editor sets it
 *  from the branch's roster); a lone tab is. */
let isPublisher: () => boolean = () => true;
export function setPublisher(fn: () => boolean): void { isPublisher = fn; }

const publishState = new Map<string, { pending: LocalRun | null; lastAt: number; lastInputs: string; timer: ReturnType<typeof setTimeout> | null; refused: boolean }>();

function schedulePublish(run: LocalRun): void {
  if (!run.final || run.out.exitCode !== 0 || !run.out.pdf) return;
  const key = `${run.projectId}::${run.branch}`;
  const st = publishState.get(key) ?? { pending: null, lastAt: 0, lastInputs: '', timer: null, refused: false };
  publishState.set(key, st);
  if (st.refused || run.inputs === st.lastInputs) return;
  st.pending = run;
  if (st.timer) return;
  const wait = Math.max(0, st.lastAt + PUBLISH_EVERY_MS - Date.now());
  st.timer = setTimeout(async () => {
    st.timer = null;
    const next = st.pending;
    st.pending = null;
    if (!next || !next.out.pdf || !isPublisher() || next.inputs === st.lastInputs) return;
    st.lastAt = Date.now();
    try {
      await upload(next.projectId, { branch: next.branch, rootFile: next.rootFile, draft: next.draft, runId: next.runId }, next.out, next.durationMs);
      st.lastInputs = next.inputs;
    } catch (err) {
      // A viewer may typeset here but not publish; nothing to retry.
      if (err instanceof ApiError && (err.status === 403 || err.status === 401)) st.refused = true;
    }
    if (st.pending) schedulePublish(st.pending);
  }, wait);
}

// ---- the editor's entry points (api.ts) ----

/** The run's PDF stays in memory while it is shown; older ones are let go. */
function remember(run: LocalRun): void {
  localRuns.set(run.runId, run);
  const mine = [...localRuns.values()].filter((r) => r.projectId === run.projectId && r.branch === run.branch);
  for (const old of mine.slice(0, -3)) { URL.revokeObjectURL(old.url); localRuns.delete(old.runId); }
}

/** A typeset in this browser, shown from memory; resolves like POST /compile.
 *  A failure that is not the server's answer still reads as a run that says
 *  what went wrong, never as a bare "failed". */
export async function typesetHere(projectId: string, branch: string, opts: { draft?: boolean } = {}): Promise<CompileResult> {
  try {
    return await typesetHereInner(projectId, branch, opts);
  } catch (err: any) {
    if (err instanceof ApiError) throw err;
    const message = `Typesetting in this browser failed: ${err?.message ?? err}`;
    return { ok: false, pdf: null, pdfUrl: null, log: message, errors: [{ type: 'error', line: null, message }], durationMs: 0, error: message };
  }
}

async function typesetHereInner(projectId: string, branch: string, opts: { draft?: boolean }): Promise<CompileResult> {
  const snap = await getJson<Snapshot>(`/api/projects/${projectId}/compile/snapshot?branch=${encodeURIComponent(branch)}`);
  const draft = !!opts.draft;
  let ran: { out: EngineOutput; durationMs: number };
  try {
    ran = await engineRun(projectId, snap, draft);
  } catch (err: any) {
    if (err?.stopped) return { ok: false, stopped: true, pdf: null, pdfUrl: null, log: '', errors: [], durationMs: 0 };
    throw err;
  }
  const { out, durationMs } = ran;
  const parsed = await getJson<{ ok: boolean; errors: CompileResult['errors']; log: string; needsFullRun?: boolean; pages?: number }>('/api/typeset/parse', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ log: out.log || out.transcript, blg: out.blg || undefined, rootFile: snap.rootFile, exitCode: out.exitCode, pdf: !!out.pdf, draft }),
  });
  const runId = snap.runId ?? Date.now();
  const outPdf = `${snap.rootFile.includes('/') ? `${snap.rootFile.slice(0, snap.rootFile.lastIndexOf('/'))}/` : ''}.aldine-out/${snap.rootFile.replace(/^.*\//, '').replace(/\.tex$/i, '')}.pdf`;
  // A run that stopped at an error keeps the previous PDF on screen: the
  // Editor shows the last good one when this one has none.
  if (!out.pdf) {
    const lastGood = [...localRuns.values()].reverse().find((r) => r.projectId === projectId && r.branch === branch);
    return {
      ok: false, pdf: null, log: parsed.log, errors: parsed.errors, durationMs, runId,
      pdfUrl: lastGood?.url ?? null,
      ...(lastGood ? { pdfStale: true, compileId: lastGood.runId } : {}),
      ...(draft ? { draft: true } : {}),
    };
  }
  const url = URL.createObjectURL(new Blob([out.pdf as BlobPart], { type: 'application/pdf' }));
  const inputs = JSON.stringify([snap.rootFile, snap.engine, snap.files.map((f) => [f.path, f.key])]);
  // A draft that owes no full run is the document as a full run would make it.
  const final = !draft || !parsed.needsFullRun;
  const run: LocalRun = { projectId, branch, rootFile: snap.rootFile, draft, final, runId, out, files: new Set(snap.files.map((f) => f.path)), inputs, url, durationMs };
  remember(run);
  schedulePublish(run);
  return {
    ok: parsed.ok,
    pdf: outPdf,
    pdfUrl: url,
    compileId: runId,
    runId,
    synctex: out.synctex ? outPdf.replace(/\.pdf$/, '.synctex.gz') : null,
    log: parsed.log,
    errors: parsed.errors,
    durationMs,
    ...(parsed.pages !== undefined ? { pages: parsed.pages } : {}),
    ...(draft ? { draft: true, needsFullRun: !!parsed.needsFullRun } : {}),
  } as CompileResult;
}

let claimedRunning: { projectId: string; branch: string } | null = null;

/** The branch's waiting run (an agent's, an API caller's), typeset here and
 *  published at once; false when another tab took it. */
export async function claimBrowserJob(projectId: string, branch: string): Promise<boolean> {
  if (!(await typesetsHere())) return false;
  const res = await fetch(withBase(`/api/projects/${projectId}/compile/jobs/claim`), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ branch }) });
  if (!res.ok) return false;
  const { job } = (await res.json()) as { job: ClaimedJob };
  claimedRunning = { projectId, branch };
  try {
    const { out, durationMs } = await engineRun(projectId, job, job.draft);
    await upload(projectId, { jobId: job.id }, out, durationMs);
  } catch (err: any) {
    if (!err?.stopped) throw err;
  } finally {
    claimedRunning = null;
  }
  return true;
}

/** Ends this tab's typeset; a claimed run is also ended on the server, whose caller waits for it. */
export async function stopHere(projectId: string, branch: string): Promise<boolean> {
  const claimed = claimedRunning?.projectId === projectId && claimedRunning.branch === branch;
  stopEngine();
  return claimed;
}

/** SyncTeX for the PDF on screen: a run of this tab's from memory, a
 *  published one from its file on the server. */
export async function synctexHere(projectId: string, branch: string, payload: Record<string, unknown>): Promise<{ ok: boolean; records: Array<Record<string, number | string>> }> {
  const local = typeof payload.compileId === 'number' ? localRuns.get(payload.compileId) : undefined;
  if (local?.out.synctex) {
    return { ok: true, records: await synctexLookup(local.out.synctex, local.rootFile, local.files, payload) };
  }
  const snap = await getJson<Snapshot>(`/api/projects/${projectId}/compile/snapshot?branch=${encodeURIComponent(branch)}`);
  const gzPath = `${snap.rootFile.includes('/') ? `${snap.rootFile.slice(0, snap.rootFile.lastIndexOf('/'))}/` : ''}.aldine-out/${snap.rootFile.replace(/^.*\//, '').replace(/\.tex$/i, '')}.synctex.gz`;
  const res = await fetch(withBase(`/api/projects/${projectId}/output?branch=${encodeURIComponent(branch)}&path=${encodeURIComponent(gzPath)}`));
  if (!res.ok) throw new ApiError('No SyncTeX data — typeset first', 404);
  const gz = new Uint8Array(await res.arrayBuffer());
  return { ok: true, records: await synctexLookup(gz, snap.rootFile, new Set(snap.files.map((f) => f.path)), payload) };
}

export { typesetsHere };
