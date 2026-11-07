import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { branchDir } from '../store.js';
import { signalBrowserJob } from '../collab.js';
import { browserTexAssets } from './build.js';
import { ingestUpload, type Upload } from './ingest.js';
import { isHiddenPath } from '../util.js';

/**
 * Typesets that run in a browser (ALDINE_TYPESET=browser). A tab typesets
 * from a snapshot of the branch and shows its own PDF at once; now and then
 * it publishes a run, which compile.ts finishes as if the compiler had
 * answered, so the PDF route, thumbnails, collaborators without TeX and the
 * agent see it. A run nobody's browser asked for (an agent's, an API
 * caller's) waits on the branch's signal doc for an open tab to claim it.
 */

/** A file of the branch as the browser must see it; `key` changes whenever the
 *  bytes may have, so the browser can keep files across runs. */
export interface JobFile { path: string; size: number; key: string }

/** What a browser typesets from: the branch as it is on disk once its open
 *  documents are flushed. */
export interface Snapshot {
  branch: string;
  rootFile: string;
  engine: string;
  haltOnError: boolean;
  files: JobFile[];
  /** The run's id should it be published (compile.ts reserveRunId). */
  runId?: number;
}

/** A waiting run, as the tab that claims it gets it. */
export interface BrowserJobSpec extends Snapshot { id: string; draft: boolean }

/** A run a browser typeset, handed to compile.ts to finish. */
export interface BrowserOutput { upload: Upload; rootFile: string; draft: boolean; runId?: number }

/** What the compiler's /compile answers (apps/compiler/server.js). */
export interface RawResult {
  ok: boolean;
  timedOut?: boolean;
  stopped?: boolean;
  exitCode?: number;
  pdf?: string | null;
  pdfFresh?: boolean;
  synctex?: string | null;
  synctexFresh?: boolean;
  log?: string;
  errors?: unknown[];
  durationMs?: number;
  error?: string;
  draft?: boolean;
  needsFullRun?: boolean;
}

type State = 'open' | 'claimed' | 'uploading';

interface Job {
  spec: BrowserJobSpec;
  projectId: string;
  key: string;
  state: State;
  timer: NodeJS.Timeout;
  finish: (raw: RawResult) => void;
  /** Settled with the run's CompileResult once compile.ts has finished it. */
  outcome: Promise<unknown>;
  settle: (result: unknown, failed?: boolean) => void;
}

const CLAIM_MS = Number(process.env.ALDINE_BROWSER_CLAIM_MS || 20_000);
const RUN_MS = Number(process.env.ALDINE_BROWSER_TYPESET_TIMEOUT_MS || 300_000);
const MAX_FILES = 5_000;
const MAX_BYTES = Number(process.env.ALDINE_BROWSER_TYPESET_MAX_BYTES || 256 * 1024 * 1024);

const jobs = new Map<string, Job>();
/** compile.ts serializes runs per project::branch, so at most one job of a
 *  branch waits for its outcome at a time. */
const byKey = new Map<string, Job>();

const failed = (error: string, extra: Partial<RawResult> = {}): RawResult => ({ ok: false, log: '', errors: [], durationMs: 0, error, ...extra });

