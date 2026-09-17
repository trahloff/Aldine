import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { config } from '../config.js';
import * as store from '../store.js';
import * as gitops from '../gitops.js';
import * as usage from '../usage.js';
import { compileProject, outputOnDisk, type CompileError } from '../compile.js';
import { signOutputUrl, OUTPUT_URL_TTL_S } from '../output-signing.js';
import {
  flushBranchDocs, refreshBranchDocsFromDisk, contentVersion, fileVersion, versionConflict,
  commitAgentWrite, applySuggestionToDoc, openDocContent, markAgentPresence, signalAgentWrite, AGENT_ORIGIN,
} from '../collab.js';
import { compileGate, compileLimiter, agentCompileGate, refLimiter } from '../ratelimit.js';
import { looksBinary, rootSiblingPath, cleanCommitMessage, COMMIT_MESSAGE_MAX } from '../util.js';
import { isListed, isOwner } from '../authz.js';
import { addReference } from '../references.js';
import { bibIndex, labelIndex, wordCount } from '../indexes.js';
import { adoptRootIfUnset } from '../root.js';
import { listAllTemplates, resolveTemplateSeed, type TemplateSeed } from '../templates.js';
import { trashProject, restorableUntil, TRASH_DAYS } from '../trash.js';
import {
  McpDenied, projectNotFound, resolveProject, assertWritableProject, compileKey, assertFileTarget, isDirectoryPath, visiblePath, diskSpelling, type McpIdentity,
} from './guards.js';

/**
 * The MCP tool registry, shared verbatim by the HTTP and stdio transports.
 * Tools are added HERE and only here — transport and auth (server.ts,
 * guards.ts) must not need edits when the tool surface grows. Each server
 * instance is per-request (stateless HTTP) or per-process (stdio), so
 * closing over `identity` is safe.
 *
 * Surface is the 8 tools of spec 1.3 (names are API), the 5 wrappers of
 * spec 2.1 (references_add, list_citations, list_labels, wordcount,
 * create_project), get_pdf_url, trash_project (the one exception to the
 * no-destructive-tools rule: a soft trash of projects the agent itself
 * created, owner only), plus the ping reachability check. Deliberately absent
 * (threat model rank #1 — the tools must not exist server-side): purge,
 * share management, GitHub push, token management, branch create/merge.
 *
 * Descriptions are the model's only API docs and cost context on every call:
 * each states when to call the tool, what the result means, and what to do on
 * failure (retry etiquette or relay to the user) — nothing else.
 */

// ---------------------------------------------------------------------------
// Pure edit-resolution helpers (exported for unit tests)
// ---------------------------------------------------------------------------

export interface EditSpec { quote: string; replacement: string; occurrence?: number }
/** `occurrence` is set on the candidates of an ambiguous quote: the value that picks that line. */
export interface AnchorCandidate { line: number; text: string; occurrence?: number }
/** stale_anchor: the quote is not in the file (re-read); ambiguous_anchor: it
 *  is, more than once, or `occurrence` is out of range (resend with the right
 *  occurrence — no re-read needed). */
export type ResolveEditsResult =
  | { ok: true; ranges: Array<{ from: number; to: number }> }
  | { ok: false; error: 'invalid_quote' | 'stale_anchor' | 'ambiguous_anchor'; editIndex: number; reason: string; candidates: AnchorCandidate[] };

/** Shorter quotes ("}", "\\item") match all over a LaTeX file — too dangerous to anchor on. */
export const MIN_QUOTE_LEN = 8;

/** Hard stop for occurrence scanning so a 1-char-times-100k pathological quote can't spin. */
const MAX_OCCURRENCE_SCAN = 200;

function lineOfOffset(content: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < offset && i < content.length; i++) if (content[i] === '\n') n++;
  return n;
}

function bigrams(s: string): Set<string> {
  const t = s.toLowerCase();
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

function dice(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  return (2 * inter) / (a.size + b.size);
}

/** Candidate texts are capped at this many characters, centred on the match. */
const CANDIDATE_CHARS = 200;

/** Up to CANDIDATE_CHARS of `line` around [at, at+len): a paragraph-per-line
 *  source puts the quote past column 200, where a line-start slice never
 *  reaches it. Cuts are marked so the model does not anchor on a torso. */
function excerpt(line: string, at: number, len: number): string {
  if (line.length <= CANDIDATE_CHARS) return line.trim();
  const pad = Math.max(0, Math.floor((CANDIDATE_CHARS - len) / 2));
  let start = Math.max(0, at - pad);
  const end = Math.min(line.length, start + CANDIDATE_CHARS);
  start = Math.max(0, end - CANDIDATE_CHARS);
  return (start > 0 ? '…' : '') + line.slice(start, end).trim() + (end < line.length ? '…' : '');
}

/** ≤`max` lines most similar to the missing quote — the model re-anchors from
 *  these instead of re-reading the whole file blind. Scored by bigram Dice of
 *  the quote's first non-empty line against the best quote-sized window of
 *  each line (a whole-line score buries a near-match inside a long paragraph
 *  under the paragraph's other bigrams), and the text is that window. */
export function nearestCandidates(content: string, quote: string, max = 3): AnchorCandidate[] {
  const probe = (quote.split('\n').find((l) => l.trim()) || quote).trim();
  const probeGrams = bigrams(probe);
  if (!probeGrams.size) return [];
  const scored: Array<AnchorCandidate & { score: number }> = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let best = { score: dice(bigrams(line.trim()), probeGrams), at: 0 };
    if (line.length > probe.length) {
      const step = Math.max(1, Math.floor(probe.length / 4));
      for (let at = 0; at <= line.length - probe.length; at += step) {
        const s = dice(bigrams(line.slice(at, at + probe.length)), probeGrams);
        if (s > best.score) best = { score: s, at };
      }
    }
    if (best.score > 0.2) scored.push({ line: i + 1, text: excerpt(line, best.at, probe.length), score: best.score });
  }
  scored.sort((a, b) => b.score - a.score || a.line - b.line);
  return scored.slice(0, max).map(({ line, text }) => ({ line, text }));
}

/** The lines of the first `max` hits, each excerpt centred on its hit and
 *  carrying the `occurrence` that selects it. */
function candidatesAt(content: string, hits: number[], quoteLen: number, max = 3): AnchorCandidate[] {
  const out: AnchorCandidate[] = [];
  const seen = new Set<number>();
  for (let n = 0; n < hits.length && out.length < max; n++) {
    const off = hits[n];
    const line = lineOfOffset(content, off);
    if (seen.has(line)) continue;
    seen.add(line);
    const lineStart = content.lastIndexOf('\n', off - 1) + 1;
    const lineEnd = content.indexOf('\n', off);
    const text = content.slice(lineStart, lineEnd === -1 ? content.length : lineEnd);
    out.push({ line, text: excerpt(text, off - lineStart, quoteLen), occurrence: n + 1 });
  }
  return out;
}

/**
 * Resolve every quote(+occurrence) to a {from,to} range against ONE content
 * snapshot. Any miss/ambiguity fails the whole batch (nothing gets applied) —
 * that is the stale_anchor contract the tool description teaches retry
 * etiquette for. Overlapping resolved ranges also fail: they cannot be
 * applied to a single snapshot without one edit destroying another's anchor.
 */
export function resolveEdits(content: string, edits: EditSpec[]): ResolveEditsResult {
  const ranges: Array<{ from: number; to: number }> = [];
  for (let i = 0; i < edits.length; i++) {
    const { quote, occurrence } = edits[i];
    if (typeof quote !== 'string' || quote.length < MIN_QUOTE_LEN) {
      return { ok: false, error: 'invalid_quote', editIndex: i, reason: `the quote must be at least ${MIN_QUOTE_LEN} characters (got ${typeof quote === 'string' ? quote.length : 0}) — quote more of the surrounding text`, candidates: [] };
    }
    const hits: number[] = [];
    let idx = content.indexOf(quote);
    while (idx >= 0 && hits.length < MAX_OCCURRENCE_SCAN) {
      hits.push(idx);
      idx = content.indexOf(quote, idx + 1);
    }
    if (hits.length === 0) {
      return { ok: false, error: 'stale_anchor', editIndex: i, reason: 'the quote is not in the file — re-read it and anchor on the current text (candidates are the nearest lines)', candidates: nearestCandidates(content, quote) };
    }
    let from: number;
    if (occurrence !== undefined) {
      if (!Number.isInteger(occurrence) || occurrence < 1 || occurrence > hits.length) {
        return { ok: false, error: 'ambiguous_anchor', editIndex: i, reason: `occurrence ${occurrence} is out of range — the quote appears ${hits.length} time(s); pick one of the candidates' occurrence values`, candidates: candidatesAt(content, hits, quote.length) };
      }
      from = hits[occurrence - 1];
    } else if (hits.length > 1) {
      return { ok: false, error: 'ambiguous_anchor', editIndex: i, reason: `the quote appears ${hits.length} times — resend with the occurrence of the candidate you mean (no re-read needed)`, candidates: candidatesAt(content, hits, quote.length) };
    } else {
      from = hits[0];
    }
    ranges.push({ from, to: from + quote.length });
  }
  const order = ranges.map((r, i) => ({ ...r, i })).sort((a, b) => a.from - b.from);
  for (let k = 1; k < order.length; k++) {
    if (order[k].from < order[k - 1].to) {
      return { ok: false, error: 'stale_anchor', editIndex: order[k].i, reason: `edit ${order[k].i + 1} overlaps edit ${order[k - 1].i + 1} — merge them into one edit`, candidates: [] };
    }
  }
  return { ok: true, ranges };
}

