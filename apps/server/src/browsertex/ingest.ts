import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { branchDir } from '../store.js';
import { thumbFiles, thumbVersion } from '../thumbnail.js';
import type { RawResult } from './jobs.js';

/**
 * A browser's typeset, stored where latexmk would have left it
 * (<root dir>/.aldine-out/<base>.*) and reported in the compiler's shape, so
 * everything that reads output from disk — the PDF route, SyncTeX, the
 * thumbnail, the agent's get_pdf_url — works unchanged.
 */

interface LogParsers {
  parseLog(log: string): ParsedError[];
  parseBibLog(log: string): ParsedError[];
  documentBodyReached(log: string): boolean;
  clipLog(log: string): string;
}
interface ParsedError { type: string; file?: string | null; line: number | null; message: string; context?: string }

// The compiler's parsers, so both modes report the same rows for the same
// log. server.js only listens when run directly.
let parsers: LogParsers | null = null;
function logParsers(): LogParsers {
  parsers ??= createRequire(import.meta.url)('../../../compiler/server.js') as LogParsers;
  return parsers;
}

/** apps/compiler/server.js DRAFT_RERUN_HINT. */
const DRAFT_RERUN_HINT = /Rerun to get|Label\(s\) may have changed|Please \(?re\)?run (Biber|BibTeX)|rerun LaTeX/i;
const MAX_THUMB_BYTES = 2 * 1024 * 1024;
const MAX_THUMB_SIDE = 4096;

export interface Upload {
  meta: { exitCode?: number; durationMs?: number; thumb?: { w?: number; h?: number } };
  pdf?: Buffer;
  synctex?: Buffer;
  log?: string;
  blg?: string;
  /** The engine's console transcript, the only account of a run that died before writing a log. */
  transcript?: string;
  thumb?: Buffer;
}

function writeAtomic(file: string, data: Buffer | string): void {
  const tmp = `${file}.upload.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/**
 * TeX names the files it read relative to the root file's directory; the
 * editor wants them relative to the project, and an error inside generated
 * output is no place the user can go (as the compiler reports it).
 */
export function projectRelative(errors: ParsedError[], rootDir: string): ParsedError[] {
  for (const e of errors) {
    if (typeof e.file !== 'string' || !e.file || e.file.startsWith('/')) continue;
    const rel = path.posix.normalize(path.posix.join(rootDir, e.file));
    if (rel.startsWith('../')) continue;
    e.file = rel;
    if (rel.split('/').includes('.aldine-out')) {
      e.message = `${path.posix.basename(rel)} (generated)${e.line != null ? ` line ${e.line}` : ''}: ${e.message}`;
      e.file = null;
      e.line = null;
    }
  }
  const seen = new Set<string>();
  return errors.filter((e) => {
    const key = `${e.type}\u0000${e.file ?? ''}\u0000${e.line ?? ''}\u0000${e.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface ParsedRun { ok: boolean; errors: ParsedError[]; log: string; needsFullRun?: boolean }

/**
 * The rows, verdict and clipped log of a run, as the compiler reports them:
 * for a run a browser shows itself (POST /api/typeset/parse) and for one it
 * publishes, so both read the same.
 */
export function parseRun(input: { log: string; blg?: string; rootFile: string; exitCode: number; pdf: boolean; draft: boolean }): ParsedRun {
  const { parseLog, parseBibLog, documentBodyReached, clipLog } = logParsers();
  const rootDir = path.posix.dirname(input.rootFile) === '.' ? '' : path.posix.dirname(input.rootFile);
  const errors = parseLog(input.log);
  if (input.blg && documentBodyReached(input.log)) errors.push(...parseBibLog(input.blg));
  const rows = projectRelative(errors, rootDir);
  const ok = input.exitCode === 0 && input.pdf;
  if (!ok && !rows.some((e) => e.type === 'error')) {
    rows.push({ type: 'error', line: null, message: input.pdf ? `TeX stopped with exit code ${input.exitCode}` : 'TeX produced no PDF — see the log for why' });
  }
  return { ok, errors: rows, log: clipLog(input.log), ...(input.draft ? { needsFullRun: ok && DRAFT_RERUN_HINT.test(input.log) } : {}) };
}

export function ingestUpload(projectId: string, spec: { branch: string; rootFile: string; draft: boolean }, up: Upload): RawResult {
  const root = spec.rootFile;
  const rootDir = path.posix.dirname(root) === '.' ? '' : path.posix.dirname(root);
  const base = path.posix.basename(root).replace(/\.tex$/i, '');
  const outRel = path.posix.join(rootDir, '.aldine-out');
  const outAbs = path.join(branchDir(projectId, spec.branch), outRel);
  fs.mkdirSync(outAbs, { recursive: true });
  const rel = (name: string) => path.posix.join(outRel, name);
  const at = (name: string) => path.join(outAbs, name);

  const exitCode = Number.isInteger(up.meta.exitCode) ? up.meta.exitCode! : 1;
  const pdfOk = !!up.pdf && up.pdf.subarray(0, 5).toString('latin1') === '%PDF-';
  // gzip magic: a SyncTeX file the lookup can open.
  const synctexOk = !!up.synctex && up.synctex[0] === 0x1f && up.synctex[1] === 0x8b;
  const log = up.log || up.transcript || '';
  writeAtomic(at(`${base}.log`), log);
  if (up.blg) writeAtomic(at(`${base}.blg`), up.blg);
  if (pdfOk) writeAtomic(at(`${base}.pdf`), up.pdf!);
  if (synctexOk) writeAtomic(at(`${base}.synctex.gz`), up.synctex!);
  if (pdfOk && up.thumb) storeThumb(at, base, up.thumb, up.meta.thumb, at(`${base}.pdf`));

  const parsed = parseRun({ log, blg: up.blg, rootFile: root, exitCode, pdf: pdfOk, draft: spec.draft });
  return {
    ok: parsed.ok,
    timedOut: false,
    exitCode,
    pdf: fs.existsSync(at(`${base}.pdf`)) ? rel(`${base}.pdf`) : null,
    pdfFresh: pdfOk,
    synctex: fs.existsSync(at(`${base}.synctex.gz`)) ? rel(`${base}.synctex.gz`) : null,
    synctexFresh: synctexOk,
    log: parsed.log,
    errors: parsed.errors,
    durationMs: Number.isFinite(up.meta.durationMs) ? Math.max(0, Math.round(up.meta.durationMs!)) : 0,
    ...(spec.draft ? { draft: true, needsFullRun: !!parsed.needsFullRun } : {}),
  };
}

/** Page 1 as the compiler's thumbnail.js leaves it, for the project list. */
function storeThumb(at: (name: string) => string, base: string, jpeg: Buffer, dims: Upload['meta']['thumb'], pdfAbs: string): void {
  const side = (n: unknown): n is number => Number.isInteger(n) && (n as number) > 0 && (n as number) <= MAX_THUMB_SIDE;
  if (jpeg.length > MAX_THUMB_BYTES || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[2] !== 0xff) return;
  if (!side(dims?.w) || !side(dims?.h)) return;
  const files = thumbFiles(`${base}.tex`);
  const jpg = at(path.posix.basename(files.jpg));
  const json = at(path.posix.basename(files.json));
  const st = fs.statSync(pdfAbs);
  writeAtomic(jpg, jpeg);
  writeAtomic(json, JSON.stringify({ v: thumbVersion(jpeg), w: dims.w, h: dims.h, pdf: { size: st.size, mtimeMs: st.mtimeMs } }));
}