/** Every file of the checkout a typeset can read: all but git's and earlier output. */
export function listJobFiles(dirAbs: string): JobFile[] {
  const out: JobFile[] = [];
  let bytes = 0;
  const walk = (rel: string) => {
    for (const ent of fs.readdirSync(path.join(dirAbs, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${ent.name}` : ent.name;
      // What GET /api/projects/:id/file serves, which is how the browser reads them.
      if (isHiddenPath(p)) continue;
      if (ent.isDirectory()) { walk(p); continue; }
      // A symbolic link could name a file outside the project; the compiler
      // refuses those too.
      if (!ent.isFile()) continue;
      const st = fs.statSync(path.join(dirAbs, p));
      bytes += st.size;
      if (out.length >= MAX_FILES || bytes > MAX_BYTES) throw new Error(`This project is too large to typeset in the browser (over ${MAX_FILES} files or ${Math.round(MAX_BYTES / 1048576)} MB)`);
      out.push({ path: p, size: st.size, key: `${st.size}:${Math.floor(st.mtimeMs)}` });
    }
  };
  walk('');
  return out;
}

export interface RunInput {
  projectId: string;
  branch: string;
  rootFile: string;
  engine: string;
  haltOnError: boolean;
  draft: boolean;
}

/**
 * The raw result of a browser's typeset: the published output when there is
 * one, else whatever the tab that claims the run uploads. Never rejects:
 * every way a run can fail is a failed result.
 */
export function browserRun(input: RunInput, output?: BrowserOutput): Promise<RawResult> {
  if (output) {
    try {
      return Promise.resolve(ingestUpload(input.projectId, { branch: input.branch, rootFile: output.rootFile, draft: output.draft }, output.upload));
    } catch (err: any) {
      return Promise.resolve(failed(`The typeset output could not be stored: ${err.message}`));
    }
  }
  const assets = browserTexAssets().state();
  if (assets.state === 'downloading') {
    const pct = assets.total ? ` (${Math.round(100 * assets.done / assets.total)}%)` : '';
    return Promise.resolve(failed(`TeX for the browser is still being prepared on the server${pct}. Try again in a minute.`));
  }
  if (assets.state === 'failed') return Promise.resolve(failed(`The server could not prepare TeX for the browser: ${assets.error}`));
  let files: JobFile[];
  try { files = listJobFiles(branchDir(input.projectId, input.branch)); } catch (err: any) { return Promise.resolve(failed(err.message)); }

  const key = `${input.projectId}::${input.branch}`;
  const spec: BrowserJobSpec = {
    id: crypto.randomBytes(12).toString('hex'),
    branch: input.branch,
    rootFile: input.rootFile,
    engine: input.engine || 'pdf',
    haltOnError: input.haltOnError,
    draft: input.draft,
    files,
  };
  return new Promise<RawResult>((resolve) => {
    let settle!: Job['settle'];
    const outcome = new Promise<unknown>((res, rej) => { settle = (r, bad) => (bad ? rej(r) : res(r)); });
    outcome.catch(() => { /* the uploader may be gone; nobody else waits */ });
    const job: Job = {
      spec, projectId: input.projectId, key, state: 'open',
      timer: undefined as unknown as NodeJS.Timeout,
      finish: (raw) => {
        clearTimeout(job.timer);
        jobs.delete(spec.id);
        resolve(raw);
      },
      outcome, settle,
    };
    job.timer = setTimeout(() => {
      if (job.state === 'open') job.finish(failed('No open Aldine tab could typeset this. Open the project in a browser and try again.'));
    }, CLAIM_MS);
    job.timer.unref();
    jobs.set(spec.id, job);
    byKey.set(key, job);
    signalBrowserJob(input.projectId, input.branch);
  });
}

/** The branch's waiting job, now claimed by the caller, or null. */
export function claimJob(projectId: string, branch: string): BrowserJobSpec | null {
  const job = byKey.get(`${projectId}::${branch}`);
  if (!job || job.state !== 'open' || !jobs.has(job.spec.id)) return null;
  job.state = 'claimed';
  clearTimeout(job.timer);
  job.timer = setTimeout(() => job.finish(failed('The browser did not finish typesetting in time', { timedOut: true })), RUN_MS);
  job.timer.unref();
  return job.spec;
}

/**
 * Hands a claimed run's upload to compile.ts and resolves with what it made
 * of it. The job leaves the claimed state first, so a stop that arrives while
 * the output is written no longer applies to it.
 */
export async function completeJob(projectId: string, id: string, upload: Upload): Promise<unknown> {
  const job = jobs.get(id);
  if (!job || job.projectId !== projectId || job.state !== 'claimed') return null;
  job.state = 'uploading';
  clearTimeout(job.timer);
  let raw: RawResult;
  try { raw = ingestUpload(projectId, job.spec, upload); } catch (err: any) { raw = failed(`The typeset output could not be stored: ${err.message}`); }
  job.finish(raw);
  return job.outcome;
}

/** compile.ts calls this with each finished run of a branch in browser mode. */
export function settleBrowserJob(key: string, result: unknown, failedRun = false): void {
  const job = byKey.get(key);
  if (!job || jobs.has(job.spec.id)) return;
  byKey.delete(key);
  job.settle(result, failedRun);
}

/** Ends the branch's waiting or running browser typeset, as the compiler's /stop does. */
export function stopBrowserJobs(projectId: string, branch: string): boolean {
  const job = byKey.get(`${projectId}::${branch}`);
  if (!job || !jobs.has(job.spec.id) || job.state === 'uploading') return false;
  job.finish(failed('', { stopped: true }));
  return true;
}