/** Apply resolved edits back-to-front so earlier offsets stay valid. */
export function spliceEdits(content: string, edits: EditSpec[], ranges: Array<{ from: number; to: number }>): string {
  const order = ranges.map((r, i) => ({ ...r, replacement: edits[i].replacement })).sort((a, b) => b.from - a.from);
  let out = content;
  for (const e of order) out = out.slice(0, e.from) + e.replacement + out.slice(e.to);
  return out;
}

/** ≤4 KB of the latexmk log — the full log is a ~200 KB context bomb the
 *  spec forbids returning. The window starts a few lines before the first
 *  error (the "l.<n>" line and the token it names sit right after it) and
 *  falls back to the literal tail when there is no error or it is already
 *  in the tail; a long run of warnings after the error must not push it
 *  out. Byte-capped (not chars) and stripped of a broken multi-byte
 *  sequence at either cut. */
export const LOG_TAIL_BYTES = 4096;
const LOG_TAIL_LEAD_BYTES = 512;
export function logTail(log: string): string {
  const buf = Buffer.from(log, 'utf8');
  if (buf.length <= LOG_TAIL_BYTES) return log;
  const first = log.search(/^(?:(?:\.\/)?[^:\n\s][^:\n]*\.\w+:\d+: |! )/m);
  const firstAt = first >= 0 ? Buffer.byteLength(log.slice(0, first), 'utf8') : -1;
  let start = buf.length - LOG_TAIL_BYTES;
  if (firstAt >= 0 && firstAt < start) {
    // back up to a line start so the window opens on a whole line
    start = Math.max(0, buf.lastIndexOf(0x0a, Math.max(0, firstAt - LOG_TAIL_LEAD_BYTES)) + 1);
  }
  return buf.subarray(start, start + LOG_TAIL_BYTES).toString('utf8').replace(/^�+|�+$/g, '');
}

/** ~100 KB read cap; larger files are read via from_line/to_line windows. */
const MAX_READ_BYTES = 100_000;

/** The file's bytes on disk, or null when it does not exist (a write creating it).
 *  Bytes, not text: a UTF-8 decode of a Latin-1 or binary file would put a
 *  U+FFFD-riddled copy into the pre-write snapshot, and reverting the Claude
 *  commit would restore that instead of the original. */
function diskContent(projectId: string, branch: string, rel: string): Buffer | null {
  try { return store.readFile(projectId, branch, rel); } catch { return null; }
}

/** The write tools' commit fields: `unchanged` says the write left the file as HEAD had it, as opposed to a refused commit. */
function commitFields(commit: { hash: string | null; unchanged: boolean }, head: string): { commit: string | null; unchanged?: true } {
  return { commit: commit.hash ? head : null, ...(commit.unchanged ? { unchanged: true as const } : {}) };
}

function snippetAround(content: string, offset: number): string {
  const lines = content.split('\n');
  const li = lineOfOffset(content, offset) - 1;
  let s = lines.slice(Math.max(0, li - 2), Math.min(lines.length, li + 3)).join('\n');
  if (s.length > 500) s = s.slice(0, 500) + '…';
  return s;
}

// ---------------------------------------------------------------------------
// PDF viewer (MCP App, spec §3.2 / SEP-1865)
// ---------------------------------------------------------------------------

/** The viewer's resource URI — API for hosts; the HTML behind it is apps/server/assets/pdf-viewer.html. */
export const PDF_VIEWER_URI = 'ui://aldine/pdf-viewer';
/** MIME the ext `io.modelcontextprotocol/ui` negotiates (ext-apps RESOURCE_MIME_TYPE). */
export const MCP_APP_MIME = 'text/html;profile=mcp-app';
/** Built, self-contained viewer page; same path from src/ and dist/. */
export const PDF_VIEWER_ASSET = process.env.ALDINE_PDF_VIEWER_HTML
  || fileURLToPath(new URL('../../assets/pdf-viewer.html', import.meta.url));

let viewerCache: { mtimeMs: number; html: string } | null = null;

/** The viewer HTML, re-read when the asset changes; null when it is not built. */
export function loadViewerHtml(): string | null {
  let st: fs.Stats;
  try { st = fs.statSync(PDF_VIEWER_ASSET); } catch { return null; }
  if (!viewerCache || viewerCache.mtimeMs !== st.mtimeMs) {
    viewerCache = { mtimeMs: st.mtimeMs, html: fs.readFileSync(PDF_VIEWER_ASSET, 'utf8') };
  }
  return viewerCache.html;
}

/** Sandbox CSP: exactly the instance origin, for the signed PDF fetch. */
function viewerCsp(publicBase: string): { connectDomains: string[] } | undefined {
  try { return { connectDomains: [new URL(publicBase).origin] }; } catch { return undefined; }
}

/** Parsed errors are capped so the result stays far under the ~150k-char
 *  limit past which hosts spill it to a file and the viewer never hydrates. */
export const MAX_RESULT_ERRORS = 50;
const MAX_ERROR_MESSAGE = 500;
/** Overfull/Underfull boxes are dropped (as the editor drops them) and errors
 *  are ranked ahead of warnings before the cap, so a long document's box
 *  warnings can never push the one fixable error out of the result. */
export function reportableErrors(errors: CompileError[]): CompileError[] {
  const rank = (e: CompileError) => (e.type === 'error' ? 0 : 1);
  return errors.filter((e) => e.type !== 'typesetting').sort((a, b) => rank(a) - rank(b));
}
function capErrors(errors: CompileError[]): CompileError[] {
  const cap = (s: string) => (s.length > MAX_ERROR_MESSAGE ? s.slice(0, MAX_ERROR_MESSAGE) + '…' : s);
  return errors.slice(0, MAX_RESULT_ERRORS).map((e) => ({ ...e, message: cap(e.message), ...(e.context ? { context: cap(e.context) } : {}) }));
}

/** Rows from the bibliography tool, which the log parser prefixes; they are
 *  located in a .bib (or nowhere), never in the file the engine was reading. */
const BIB_ROW = /^(Biber|BibTeX): /;

/** Every engine row names a file: the log parser leaves it empty when the
 *  engine failed before opening any input (a missing package at line 5 of
 *  the root file), and the "quote the failing file:line" etiquette and the
 *  viewer's deep links both need one. The engine was in the root file then.
 *  A bibliography row keeps the .bib and line biber reported, or no file at
 *  all — stamping the root file on it sent the model to main.tex for a
 *  problem in references.bib. */
export function withRootFile(errors: CompileError[], rootFile: string): CompileError[] {
  return errors.map((e) => (e.file || BIB_ROW.test(e.message) ? e : { ...e, file: rootFile }));
}

/** The tool that raised a row, taken off the front of the message: "LaTeX
 *  Warning: …" → latex, "Package hyperref Warning: …" → hyperref, "Class
 *  article Warning: …" → article, "Biber: …" → biber. Errors keep their
 *  message as the engine phrased it (the hints and the editor match on it). */
export function withSource(errors: CompileError[]): CompileError[] {
  return errors.map((e) => {
    const bib = e.message.match(BIB_ROW);
    if (bib) return { ...e, source: bib[1].toLowerCase(), message: e.message.slice(bib[0].length) };
    if (e.type !== 'warning') return e;
    const m = e.message.match(/^(?:(LaTeX)|(?:Package|Class) (\S+)) Warning:\s*/);
    return m ? { ...e, source: (m[1] || m[2]).toLowerCase(), message: e.message.slice(m[0].length) } : e;
  });
}

/** pdflatex cannot typeset a character inputenc has no macro for, and the
 *  row points at the .tex line where the text was expanded — for a .bib
 *  entry that is \printbibliography or \end{document}, not the entry. */
export function unicodeHint(errors: CompileError[]): string | null {
  const m = errors.map((e) => /Unicode character (\S+) \((U\+[0-9A-F]+)\)/.exec(e.message)).find(Boolean);
  if (!m) return null;
  return `The character ${m[1]} (${m[2]}) cannot be typeset with pdflatex. If it is in a .bib entry the error names the .tex line that prints the bibliography, not the entry — search the .bib files for it and remove or replace it there; otherwise replace it in the .tex, or ask the user to switch the project to xelatex or lualatex.`;
}

/** A `.sty` the engine could not find is a compiler install gap, not a
 *  document error: the model must relay it, not delete the \usepackage. */
export function missingPackages(errors: CompileError[]): string[] {
  const out = new Set<string>();
  for (const e of errors) {
    const m = /File [`'](.+?)\.sty' not found/.exec(e.message);
    if (m) out.add(m[1]);
  }
  return [...out];
}

/** The compiler refused before running TeX because it cannot see the
 *  project (its DATA_DIR is not the server's, or the volume is missing).
 *  Reported as a normal failed compile this reads as "main.tex is missing"
 *  and sends the model into a write loop on a healthy project. "root file
 *  not found" is also the compiler's answer when the project-wide root file
 *  simply is not on the compiled branch — the caller checks the server's own
 *  view of the branch before calling it a setup error. */
export function compilerSetupError(error: string | undefined): boolean {
  return !!error && /root file not found|invalid projectDir|projectDir escapes|ENOENT|no such file/i.test(error);
}

/** Directory segments of `rel` folded onto the spelling an earlier entry of
 *  the same batch gave them: the pre-write listing knows nothing about a
 *  directory the batch itself creates, so "Sec/a.tex" and "sec/b.tex" would
 *  otherwise become two directories on Linux and one on a Mac. */
export function foldOntoEarlier(rel: string, earlier: string[]): string {
  const segs = rel.split('/');
  for (let i = 0; i < segs.length - 1; i++) {
    const prefix = segs.slice(0, i + 1).join('/').toLowerCase();
    const match = earlier.map((e) => e.split('/')).find((es) => es.length > i + 1 && es.slice(0, i + 1).join('/').toLowerCase() === prefix);
    if (match) segs[i] = match[i];
  }
  return segs.join('/');
}

/** Options the transports pass in: the instance origin for absolute links
 *  and the viewer's CSP allowlist (ALDINE_PUBLIC_URL, else request-derived). */
export interface ToolContext { publicBase: string }

// ---------------------------------------------------------------------------
// Tool plumbing
// ---------------------------------------------------------------------------

type ToolResult = { content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

const ok = (body: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(body) }] });
/** Tools with a viewer: the app hydrates from structuredContent, the model reads the text. */
const okApp = (body: Record<string, unknown>): ToolResult => ({ ...ok(body), structuredContent: body });
const fail = (message: string): ToolResult => ({ content: [{ type: 'text', text: message }], isError: true });

/** Every result echoes {branch, head} so the model can narrate what it touched. */
async function echo(projectId: string, branch: string): Promise<{ branch: string; head: string }> {
  return { branch, head: await gitops.branchShortHead(projectId, branch) };
}

/** A git error text that means the branch does not exist (worktree add on a missing ref). */
const BRANCH_MISSING_RE = /bad branch name|not a valid ref|invalid reference|worktree/i;

const projectParam = z.string().optional().describe('Project id. Optional when the access token is scoped to exactly one project.');
const branchParam = z.string().optional().describe("Branch name (defaults to 'main'). Every result, error results included, echoes {branch, head} — head is the branch's current commit (after a write, the commit that write made). Pass the branch explicitly whenever you are not on main.");
const PATH_HELP = 'File path relative to the project root, e.g. "main.tex" or "sections/intro.tex" — no leading "/", no "..", and hidden folders (.git, .aldine-out) are off limits.';
const INTENT_HELP = `Commit message stating the intent of this change, imperative ("Tighten the abstract"), at most ${COMMIT_MESSAGE_MAX} characters. It titles the commit in the History panel; every call is one commit.`;
const messageParam = (what: string) => z.string()
  .min(1, `Message cannot be empty — state ${what} in one line`)
  .max(COMMIT_MESSAGE_MAX, `Message is at most ${COMMIT_MESSAGE_MAX} characters — state ${what} in one line`);
const BASE_VERSION_HELP = `contentVersion (or fileVersion) from your read of this file, or contentVersion from project_structure for a file you are creating. Refused with {error:"version_conflict", reason, currentVersion, fileVersion} when this file changed after that read (changes to other files on the branch do not count), or when base_version is newer than the branch's contentVersion (a server restart or another node issued it) — either way re-read the file and use the contentVersion that read returns.`;
const editShape = {
  quote: z.string().describe('Exact text to replace, copied verbatim from the file. At least 8 characters; must match exactly one place, or use occurrence.'),
  replacement: z.string().describe('Replacement text (empty string deletes the quote).'),
  occurrence: z.number().int().min(1).optional().describe('1-based occurrence to target when the quote appears more than once.'),
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export function registerTools(server: McpServer, identity: McpIdentity, ctx: ToolContext = { publicBase: config.publicUrl }): void {
  const base = ctx.publicBase.replace(/\/$/, '');
  const csp = viewerCsp(base);
  const resourceMeta = csp ? { ui: { csp } } : undefined;

  // The resource is always listed so the contract is stable; the tools point
  // at it only while the built asset exists AND the instance origin is known:
  // without ALDINE_PUBLIC_URL (stdio) pdfUrl and deepLink are root-relative,
  // which the sandbox would resolve against its own origin — a broken frame.
  // Either way the text result still carries the links.
  server.registerResource('pdf-viewer', PDF_VIEWER_URI, {
    title: 'Aldine PDF viewer',
    description: 'Renders the typeset PDF from a compile or get_pdf_url result inline (MCP App).',
    mimeType: MCP_APP_MIME,
    ...(resourceMeta ? { _meta: resourceMeta } : {}),
  }, async (uri) => {
    const html = loadViewerHtml();
    if (html === null) {
      throw new Error(`The PDF viewer is not built on this Aldine server (expected ${path.basename(PDF_VIEWER_ASSET)} under apps/server/assets — run the viewer build). The compile and get_pdf_url tools still return a PDF link.`);
    }
    return { contents: [{ uri: uri.href, mimeType: MCP_APP_MIME, text: html, ...(resourceMeta ? { _meta: resourceMeta } : {}) }] };
  });
  const uiMeta = loadViewerHtml() !== null && csp ? { _meta: { ui: { resourceUri: PDF_VIEWER_URI } } } : {};

  /** Guard failures become user-fixable prose (UX.md); a missing branch or
   *  project names what was asked and what exists; anything else stays
   *  generic so internals (paths, stack frames) never reach the model. */
  const toolError = async (err: unknown, ctx: { project?: string; branch?: string } = {}): Promise<ToolResult> => {
    if (err instanceof McpDenied) return fail(err.message);
    const msg = err instanceof Error ? err.message : String(err);
    if (BRANCH_MISSING_RE.test(msg)) {
      const id = ctx.project ?? (identity.tokenScope?.projectIds?.length === 1 ? identity.tokenScope.projectIds[0] : undefined);
      let branches: string[] = [];
      if (id) { try { branches = (await gitops.listBranches(id)).map((b) => b.name); } catch { /* the message still names the branch */ } }
      return fail(`No branch "${ctx.branch ?? ''}" in this project${branches.length ? ` — branches: ${branches.join(', ')}` : ''}`);
    }
    if (/project not found/i.test(msg)) return fail(projectNotFound(ctx.project ?? ''));
    console.warn(`[aldine] mcp tool failed: ${msg}`);
    return fail('The request failed on the Aldine server');
  };

  /** Result keys the viewer hydrates from — shared by compile and get_pdf_url. */
  const pdfResult = async (meta: store.ProjectMeta, branch: string, pdfRel: string | null, opts: { pdfStale: boolean; pages: number | null; t?: number; writtenAt?: number; truncated?: boolean }) => {
    const disk = outputOnDisk(meta.id, branch, meta.rootFile);
    // No PDF known for this run but one on disk (a failed run after a restart
    // emptied compile.ts's memory): it is some earlier run's, so it is stale —
    // unless this run halted while writing it, then it is nobody's to see.
    let rel = pdfRel ?? (disk && !opts.truncated ? disk.pdf : null);
    // A stale link points at nothing the user should see when its file is
    // gone (pdfTeX deletes the output of a halted run), was replaced by this
    // run's partial output, or was rewritten since it was last shown (another
    // node's halted run): no link at all rather than a 404 or a torso.
    if (rel && opts.pdfStale && (!disk || opts.truncated || (opts.writtenAt !== undefined && Date.parse(disk.typesetAt) > opts.writtenAt + 1))) rel = null;
    const onDisk = rel !== null && disk !== null && rel === disk.pdf;
    return {
      pdfUrl: rel ? signOutputUrl({ projectId: meta.id, branch, path: rel, base, t: opts.t }) : null,
      pdfFile: rel ? path.posix.basename(rel) : null,
      pdfStale: opts.pdfStale || !!opts.truncated || (pdfRel === null && rel !== null),
      // This run's count, else the log beside the linked file when the link is
      // this run's (an unchanged document recompiled: latexmk skipped the
      // engine and the log is the last run's); a stale link's log is a failed run's.
      pages: opts.pages ?? (onDisk && !opts.pdfStale ? disk.pages : null),
      typesetAt: onDisk ? disk.typesetAt : null,
      deepLink: `${base}/p/${meta.id}${branch !== 'main' ? `?branch=${encodeURIComponent(branch)}` : ''}`,
      project: meta.id,
      projectName: meta.name,
      ...(await echo(meta.id, branch)),
    };
  };

  server.registerTool('ping', {
    description: 'Check that the Aldine connector is reachable and authenticated. If it fails, tell the user their Aldine instance is not responding or the connector needs reconnecting — do not go on to other tools.',
    annotations: { readOnlyHint: true },
  }, async () => ok({ ok: true, server: 'aldine', user: identity.user?.email ?? null }));

  server.registerTool('list_projects', {
    description: 'List the LaTeX projects this token can reach: id, name, branches, rootFile, engine, agentCreated (true for projects made with create_project — the only ones trash_project accepts). Call it when you do not know the project id. A token scoped to one project makes the project argument optional everywhere.',
    annotations: { readOnlyHint: true },
  }, async () => {
    try {
      const scoped = identity.tokenScope?.projectIds;
      const metas = (await store.listProjects()).filter((m) =>
        !m.deletedAt && (!scoped || scoped.includes(m.id)) && isListed(m, identity.user));
      const out = [] as Array<{ id: string; name: string; branches: string[]; rootFile: string; engine: string; agentCreated: boolean }>;
      for (const m of metas) {
        let branches = ['main'];
        try { branches = (await gitops.listBranches(m.id)).map((b) => b.name); } catch { /* fresh repo — main only */ }
        out.push({ id: m.id, name: m.name, branches, rootFile: m.rootFile, engine: m.engine, agentCreated: m.createdVia === 'agent' });
      }
      return ok(out);
    } catch (err) { return toolError(err); }
  });

  server.registerTool('project_structure', {
    description: 'File tree of a project branch plus rootFile, engine, and contentVersion (pass it as base_version to edit_file, write_file or a batch_write entry — a write is refused only when its own file changed after that version). Call it before working in a project you have not read yet.',
    annotations: { readOnlyHint: true },
    inputSchema: { project: projectParam, branch: branchParam },
  }, async ({ project, branch = 'main' }) => {
    try {
      const meta = await resolveProject(identity, project);
      await gitops.ensureWorktree(meta.id, branch);
      flushBranchDocs(meta.id, branch);
      const files = store.listFiles(meta.id, branch).map((f) => ({ path: f.path, type: f.type, size: f.size, ...(f.type === 'file' ? { binary: !!f.binary } : {}) }));
      return ok({ files, rootFile: meta.rootFile, engine: meta.engine, contentVersion: contentVersion(meta.id, branch), ...(await echo(meta.id, branch)) });
    } catch (err) { return toolError(err, { project, branch }); }
  });

  server.registerTool('read_file', {
    description: 'Read a text file as the editor shows it right now (open documents are flushed first). Reads cap at ~100 KB — window larger files with from_line/to_line (1-based, inclusive; the result echoes the window it served, to_line clamped to the last line). Read before you edit: edit_file quotes must match this content verbatim. The result carries contentVersion (the branch version — pass it as base_version when you write this file) and fileVersion (the version at which this file itself last changed). Text is decided by content, not extension: a file with binary bytes is refused.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      project: projectParam,
      branch: branchParam,
      path: z.string().describe(PATH_HELP),
      from_line: z.number().int().min(1).optional(),
      to_line: z.number().int().min(1).optional(),
    },
  }, async ({ project, branch = 'main', path: rawPath, from_line, to_line }) => {
    try {
      const meta = await resolveProject(identity, project);
      await gitops.ensureWorktree(meta.id, branch);
      const rel = diskSpelling(meta.id, branch, visiblePath(rawPath));
      flushBranchDocs(meta.id, branch);
      if (isDirectoryPath(meta.id, branch, rel)) return fail(`"${rel}" is a folder on ${branch} — read_file serves files; project_structure lists what is inside it`);
      let buf: Buffer;
      try { buf = store.readFile(meta.id, branch, rel); } catch { return fail(`No file named "${rel}" on ${branch}`); }
      if (looksBinary(buf)) return fail(`"${rel}" is a binary file (not UTF-8 text) — read_file serves text only`);
      const text = buf.toString('utf8');
      const lines = text.split('\n');
      const totalLines = lines.length;
      let content = text;
      let window: { from_line: number; to_line: number } | undefined;
      if (from_line !== undefined || to_line !== undefined) {
        const from = from_line ?? 1;
        const to = Math.min(totalLines, to_line ?? totalLines);
        if (from > totalLines) return fail(`from_line ${from} is past the end — "${rel}" has ${totalLines} lines`);
        if (from > to) return fail(`from_line ${from} is after to_line ${to} — the window must run forwards`);
        content = lines.slice(from - 1, to).join('\n');
        window = { from_line: from, to_line: to };
      }
      if (Buffer.byteLength(content, 'utf8') > MAX_READ_BYTES) {
        return fail(`That read is ${Buffer.byteLength(content, 'utf8')} bytes — cap is ~100 KB. The file has ${totalLines} lines; read it in windows with from_line/to_line.`);
      }
      return ok({ content, totalLines, ...window, path: rel, contentVersion: contentVersion(meta.id, branch), fileVersion: fileVersion(meta.id, branch, rel), ...(await echo(meta.id, branch)) });
    } catch (err) { return toolError(err, { project, branch }); }
  });

  server.registerTool('edit_file', {
    description: 'Replace exact quoted text inside an existing file — the default way to change a document, and the only safe way to change one a person has open (edits merge with their live typing; write_file would discard it). Each quote: ≥8 characters, copied verbatim from a read, matching exactly one place (or set occurrence). Nothing is applied on any error result. {error:"stale_anchor"}: the quote is not in the file — re-read it, re-anchor from the candidates, retry; at most 2 retries, then tell the user what you tried and ask. {error:"ambiguous_anchor"}: the quote matches several places — the candidates carry the occurrence that picks each; resend with it, no re-read needed. {error:"version_conflict"}: this file changed after the read that base_version came from (writes to other files never conflict, so parallel tools on different files are safe) — re-read this file, then re-apply once. Committed as author Claude before the tool answers, under message (the intent, imperative — "Tighten the abstract"); without one the commit is titled "Edit <path>". The result\'s commit and head are that commit; an edit that leaves the file as it was makes no commit and answers commit:null with unchanged:true (nothing is pending).',
    inputSchema: {
      project: projectParam,
      branch: branchParam,
      path: z.string().describe(PATH_HELP),
      edits: z.array(z.object(editShape)).min(1).max(50),
      base_version: z.number().int().optional().describe(BASE_VERSION_HELP),
      message: messageParam('the intent of the change').optional().describe(INTENT_HELP),
    },
  }, async ({ project, branch = 'main', path: rawPath, edits, base_version, message }) => {
    try {
      const meta = await resolveProject(identity, project);
      assertWritableProject(meta.id);
      await gitops.ensureWorktree(meta.id, branch);
      const rel = diskSpelling(meta.id, branch, visiblePath(rawPath));
      if (isDirectoryPath(meta.id, branch, rel)) return fail(`"${rel}" is a folder on ${branch} — edit_file changes a file; name one inside it`);
      // One lock span from the checkpoint to the commit: an autosave that
      // fires meanwhile queues behind it and finds the write already
      // committed; one that was in flight before it has finished before the
      // checkpoint runs. Outside the lock, its `git add -A` could stage the
      // agent's delta as `aldine: autosave` (no Claude commit, no review).
      return await gitops.withRepoLock(meta.id, async () => {
        // Checkpoint the file's current state (flushed, so live typing counts)
        // before touching it: the attributed commit must carry only the agent's
        // delta, never a collaborator's uncommitted work in the same file.
        flushBranchDocs(meta.id, branch);
        await gitops.checkpointPathsHeld(meta.id, branch, [rel]);
        flushBranchDocs(meta.id, branch); // keystrokes that landed during the checkpoint
        // --- synchronous to the end of the apply: resolution and application see
        // one content snapshot, atomic against human keystrokes (no await); the
        // same snapshots are what the commit below is built from.
        // Error bodies carry the same {path, branch, head} echo as successes.
        const failed = async (body: object) => ok({ ...body, path: rel, contentVersion: contentVersion(meta.id, branch), ...(await echo(meta.id, branch)) });
        if (base_version !== undefined) {
          const conflict = versionConflict(meta.id, branch, rel, base_version);
          if (conflict) return failed(conflict);
        }
        const live = openDocContent(meta.id, branch, rel);
        let applied = 0;
        let before: string | Buffer;
        let newContent: string;
        let firstFrom: number;
        if (live !== null) {
          const res = resolveEdits(live, edits);
          if (!res.ok) {
            if (res.error === 'invalid_quote') return fail(`Edit ${res.editIndex + 1}: ${res.reason}`);
            return failed({ error: res.error, edit_index: res.editIndex, reason: res.reason, candidates: res.candidates });
          }
          // Presence first: the tint keys on the agent being in awareness when
          // the change arrives, so the first edit must not outrun it.
          markAgentPresence(meta.id, branch, rel);
          // Back-to-front, same tick: earlier offsets stay valid, and no human
          // keystroke can interleave. 'stale' from the CRDT apply is impossible
          // here by construction but handled defensively anyway.
          const order = res.ranges.map((r, i) => ({ ...r, edit: edits[i] })).sort((a, b) => b.from - a.from);
          for (const e of order) {
            const st = applySuggestionToDoc(meta.id, branch, rel, { from: e.from, to: e.to, quote: e.edit.quote }, e.edit.replacement, AGENT_ORIGIN);
            if (st !== 'applied') {
              return failed({ error: 'stale_anchor', edit_index: res.ranges.findIndex((r) => r.from === e.from), reason: 'the document changed while applying — re-read it and retry', applied, candidates: [] });
            }
            applied++;
          }
          signalAgentWrite(meta.id, branch);
          before = live;
          newContent = openDocContent(meta.id, branch, rel) ?? '';
          firstFrom = Math.min(...res.ranges.map((r) => r.from));
        } else {
          flushBranchDocs(meta.id, branch); // other files' docs may be open
          let raw: Buffer;
          try { raw = store.readFile(meta.id, branch, rel); } catch { return fail(`No file named "${rel}" on ${branch}`); }
          const current = raw.toString('utf8');
          const res = resolveEdits(current, edits);
          if (!res.ok) {
            if (res.error === 'invalid_quote') return fail(`Edit ${res.editIndex + 1}: ${res.reason}`);
            return failed({ error: res.error, edit_index: res.editIndex, reason: res.reason, candidates: res.candidates });
          }
          before = raw;
          newContent = spliceEdits(current, edits, res.ranges);
          markAgentPresence(meta.id, branch, rel);
          store.writeFile(meta.id, branch, rel, newContent);
          // Reseed rather than mark: a doc of this file that the registry
          // holds under another name would otherwise write the old text back
          // over the edit on its next store.
          refreshBranchDocsFromDisk(meta.id, branch, [rel]);
          signalAgentWrite(meta.id, branch);
          applied = edits.length;
          firstFrom = Math.min(...res.ranges.map((r) => r.from));
        }
        const commit = await commitAgentWrite(meta.id, branch, [{ path: rel, before, after: newContent }], cleanCommitMessage(message, `Edit ${rel}`));
        const e = await echo(meta.id, branch);
        return ok({ applied, path: rel, contentVersion: contentVersion(meta.id, branch), fileVersion: fileVersion(meta.id, branch, rel), snippet: snippetAround(newContent, firstFrom), ...commitFields(commit, e.head), ...e });
      });
    } catch (err) { return toolError(err, { project, branch }); }
  });

  server.registerTool('write_file', {
    description: 'Create a new file, or replace a whole file. For an existing file prefer edit_file — a whole-file write on an open document teleports collaborators\' viewports and can drop their in-flight typing. Pass base_version (contentVersion from a prior read of this file) to get {error:"version_conflict"} instead of overwriting newer content — only a change to this file conflicts, never one to another file; on conflict re-read and re-write once, then ask. Folders come into being with the first file written inside them. The first .tex written into a project with no main document becomes the main document (newRoot in the result). Committed as author Claude before the tool answers, under message (the intent, imperative); without one the commit is titled "Update <path>". The result\'s commit and head are that commit; content identical to the file makes no commit and answers commit:null with unchanged:true (nothing is pending).',
    inputSchema: {
      project: projectParam,
      branch: branchParam,
      path: z.string().describe(PATH_HELP),
      content: z.string(),
      base_version: z.number().int().optional().describe(BASE_VERSION_HELP),
      message: messageParam('the intent of the change').optional().describe(INTENT_HELP),
    },
  }, async ({ project, branch = 'main', path: rawPath, content, base_version, message }) => {
    try {
      const meta = await resolveProject(identity, project);
      assertWritableProject(meta.id);
      await gitops.ensureWorktree(meta.id, branch);
      const rel = diskSpelling(meta.id, branch, visiblePath(rawPath), { wholeFile: true });
      assertFileTarget(meta.id, branch, rel);
      // See edit_file: one lock span from the checkpoint to the commit,
      // and the attributed commit must carry only the agent's delta.
      return await gitops.withRepoLock(meta.id, async () => {
        flushBranchDocs(meta.id, branch);
        await gitops.checkpointPathsHeld(meta.id, branch, [rel]);
        flushBranchDocs(meta.id, branch); // keystrokes that landed during the checkpoint
        if (base_version !== undefined) {
          const conflict = versionConflict(meta.id, branch, rel, base_version);
          if (conflict) return ok({ ...conflict, path: rel, contentVersion: conflict.currentVersion, ...(await echo(meta.id, branch)) });
        }
        const before = openDocContent(meta.id, branch, rel) ?? diskContent(meta.id, branch, rel);
        markAgentPresence(meta.id, branch, rel);
        store.writeFile(meta.id, branch, rel, content);
        refreshBranchDocsFromDisk(meta.id, branch, [rel]);
        signalAgentWrite(meta.id, branch);
        const commit = await commitAgentWrite(meta.id, branch, [{ path: rel, before, after: content }], cleanCommitMessage(message, `Update ${rel}`));
        // Like PUT /file: a rootless project adopts its first .tex here, not
        // only at compile time — wordcount and project_structure answer for a
        // real root right after the write.
        const newRoot = await adoptRootIfUnset(meta.id, branch, rel);
        const e = await echo(meta.id, branch);
        return ok({ ok: true, path: rel, ...(newRoot ? { newRoot } : {}), contentVersion: contentVersion(meta.id, branch), fileVersion: fileVersion(meta.id, branch, rel), ...commitFields(commit, e.head), ...e });
      });
    } catch (err) { return toolError(err, { project, branch }); }
  });

  server.registerTool('batch_write', {
    description: 'Apply one multi-file change as ONE named commit (author Claude). Each entry carries full content (new files) or quote-anchored edits (existing files, same rules as edit_file). All edits resolve before anything is written — a stale_anchor or ambiguous_anchor writes nothing (the error names the entry as path); fix that entry and resend the whole batch. A version_conflict on any entry also writes nothing: re-read that file and resend. Use it for a coherent change across files; use edit_file for a single file. message = the intent, imperative ("Add related-work section"). The result\'s commit and head are that commit; a batch that leaves every file as it was makes no commit and answers commit:null with unchanged:true (nothing is pending).',
    inputSchema: {
      project: projectParam,
      branch: branchParam,
      files: z.array(z.object({
        path: z.string().describe(PATH_HELP),
        content: z.string().optional().describe('Full new file content (mutually exclusive with edits).'),
        edits: z.array(z.object(editShape)).min(1).max(50).optional().describe('Quote-anchored edits (mutually exclusive with content).'),
        base_version: z.number().int().optional().describe(`${BASE_VERSION_HELP} A conflict on any entry refuses the whole batch and writes nothing.`),
      })).min(1).max(50),
      message: messageParam('the intent of the change').describe(`Commit message stating the intent of the change, at most ${COMMIT_MESSAGE_MAX} characters.`),
    },
  }, async ({ project, branch = 'main', files: rawFiles, message }) => {
    try {
      const meta = await resolveProject(identity, project);
      assertWritableProject(meta.id);
      await gitops.ensureWorktree(meta.id, branch);
      // One entry per path: every entry resolves against the same pre-write
      // snapshot and the write loop is last-writer-wins, so a duplicate path
      // would silently discard the earlier entry's edits while reporting ok.
      // Keyed case-insensitively, and directories folded onto earlier
      // entries' spelling: two new entries differing only by case are one
      // file on a Mac and a checkout collision everywhere else.
      const files: Array<typeof rawFiles[number]> = [];
      const seenPaths = new Map<string, string>();
      for (const raw of rawFiles) {
        if ((raw.content === undefined) === (raw.edits === undefined)) {
          return fail(`files entry "${raw.path}" must carry exactly one of content or edits`);
        }
        const f = { ...raw, path: foldOntoEarlier(diskSpelling(meta.id, branch, visiblePath(raw.path), { wholeFile: raw.content !== undefined }), files.map((e) => e.path)) };
        if (raw.content !== undefined) assertFileTarget(meta.id, branch, f.path);
        const prev = seenPaths.get(f.path.toLowerCase());
        if (prev !== undefined) {
          return fail(prev === f.path
            ? `files lists "${f.path}" more than once — merge its changes into one entry`
            : `files lists "${prev}" and "${f.path}" more than once (same name, different case) — merge its changes into one entry`);
        }
        seenPaths.set(f.path.toLowerCase(), f.path);
        files.push(f);
      }
      // See edit_file: one lock span from the checkpoint through the batch's
      // own commit, so no autosave can stage the writes in between.
      return await gitops.withRepoLock(meta.id, async () => {
        flushBranchDocs(meta.id, branch);
        // See edit_file: the named commit must carry only the agent's delta.
        await gitops.checkpointPathsHeld(meta.id, branch, files.map((f) => f.path));
        flushBranchDocs(meta.id, branch); // keystrokes that landed during the checkpoint
        // --- synchronous from here to the end of the apply loop (see edit_file).
        // Resolve every edit BEFORE writing anything, so a stale anchor in
        // file N can't leave files 1..N-1 changed. An edits entry for a file
        // someone has open resolves against the live document and lands as
        // per-span CRDT edits, exactly as edit_file does — a reseed from disk
        // would replace the whole document under the person's cursor. Full
        // content, and files with no open doc, go to disk and reseed.
        const writes: Array<{ path: string; before: string | Buffer | null; next: string; live: Array<{ from: number; to: number; edit: EditSpec }> | null }> = [];
        // Error bodies name the entry as `path` and carry the {branch, head} echo like successes.
        const failed = async (entry: string, body: object) => ok({ ...body, path: entry, contentVersion: contentVersion(meta.id, branch), ...(await echo(meta.id, branch)) });
        for (const f of files) {
          if (f.base_version !== undefined) {
            const conflict = versionConflict(meta.id, branch, f.path, f.base_version);
            if (conflict) return failed(f.path, conflict);
          }
          const open = openDocContent(meta.id, branch, f.path);
          if (f.content !== undefined) {
            writes.push({ path: f.path, before: open ?? diskContent(meta.id, branch, f.path), next: f.content, live: null });
            continue;
          }
          if (isDirectoryPath(meta.id, branch, f.path)) return fail(`"${f.path}" is a folder on ${branch} — an edits entry changes a file; name one inside it`);
          let raw: Buffer | null = null;
          if (open === null) { try { raw = store.readFile(meta.id, branch, f.path); } catch { return fail(`No file named "${f.path}" on ${branch}`); } }
          const current = open ?? raw!.toString('utf8');
          const res = resolveEdits(current, f.edits!);
          if (!res.ok) {
            if (res.error === 'invalid_quote') return fail(`"${f.path}", edit ${res.editIndex + 1}: ${res.reason}`);
            return failed(f.path, { error: res.error, edit_index: res.editIndex, reason: res.reason, candidates: res.candidates });
          }
          const live = open !== null ? res.ranges.map((r, i) => ({ ...r, edit: f.edits![i] })).sort((a, b) => b.from - a.from) : null;
          writes.push({ path: f.path, before: raw ?? current, next: spliceEdits(current, f.edits!, res.ranges), live });
        }
        for (const w of writes) markAgentPresence(meta.id, branch, w.path);
        const reseed: string[] = [];
        for (const w of writes) {
          if (!w.live) { store.writeFile(meta.id, branch, w.path, w.next); reseed.push(w.path); continue; }
          for (const e of w.live) {
            const st = applySuggestionToDoc(meta.id, branch, w.path, { from: e.from, to: e.to, quote: e.edit.quote }, e.edit.replacement, AGENT_ORIGIN);
            if (st !== 'applied') return failed(w.path, { error: 'stale_anchor', edit_index: w.live.findIndex((x) => x.from === e.from), reason: 'the document changed while applying — re-read it and resend the batch', candidates: [] });
          }
          w.next = openDocContent(meta.id, branch, w.path) ?? w.next;
        }
        if (reseed.length) refreshBranchDocsFromDisk(meta.id, branch, reseed);
        signalAgentWrite(meta.id, branch);
        // Only the batch's own paths, from the snapshots above: the flush put
        // collaborators' live edits in OTHER files on disk too, and a
        // whole-tree commit would sign them as Claude (and expose them to the
        // session toast's revert). They reach history through the normal
        // autosave debounce instead.
        const commit = await commitAgentWrite(meta.id, branch, writes.map((w) => ({ path: w.path, before: w.before, after: w.next })), cleanCommitMessage(message, 'Update files'));
        // See write_file: the first .tex of a rootless project becomes the root.
        const firstTex = writes.find((w) => /\.tex$/i.test(w.path))?.path;
        const newRoot = firstTex ? await adoptRootIfUnset(meta.id, branch, firstTex) : undefined;
        const e = await echo(meta.id, branch);
        return ok({ ok: true, paths: writes.map((w) => w.path), ...(newRoot ? { newRoot } : {}), contentVersion: contentVersion(meta.id, branch), ...commitFields(commit, e.head), ...e });
      });
    } catch (err) { return toolError(err, { project, branch }); }
  });

  server.registerTool('compile', {
    description: `Typeset the project with latexmk: parsed errors [{type,file,line,message,context?,source?}] (type "error" rows before "warning" rows, first ${MAX_RESULT_ERRORS}; errorsTotal counts the errors and warningsTotal the warnings, whether or not the list was capped; box warnings are omitted; context is the source line the engine was reading, source the tool that raised a warning — latex, a package name, biber — and a biber row names the .bib and its line), on failure ≤4 KB of the log around the first error, pages, and a deep link into Aldine. With errors present the PDF is complete but the bibliography and cross-references are not rebuilt — say so. pdfUrl is a signed link to this run's PDF that anyone can open for ${OUTPUT_URL_TTL_S / 60} minutes — hand it to the user as the way to see the result, and call get_pdf_url for a fresh link later instead of recompiling. pdfStale:true means this run wrote no PDF: pdfUrl shows the previous one, or is null when that no longer exists. Takes up to ~2 minutes; progress notifications arrive while it runs. Compile after a coherent set of edits, not after each one, and never just to check syntax. On errors: fix and recompile at most 3 times, narrating each attempt ("attempt 2 of 3: added natbib"), then stop and ask the user, quoting the failing file:line. A project with no .tex file cannot be typeset: write the main document first. A compiler-not-responding, compiler-cannot-see-the-project, missing-package (hint), quota, or typeset-already-running error is for the user to act on — relay it, do not retry.`,
    inputSchema: { project: projectParam, branch: branchParam },
    ...uiMeta,
  }, async ({ project, branch = 'main' }, extra) => {
    let key: string | null = null;
    // Slots are released ONLY when their tryAcquire succeeded: a refusal path
    // releasing an unheld slot would decrement the gate under a compile that IS
    // running, letting a later agent call take both shared slots and starve the
    // human's compile (SECURITY.md risk #4).
    let agentSlot = false;
    let sharedSlot = false;
    const progress = extra._meta?.progressToken;
    let timer: NodeJS.Timeout | undefined;
    try {
      const meta = await resolveProject(identity, project);
      const user = identity.user;
      if (user && await usage.overQuota(user.id)) {
        return fail('Monthly typeset limit reached for this account — the plan quota resets next month');
      }
      key = compileKey(identity);
      if (compileLimiter && !(await compileLimiter.take(key))) {
        return fail('Typeset budget reached for this minute — try again shortly');
      }
      // Agent gate (1) before the shared gate (2): the agent can hold at most
      // one of the user's two slots, so the human always keeps one.
      if (!agentCompileGate.tryAcquire(key)) {
        return fail("An agent typeset is already running for this account — wait for it to finish");
      }
      agentSlot = true;
      if (!compileGate.tryAcquire(key)) {
        return fail('Too many typesets in flight — let the current ones finish');
      }
      sharedSlot = true;
      const started = Date.now();
      if (progress !== undefined) {
        // ~10 s cadence: keeps client tool-timeouts and the ALB 60 s idle
        // timeout alive through a long latexmk run.
        timer = setInterval(() => {
          const s = Math.round((Date.now() - started) / 1000);
          void extra.sendNotification({
            method: 'notifications/progress',
            params: { progressToken: progress, progress: s, message: `Typesetting ${meta.name} on ${branch} — ${s}s elapsed` },
          }).catch(() => { /* client gone; the compile result still lands */ });
        }, 10_000);
        timer.unref?.();
      }
      const result = await compileProject(meta.id, branch, { agent: true });
      // Re-read: a rootless project adopts its root inside compileProject, and
      // the root file is project-wide while the branch compiled may lack it.
      const compiled = await store.readMeta(meta.id).catch(() => meta);
      const rootFile = compiled.rootFile;
      if (!result.ok && compilerSetupError(result.error)) {
        if (/root file not found/i.test(result.error!) && !store.fileExists(meta.id, branch, rootFile)) {
          return fail(`The main document "${rootFile}" does not exist on ${branch} (the main document is set per project, not per branch) — create it there, or ask the user which file is the main document.`);
        }
        // Not a metric line: nothing was typeset, so it must not count as an
        // agent compile (deploy/README.md metric 1).
        console.log(`[aldine] agent compile could not start user=${user?.id ?? 'operator'} project=${meta.id} compiler=${result.error}`);
        return fail(`The compiler cannot see this project's files (it answered "${result.error}") — its DATA_DIR is not the server's, so the files exist but the compiler looks elsewhere. Relay this to the user; do not edit, rename or recreate files.`);
      }
      if (user) await usage.recordCompile(user.id, result.durationMs || 0);
      // Success-metric line (docs/plans/agent-api/00-overview.md): the only
      // record that a compile was agent-initiated — the quota meter counts
      // seconds per user with no agent/human or project dimension.
      console.log(`[metric] agent_compile user=${user?.id ?? 'operator'} project=${meta.id} ok=${result.ok} ms=${result.durationMs ?? 0}`);
      // result.pdfUrl is the cookie-auth path; the tool hands out the signed
      // form of the same artifact instead (the viewer has no cookie).
      const pdfRel = result.pdfUrl ? new URL(result.pdfUrl, 'http://x').searchParams.get('path') : null;
      const errors = withSource(withRootFile(reportableErrors(result.errors), rootFile));
      const missing = missingPackages(errors);
      const hints = [
        ...(missing.length ? [`Package${missing.length === 1 ? '' : 's'} ${missing.join(', ')} not installed on this compiler — relay to the user (a fuller TeX Live fixes it); do not remove the \\usepackage.`] : []),
        ...(unicodeHint(errors) ? [unicodeHint(errors)!] : []),
      ];
      return okApp({
        ok: result.ok,
        errors: capErrors(errors),
        errorsTotal: errors.filter((e) => e.type === 'error').length,
        warningsTotal: errors.filter((e) => e.type === 'warning').length,
        ...(hints.length ? { hint: hints.join(' ') } : {}),
        // A clean run's tail is font-loading noise; only a failed run needs it.
        logTail: result.ok ? '' : logTail(result.log),
        durationMs: result.durationMs,
        timedOut: !!result.timedOut,
        contentVersion: contentVersion(meta.id, branch),
        ...(await pdfResult(compiled, branch, pdfRel, { pdfStale: !!result.pdfStale, pages: result.pages ?? null, t: result.compileId, writtenAt: result.pdfWrittenAt, truncated: !!result.pdfTruncated })),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // compile.ts refuses a rootless branch before it reaches the compiler:
      // a document problem the model can fix, never a compiler outage.
      if (/No \.tex file to typeset/.test(msg)) {
        return fail(`This project has no .tex file to typeset on ${branch} — create the main document with write_file (the first .tex becomes the main document), then compile.`);
      }
      // Only a failed round trip to the compiler is "the compiler may be
      // down"; a missing branch or project keeps its own answer.
      if (err instanceof TypeError || /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|abort|timed? ?out|Unexpected token|not valid JSON/i.test(msg)) {
        console.warn(`[aldine] agent compile could not reach the compiler: ${msg}`);
        return fail('Typesetting failed to start — your Aldine compiler may not be responding');
      }
      return toolError(err, { project, branch });
    } finally {
      if (timer) clearInterval(timer);
      if (key) {
        if (sharedSlot) compileGate.release(key);
        if (agentSlot) agentCompileGate.release(key);
      }
    }
  });

  server.registerTool('get_pdf_url', {
    description: `A fresh signed link to the PDF on disk for the branch, without recompiling — use it when a compile result's pdfUrl has expired (${OUTPUT_URL_TTL_S / 60} minutes) or the user asks to see the PDF again. Returns {pdfUrl, pdfFile, pages, typesetAt, deepLink}; pdfStale is always false here because the link is to that file, whichever typeset wrote it (by you or by a person). It does not contain edits made since that typeset: if you have written on this branch since your last compile result, call compile instead. No output yet → compile first.`,
    annotations: { readOnlyHint: true },
    inputSchema: { project: projectParam, branch: branchParam },
    ...uiMeta,
  }, async ({ project, branch = 'main' }) => {
    try {
      const meta = await resolveProject(identity, project);
      await gitops.ensureWorktree(meta.id, branch);
      const disk = outputOnDisk(meta.id, branch, meta.rootFile);
      if (!disk) return fail(`No typeset output on ${branch} yet — call compile first`);
      // With stop-on-first-error the file a halted run wrote is a torso; there
      // is no previous PDF to fall back to (the run overwrote it).
      if (meta.stopOnFirstError && disk.partial) return fail(`The last typeset on ${branch} stopped on an error, so the PDF on disk is incomplete — fix the error and call compile`);
      return okApp({ ok: true, ...(await pdfResult(meta, branch, disk.pdf, { pdfStale: false, pages: disk.pages })) });
    } catch (err) { return toolError(err, { project, branch }); }
  });

  server.registerTool('commit', {
    description: 'Commit the files you have written on this branch that are not yet committed, as one commit under message (author Claude). Only your own paths land: a collaborator\'s unsaved typing stays out of it and reaches history as their own autosave. Call it when the user asks for a named checkpoint — every write already commits on its own as it lands, so {committed:false} is the normal answer, not a failure: it means they landed already, and the result names the current head and your latest commits on the branch. For a multi-file change you are making right now, use batch_write instead — it writes and commits it in one step under its own message. message titles the commit and replaces the per-file titles those writes would have had.',
    inputSchema: {
      project: projectParam,
      branch: branchParam,
      message: messageParam('the intent of the checkpoint').describe(`Commit message stating the intent of the checkpoint, at most ${COMMIT_MESSAGE_MAX} characters.`),
    },
  }, async ({ project, branch = 'main', message }) => {
    try {
      const meta = await resolveProject(identity, project);
      assertWritableProject(meta.id);
      await gitops.ensureWorktree(meta.id, branch);
      // One lock span from the flush to the commit: outside it an autosave
      // queued before the flush can stage the agent's delta as
      // `aldine: autosave` (no Claude commit, no review coverage).
      return await gitops.withRepoLock(meta.id, async () => {
        flushBranchDocs(meta.id, branch);
        const res = await gitops.commitAttributedHeld(meta.id, branch, cleanCommitMessage(message, 'Checkpoint'));
        const e = await echo(meta.id, branch);
        // Where the edits went when nothing was waiting: the model can name
        // the commit that holds them instead of guessing.
        // Short hashes, the length head and commit use everywhere else.
        const recent = res.committed ? [] : (await gitops.log(meta.id, branch, 30))
          .filter((c) => c.author === gitops.AGENT_COMMIT_AUTHOR).slice(0, 5)
          .map((c) => ({ hash: c.hash.slice(0, e.head.length || 7), date: c.date, message: c.message }));
        // "Nothing was waiting", not "everything is committed": after a
        // restart inside the debounce window the ledger is empty while the
        // delta is still on disk, waiting for the anonymous sweep.
        const note = recent.length
          ? `Nothing was waiting to commit — your edits already landed on their own; head is ${e.head}.`
          : `Nothing was waiting to commit, and this branch has no commits by Claude yet; head is ${e.head}.`;
        return ok({
          committed: res.committed,
          hash: res.committed ? e.head : null,
          files: res.files,
          ...(res.committed ? {} : { note, recentClaudeCommits: recent }),
          contentVersion: contentVersion(meta.id, branch),
          ...e,
        });
      });
    } catch (err) { return toolError(err, { project, branch }); }
  });

  server.registerTool('references_add', {
    description: 'Resolve a DOI, doi.org URL, arXiv id, or OpenAlex id to a BibTeX entry and append it to a .bib file on the branch (default: references.bib next to the root file). A bibFile that does not exist is created, folders included (created:true in the result). Returns {key, bibFile, duplicate, created} — use \\cite{key} right away; a note says when no .tex on the branch loads that .bib (\\addbibresource or \\bibliography), in which case the citation stays undefined until one does. Titles are not lookups: for a paper you only know by name, ask the user for its DOI or arXiv id. If the lookup budget is reached or the upstream service fails, tell the user — do not retry in a loop.',
    inputSchema: {
      project: projectParam,
      branch: branchParam,
      query: z.string().min(1).describe('A DOI (10.xxxx/…), doi.org URL, arXiv id (2301.12345 or arXiv:2301.12345), or OpenAlex id (W…).'),
      bibFile: z.string().optional().describe('Target .bib path relative to the project root. Defaults to references.bib beside the root file; a missing file (and its folders) is created.'),
    },
  }, async ({ project, branch = 'main', query, bibFile }) => {
    try {
      const meta = await resolveProject(identity, project);
      assertWritableProject(meta.id);
      // A wrong target would splice an @entry into a .tex source, which the
      // tool would then report as a success (and commit under Claude's name).
      const visible = visiblePath(bibFile || rootSiblingPath(meta.rootFile, 'references.bib'));
      if (!/\.bib$/i.test(visible)) return fail('bibFile must be a .bib file');
      // Branch and path are validated before the budget token is spent and
      // the upstream is hit, so a typo never costs a lookup.
      await gitops.ensureWorktree(meta.id, branch);
      const target = diskSpelling(meta.id, branch, visible);
      const key = compileKey(identity);
      if (!(await refLimiter.take(key))) return fail('Reference lookup budget reached — wait a few seconds before the next lookup');
      let added: Awaited<ReturnType<typeof addReference>>;
      try {
        // Right before the write, like every write tool: the tint on the
        // appended entry needs the agent in awareness first, and a lookup
        // that finds nothing or a duplicate must not show Claude in the .bib.
        added = await addReference(meta.id, branch, query, target, 'Claude', () => markAgentPresence(meta.id, branch, target));
      } catch (err) {
        // references.ts messages name the upstream and its HTTP status — the
        // user can act on them; a bare network failure (undici's TypeError,
        // ECONNREFUSED, a timeout) is worded here. Anything else comes from
        // the write path and must not be blamed on the upstream.
        const msg = err instanceof Error ? err.message : '';
        if (/lookup failed|too large|HTTP/i.test(msg)) return fail(`Reference lookup failed: ${msg}`);
        if (err instanceof TypeError || /fetch failed|abort|timed? ?out|ECONN|ENOTFOUND|EAI_AGAIN/i.test(msg)) return fail('The reference service (doi.org / arXiv / OpenAlex) could not be reached from your Aldine server');
        return toolError(err);
      }
      if (!added) return fail(`No reference found for "${query}" — pass a DOI (10.…), arXiv id or OpenAlex id; an id in the right shape that is still not found is not registered upstream, so check it with the user rather than retrying`);
      if (!added.duplicate) signalAgentWrite(meta.id, branch);
      const loaded = bibLoadedBySource(meta.id, branch, meta.rootFile, added.bibFile);
      return ok({
        ...added,
        ...(loaded ? {} : { note: `No .tex file on ${branch} loads ${added.bibFile} — \\cite{${added.key}} stays undefined until the main document has \\addbibresource{${path.posix.relative(path.posix.dirname(meta.rootFile || 'main.tex'), added.bibFile)}} (biblatex) or lists it in \\bibliography{} (bibtex).` }),
        contentVersion: contentVersion(meta.id, branch), fileVersion: fileVersion(meta.id, branch, added.bibFile), ...(await echo(meta.id, branch)),
      });
    } catch (err) { return toolError(err, { project, branch }); }
  });

  server.registerTool('list_citations', {
    description: 'Citation keys defined in the project\'s .bib files: [{key, title, author, year, file}]. Always call it before writing a \\cite — never invent a key. A key you need that is missing: add it with references_add, or ask the user.',
    annotations: { readOnlyHint: true },
    inputSchema: { project: projectParam, branch: branchParam },
  }, async ({ project, branch = 'main' }) => {
    try {
      const meta = await resolveProject(identity, project);
      await gitops.ensureWorktree(meta.id, branch);
      const citations = bibIndex(meta.id, branch).map((e) => ({ key: e.key, title: e.title, author: e.author, year: e.year, file: e.file }));
      return ok({ citations, ...(await echo(meta.id, branch)) });
    } catch (err) { return toolError(err, { project, branch }); }
  });

  server.registerTool('list_labels', {
    description: '\\label targets defined in the project\'s .tex files: [{label, file}]. Call it before writing \\ref, \\eqref, or \\cref — never invent a label.',
    annotations: { readOnlyHint: true },
    inputSchema: { project: projectParam, branch: branchParam },
  }, async ({ project, branch = 'main' }) => {
    try {
      const meta = await resolveProject(identity, project);
      await gitops.ensureWorktree(meta.id, branch);
      return ok({ labels: labelIndex(meta.id, branch), ...(await echo(meta.id, branch)) });
    } catch (err) { return toolError(err, { project, branch }); }
  });

  server.registerTool('wordcount', {
    description: 'Word count of the document as it compiles — the root file plus its \\input/\\include graph, commands and comments excluded: {rootFile, total, files}. Use it for length questions instead of estimating from source. A project with no main document yet is an error, not a count of 0.',
    annotations: { readOnlyHint: true },
    inputSchema: { project: projectParam, branch: branchParam },
  }, async ({ project, branch = 'main' }) => {
    try {
      const meta = await resolveProject(identity, project);
      await gitops.ensureWorktree(meta.id, branch);
      // indexes.ts answers {total:0, files:{}} for an empty root, which reads
      // as "your draft has 0 words" when relayed.
      if (!meta.rootFile) return fail('This project has no main document yet, so there is nothing to count — write a .tex file first (the first one written becomes the main document)');
      return ok({ ...(await wordCount(meta.id, branch)), ...(await echo(meta.id, branch)) });
    } catch (err) { return toolError(err, { project, branch }); }
  });

  server.registerTool('create_project', {
    description: 'Create a new project, blank or from a template, and return its id for the write tools, with contentVersion (pass it as base_version to the first write) and the files the template seeded. Needs a token with access to all projects — a project-scoped token cannot create; if refused, relay that to the user (they can mint an unscoped token in Settings → Agent access).',
    inputSchema: {
      name: z.string().min(1).max(200).describe('Project name shown in the workspace.'),
      template: z.string().optional().describe('Template id from the workspace gallery: a folder template ("article", "beamer", "report", "iac-paper") or a venue kit ("venue:neurips", "venue:elsarticle", …; the publisher\'s class files are downloaded when they are not installed). An unknown id is refused with the full list. "blank" creates a project with no files and no main document — the first .tex written becomes it. Omit for a starter main.tex + references.bib.'),
    },
  }, async ({ name, template }) => {
    try {
      // Scope is the token's blast radius (SECURITY.md risk #2): a project-
      // scoped token must not grow it by creating projects — the same rule
      // the REST preHandler applies to POST /api/projects.
      if (identity.tokenScope?.projectIds) {
        return fail('This token is scoped to specific projects and cannot create new ones — ask the user for a token without a project scope');
      }
      let seed: Record<string, Buffer> | undefined;
      let resolved: TemplateSeed | undefined;
      if (template) {
        // The same gallery the New project dialog offers, so a venue the user
        // can pick there is one the agent can pick too.
        const known = (await listAllTemplates()).map((t) => t.id);
        if (!known.includes(template)) {
          return fail(`Unknown template "${template}"${known.length ? ` — available: ${known.join(', ')}` : ''}`);
        }
        try {
          resolved = await resolveTemplateSeed(template);
          seed = resolved.files;
        } catch (err: any) {
          return fail(`Template "${template}" could not be prepared: ${err?.message || err}`);
        }
      }
      // The mark trash_project keys on: only what the agent made is within its reach.
      const meta = await store.createProject(name, seed, identity.user?.id, { createdVia: 'agent' });
      // A venue kit that could not be downloaded still creates the project
      // from a skeleton; the model should say so rather than the call failing.
      return ok({
        id: meta.id, name: meta.name, rootFile: meta.rootFile, engine: meta.engine, deepLink: `${base}/p/${meta.id}`,
        // The seed, not the tree: the .gitignore is Aldine's, not the template's.
        files: store.listFiles(meta.id, 'main').filter((f) => f.type === 'file' && f.path !== '.gitignore').map((f) => f.path),
        contentVersion: contentVersion(meta.id, 'main'),
        ...(resolved?.venueKit ? { venueKit: resolved.venueKit } : {}),
        ...(await echo(meta.id, 'main')),
      });
    } catch (err) { return toolError(err); }
  });

  server.registerTool('trash_project', {
    description: `Move a project that was created with create_project to the trash, where its owner can restore it from the workspace for ${TRASH_DAYS} days; nothing is deleted for good by this tool. Refused for any project a person created (agentCreated:false in list_projects) — ask them to delete it in Aldine themselves — and for projects the token's owner does not own. Use it for scratch projects the user asked you to throw away; never on your own initiative.`,
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: { project: z.string().min(1).describe('Project id (from list_projects or create_project). Required: this tool never falls back to a scoped token\'s project.') },
  }, async ({ project }) => {
    try {
      const meta = await resolveProject(identity, project);
      assertWritableProject(meta.id);
      if (meta.createdVia !== 'agent') return fail('Only projects created through the Agent API can be trashed by it — ask the user to delete this one from their workspace');
      if (!isOwner(meta, identity.user)) return fail('Only the owner of the project can move it to the trash');
      const { remote } = await trashProject(meta);
      console.log(`[metric] agent_trash user=${identity.user?.id ?? 'operator'} project=${meta.id}`);
      return ok({
        trashed: true, id: meta.id, name: meta.name, restorableUntil: restorableUntil(),
        note: `Restorable from the workspace trash for ${TRASH_DAYS} days`,
        ...(remote.error ? { remoteError: remote.error } : {}),
      });
    } catch (err) { return toolError(err); }
  });
}

/** Whether any .tex on the branch loads `bibFile` — \addbibresource{x.bib}
 *  (biblatex) or \bibliography{a,b} (bibtex), both resolved from the root
 *  file's directory, both with or without the extension. Scans every .tex,
 *  not only the root: a preamble \input may hold the line. */
export function bibLoadedBySource(projectId: string, branch: string, rootFile: string, bibFile: string): boolean {
  const rootDir = path.posix.dirname(rootFile || 'main.tex');
  const wanted = new Set<string>();
  for (const spelled of [bibFile, bibFile.replace(/\.bib$/i, '')]) {
    wanted.add(path.posix.normalize(spelled));
    wanted.add(path.posix.relative(rootDir, spelled));
  }
  const re = /\\(?:addbibresource|addglobalbib|bibliography)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
  for (const f of store.listFiles(projectId, branch)) {
    if (f.type !== 'file' || !/\.tex$/i.test(f.path)) continue;
    let text: string;
    try { text = store.readFile(projectId, branch, f.path).toString('utf8'); } catch { continue; }
    const dir = path.posix.dirname(f.path);
    for (const m of text.matchAll(re)) {
      for (const raw of m[1].split(',')) {
        const name = raw.trim();
        if (!name) continue;
        // Resolved against the root's directory (how TeX reads it) and against
        // the naming file's own directory; either spelling counts.
        if (wanted.has(name) || wanted.has(path.posix.normalize(path.posix.join(dir, name))) || wanted.has(path.posix.normalize(path.posix.join(rootDir, name)))) return true;
      }
    }
  }
  return false;
}
