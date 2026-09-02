import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as store from '../store.js';
import * as gitops from '../gitops.js';
import * as usage from '../usage.js';
import { compileProject } from '../compile.js';
import {
  flushBranchDocs, refreshBranchDocsFromDisk, contentVersion, bumpContentVersion,
  scheduleCommit, applySuggestionToDoc, openDocContent, markAgentPresence, AGENT_ORIGIN,
} from '../collab.js';
import { compileGate, compileLimiter, agentCompileGate, refLimiter } from '../ratelimit.js';
import { isTextFile, rootSiblingPath } from '../util.js';
import { isListed } from '../authz.js';
import { addReference } from '../references.js';
import { bibIndex, labelIndex, wordCount } from '../indexes.js';
import { listTemplates, templateFiles } from '../templates.js';
import {
  McpDenied, resolveProject, assertWritableProject, assertVisiblePath, type McpIdentity,
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
 * create_project), plus the ping reachability check. Deliberately absent
 * (threat model rank #1 — the tools must not exist server-side): delete/purge,
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
export interface AnchorCandidate { line: number; text: string }
export type ResolveEditsResult =
  | { ok: true; ranges: Array<{ from: number; to: number }> }
  | { ok: false; error: 'invalid_quote' | 'stale_anchor'; editIndex: number; reason: string; candidates: AnchorCandidate[] };

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

/** ≤`max` lines most similar to the missing quote (bigram Dice score against
 *  the quote's first non-empty line) — the model re-anchors from these
 *  instead of re-reading the whole file blind. */
export function nearestCandidates(content: string, quote: string, max = 3): AnchorCandidate[] {
  const probe = (quote.split('\n').find((l) => l.trim()) || quote).trim();
  const probeGrams = bigrams(probe);
  if (!probeGrams.size) return [];
  const scored: Array<AnchorCandidate & { score: number }> = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].trim();
    if (!text) continue;
    const g = bigrams(text);
    let inter = 0;
    for (const b of g) if (probeGrams.has(b)) inter++;
    const score = (2 * inter) / (g.size + probeGrams.size);
    if (score > 0.2) scored.push({ line: i + 1, text: text.slice(0, 200), score });
  }
  scored.sort((a, b) => b.score - a.score || a.line - b.line);
  return scored.slice(0, max).map(({ line, text }) => ({ line, text }));
}

function candidatesAt(content: string, offsets: number[], max = 3): AnchorCandidate[] {
  const lines = content.split('\n');
  const out: AnchorCandidate[] = [];
  const seen = new Set<number>();
  for (const off of offsets) {
    const line = lineOfOffset(content, off);
    if (seen.has(line)) continue;
    seen.add(line);
    out.push({ line, text: (lines[line - 1] || '').trim().slice(0, 200) });
    if (out.length >= max) break;
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
      return { ok: false, error: 'invalid_quote', editIndex: i, reason: `quote must be at least ${MIN_QUOTE_LEN} characters`, candidates: [] };
    }
    const hits: number[] = [];
    let idx = content.indexOf(quote);
    while (idx >= 0 && hits.length < MAX_OCCURRENCE_SCAN) {
      hits.push(idx);
      idx = content.indexOf(quote, idx + 1);
    }
    if (hits.length === 0) {
      return { ok: false, error: 'stale_anchor', editIndex: i, reason: 'quote not found', candidates: nearestCandidates(content, quote) };
    }
    let from: number;
    if (occurrence !== undefined) {
      if (!Number.isInteger(occurrence) || occurrence < 1 || occurrence > hits.length) {
        return { ok: false, error: 'stale_anchor', editIndex: i, reason: `occurrence ${occurrence} is out of range — the quote appears ${hits.length} time(s)`, candidates: candidatesAt(content, hits) };
      }
      from = hits[occurrence - 1];
    } else if (hits.length > 1) {
      return { ok: false, error: 'stale_anchor', editIndex: i, reason: `quote is ambiguous — ${hits.length} occurrences; pick one with occurrence`, candidates: candidatesAt(content, hits) };
    } else {
      from = hits[0];
    }
    ranges.push({ from, to: from + quote.length });
  }
  const order = ranges.map((r, i) => ({ ...r, i })).sort((a, b) => a.from - b.from);
  for (let k = 1; k < order.length; k++) {
    if (order[k].from < order[k - 1].to) {
      return { ok: false, error: 'stale_anchor', editIndex: order[k].i, reason: `edit overlaps edit ${order[k - 1].i}`, candidates: [] };
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

/** ≤4 KB tail of the latexmk log — the full log is a ~200 KB context bomb the
 *  spec forbids returning. Byte-capped (not chars) and stripped of a leading
 *  broken multi-byte sequence from the cut. */
export const LOG_TAIL_BYTES = 4096;
export function logTail(log: string): string {
  const buf = Buffer.from(log, 'utf8');
  if (buf.length <= LOG_TAIL_BYTES) return log;
  return buf.subarray(buf.length - LOG_TAIL_BYTES).toString('utf8').replace(/^�+/, '');
}

/** ~100 KB read cap; larger files are read via from_line/to_line windows. */
const MAX_READ_BYTES = 100_000;

function snippetAround(content: string, offset: number): string {
  const lines = content.split('\n');
  const li = lineOfOffset(content, offset) - 1;
  let s = lines.slice(Math.max(0, li - 2), Math.min(lines.length, li + 3)).join('\n');
  if (s.length > 500) s = s.slice(0, 500) + '…';
  return s;
}

// ---------------------------------------------------------------------------
// Tool plumbing
// ---------------------------------------------------------------------------

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const ok = (body: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(body) }] });
const fail = (message: string): ToolResult => ({ content: [{ type: 'text', text: message }], isError: true });

/** Every result echoes {branch, head} so the model can narrate what it touched. */
async function echo(projectId: string, branch: string): Promise<{ branch: string; head: string }> {
  return { branch, head: await gitops.branchShortHead(projectId, branch) };
}

/** Guard failures become user-fixable prose (UX.md); anything else stays generic
 *  so internals (paths, stack frames) never reach the model. */
function toolError(err: unknown): ToolResult {
  if (err instanceof McpDenied) return fail(err.message);
  const msg = err instanceof Error ? err.message : String(err);
  if (/bad branch name|not a valid ref|invalid reference|worktree/i.test(msg)) return fail('Branch not found');
  if (/project not found/i.test(msg)) return fail('Project not found');
  return fail('The request failed on the Aldine server');
}

const projectParam = z.string().optional().describe('Project id. Optional when the access token is scoped to exactly one project.');
const branchParam = z.string().optional().describe("Branch name (defaults to 'main'). Every result echoes {branch, head} — pass the branch explicitly whenever you are not on main.");
const editShape = {
  quote: z.string().describe('Exact text to replace, copied verbatim from the file. At least 8 characters; must match exactly one place, or use occurrence.'),
  replacement: z.string().describe('Replacement text (empty string deletes the quote).'),
  occurrence: z.number().int().min(1).optional().describe('1-based occurrence to target when the quote appears more than once.'),
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export function registerTools(server: McpServer, identity: McpIdentity): void {
  server.registerTool('ping', {
    description: 'Check that the Aldine connector is reachable and authenticated. If it fails, tell the user their Aldine instance is not responding or the connector needs reconnecting — do not go on to other tools.',
    annotations: { readOnlyHint: true },
  }, async () => ok({ ok: true, server: 'aldine', user: identity.user?.email ?? null }));

  server.registerTool('list_projects', {
    description: 'List the LaTeX projects this token can reach: id, name, branches, rootFile, engine. Call it when you do not know the project id. A token scoped to one project makes the project argument optional everywhere.',
    annotations: { readOnlyHint: true },
  }, async () => {
    try {
      const scoped = identity.tokenScope?.projectIds;
      const metas = (await store.listProjects()).filter((m) =>
        !m.deletedAt && (!scoped || scoped.includes(m.id)) && isListed(m, identity.user));
      const out = [] as Array<{ id: string; name: string; branches: string[]; rootFile: string; engine: string }>;
      for (const m of metas) {
        let branches = ['main'];
        try { branches = (await gitops.listBranches(m.id)).map((b) => b.name); } catch { /* fresh repo — main only */ }
        out.push({ id: m.id, name: m.name, branches, rootFile: m.rootFile, engine: m.engine });
      }
      return ok(out);
    } catch (err) { return toolError(err); }
  });

  server.registerTool('project_structure', {
    description: 'File tree of a project branch plus rootFile, engine, and contentVersion (pass it as base_version to edit_file/write_file for conflict-safe writes). Call it before working in a project you have not read yet.',
    annotations: { readOnlyHint: true },
    inputSchema: { project: projectParam, branch: branchParam },
  }, async ({ project, branch = 'main' }) => {
    try {
      const meta = await resolveProject(identity, project);
      await gitops.ensureWorktree(meta.id, branch);
      flushBranchDocs(meta.id, branch);
      const files = store.listFiles(meta.id, branch).map((f) => ({ path: f.path, type: f.type, size: f.size }));
      return ok({ files, rootFile: meta.rootFile, engine: meta.engine, contentVersion: contentVersion(meta.id, branch), ...(await echo(meta.id, branch)) });
    } catch (err) { return toolError(err); }
  });

  server.registerTool('read_file', {
    description: 'Read a text file as the editor shows it right now (open documents are flushed first). Reads cap at ~100 KB — window larger files with from_line/to_line (1-based, inclusive). Read before you edit: edit_file quotes must match this content verbatim.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      project: projectParam,
      branch: branchParam,
      path: z.string().describe('File path relative to the project root, e.g. "main.tex".'),
      from_line: z.number().int().min(1).optional(),
      to_line: z.number().int().min(1).optional(),
    },
  }, async ({ project, branch = 'main', path: rel, from_line, to_line }) => {
    try {
      const meta = await resolveProject(identity, project);
      assertVisiblePath(rel);
      await gitops.ensureWorktree(meta.id, branch);
      flushBranchDocs(meta.id, branch);
      let buf: Buffer;
      try { buf = store.readFile(meta.id, branch, rel); } catch { return fail(`No file named "${rel}" on ${branch}`); }
      if (!isTextFile(rel)) return fail(`"${rel}" is a binary file — read_file only serves text`);
      const text = buf.toString('utf8');
      const lines = text.split('\n');
      const totalLines = lines.length;
      let content = text;
      if (from_line !== undefined || to_line !== undefined) {
        content = lines.slice(Math.max(1, from_line ?? 1) - 1, Math.min(totalLines, to_line ?? totalLines)).join('\n');
      }
      if (Buffer.byteLength(content, 'utf8') > MAX_READ_BYTES) {
        return fail(`That read is ${Buffer.byteLength(content, 'utf8')} bytes — cap is ~100 KB. The file has ${totalLines} lines; read it in windows with from_line/to_line.`);
      }
      return ok({ content, totalLines, contentVersion: contentVersion(meta.id, branch), ...(await echo(meta.id, branch)) });
    } catch (err) { return toolError(err); }
  });

  server.registerTool('edit_file', {
    description: 'Replace exact quoted text inside an existing file — the default way to change a document, and the only safe way to change one a person has open (edits merge with their live typing; write_file would discard it). Each quote: ≥8 characters, copied verbatim from a read, matching exactly one place (or set occurrence). On {error:"stale_anchor"} nothing was applied: re-read the file, re-anchor from the candidates, retry — at most 2 retries, then tell the user what you tried and ask. {error:"version_conflict"}: the file changed since base_version — re-read, then re-apply once. Committed as author Claude.',
    inputSchema: {
      project: projectParam,
      branch: branchParam,
      path: z.string().describe('File path relative to the project root.'),
      edits: z.array(z.object(editShape)).min(1).max(50),
      base_version: z.number().int().optional().describe('contentVersion from a prior read; mismatch returns version_conflict instead of editing.'),
    },
  }, async ({ project, branch = 'main', path: rel, edits, base_version }) => {
    try {
      const meta = await resolveProject(identity, project);
      assertWritableProject(meta.id);
      assertVisiblePath(rel);
      await gitops.ensureWorktree(meta.id, branch);
      // Checkpoint the file's current state (flushed, so live typing counts)
      // before touching it: the attributed commit must carry only the agent's
      // delta, never a collaborator's uncommitted work in the same file.
      flushBranchDocs(meta.id, branch);
      await gitops.checkpointPaths(meta.id, branch, [rel]);
      // --- synchronous to the end of the apply: resolution and application see
      // one content snapshot, atomic against human keystrokes (no await).
      if (base_version !== undefined) {
        flushBranchDocs(meta.id, branch); // a pending live edit counts as a change
        const currentVersion = contentVersion(meta.id, branch);
        if (base_version !== currentVersion) return ok({ error: 'version_conflict', currentVersion });
      }
      const live = openDocContent(meta.id, branch, rel);
      let applied = 0;
      let newContent: string;
      let firstFrom: number;
      if (live !== null) {
        const res = resolveEdits(live, edits);
        if (!res.ok) {
          if (res.error === 'invalid_quote') return fail(`edits[${res.editIndex}]: ${res.reason}`);
          return ok({ error: 'stale_anchor', edit_index: res.editIndex, reason: res.reason, candidates: res.candidates, contentVersion: contentVersion(meta.id, branch) });
        }
        // Back-to-front, same tick: earlier offsets stay valid, and no human
        // keystroke can interleave. 'stale' from the CRDT apply is impossible
        // here by construction but handled defensively anyway.
        const order = res.ranges.map((r, i) => ({ ...r, edit: edits[i] })).sort((a, b) => b.from - a.from);
        for (const e of order) {
          const st = applySuggestionToDoc(meta.id, branch, rel, { from: e.from, to: e.to, quote: e.edit.quote }, e.edit.replacement, AGENT_ORIGIN);
          if (st !== 'applied') {
            return ok({ error: 'stale_anchor', edit_index: res.ranges.findIndex((r) => r.from === e.from), reason: 'the document changed while applying', applied, candidates: [], contentVersion: contentVersion(meta.id, branch) });
          }
          applied++;
        }
        markAgentPresence(meta.id, branch, rel);
        newContent = openDocContent(meta.id, branch, rel) ?? '';
        firstFrom = Math.min(...res.ranges.map((r) => r.from));
      } else {
        flushBranchDocs(meta.id, branch); // other files' docs may be open
        let current: string;
        try { current = store.readFile(meta.id, branch, rel).toString('utf8'); } catch { return fail(`No file named "${rel}" on ${branch}`); }
        const res = resolveEdits(current, edits);
        if (!res.ok) {
          if (res.error === 'invalid_quote') return fail(`edits[${res.editIndex}]: ${res.reason}`);
          return ok({ error: 'stale_anchor', edit_index: res.editIndex, reason: res.reason, candidates: res.candidates, contentVersion: contentVersion(meta.id, branch) });
        }
        newContent = spliceEdits(current, edits, res.ranges);
        store.writeFile(meta.id, branch, rel, newContent);
        bumpContentVersion(meta.id, branch);
        applied = edits.length;
        firstFrom = Math.min(...res.ranges.map((r) => r.from));
      }
      scheduleCommit(meta.id, branch, `Edit ${rel}`, 'Claude', [rel]);
      return ok({ applied, contentVersion: contentVersion(meta.id, branch), snippet: snippetAround(newContent, firstFrom), ...(await echo(meta.id, branch)) });
    } catch (err) { return toolError(err); }
  });

  server.registerTool('write_file', {
    description: 'Create a new file, or replace a whole file. For an existing file prefer edit_file — a whole-file write on an open document teleports collaborators\' viewports and can drop their in-flight typing. Pass base_version (from a prior read) to get {error:"version_conflict"} instead of overwriting newer content; on conflict re-read and re-write once, then ask. Committed as author Claude.',
    inputSchema: {
      project: projectParam,
      branch: branchParam,
      path: z.string().describe('File path relative to the project root.'),
      content: z.string(),
      base_version: z.number().int().optional(),
    },
  }, async ({ project, branch = 'main', path: rel, content, base_version }) => {
    try {
      const meta = await resolveProject(identity, project);
      assertWritableProject(meta.id);
      assertVisiblePath(rel);
      await gitops.ensureWorktree(meta.id, branch);
      flushBranchDocs(meta.id, branch);
      // See edit_file: the attributed commit must carry only the agent's delta.
      await gitops.checkpointPaths(meta.id, branch, [rel]);
      flushBranchDocs(meta.id, branch); // keystrokes that landed during the checkpoint
      if (base_version !== undefined) {
        const currentVersion = contentVersion(meta.id, branch);
        if (base_version !== currentVersion) return ok({ error: 'version_conflict', currentVersion });
      }
      store.writeFile(meta.id, branch, rel, content);
      refreshBranchDocsFromDisk(meta.id, branch);
      markAgentPresence(meta.id, branch, rel);
      scheduleCommit(meta.id, branch, `Update ${rel}`, 'Claude', [rel]);
      return ok({ ok: true, contentVersion: contentVersion(meta.id, branch), ...(await echo(meta.id, branch)) });
    } catch (err) { return toolError(err); }
  });

  server.registerTool('batch_write', {
    description: 'Apply one multi-file change as ONE named commit (author Claude). Each entry carries full content (new files) or quote-anchored edits (existing files, same rules as edit_file). All edits resolve before anything is written — a stale_anchor writes nothing; fix that entry and resend the whole batch. Use it for a coherent change across files; use edit_file for a single file. message = the intent, imperative ("Add related-work section").',
    inputSchema: {
      project: projectParam,
      branch: branchParam,
      files: z.array(z.object({
        path: z.string(),
        content: z.string().optional().describe('Full new file content (mutually exclusive with edits).'),
        edits: z.array(z.object(editShape)).min(1).max(50).optional().describe('Quote-anchored edits (mutually exclusive with content).'),
      })).min(1).max(50),
      message: z.string().min(1).describe('Commit message stating the intent of the change.'),
    },
  }, async ({ project, branch = 'main', files, message }) => {
    try {
      const meta = await resolveProject(identity, project);
      assertWritableProject(meta.id);
      // One entry per path: every entry resolves against the same pre-write
      // snapshot and the write loop is last-writer-wins, so a duplicate path
      // would silently discard the earlier entry's edits while reporting ok.
      const seenPaths = new Set<string>();
      for (const f of files) {
        assertVisiblePath(f.path);
        if ((f.content === undefined) === (f.edits === undefined)) {
          return fail(`files entry "${f.path}" must carry exactly one of content or edits`);
        }
        if (seenPaths.has(f.path)) {
          return fail(`files lists "${f.path}" more than once — merge its changes into one entry`);
        }
        seenPaths.add(f.path);
      }
      await gitops.ensureWorktree(meta.id, branch);
      flushBranchDocs(meta.id, branch);
      // See edit_file: the named commit must carry only the agent's delta.
      await gitops.checkpointPaths(meta.id, branch, files.map((f) => f.path));
      flushBranchDocs(meta.id, branch); // keystrokes that landed during the checkpoint
      // Resolve every edit against the flushed disk state BEFORE writing
      // anything, so a stale anchor in file N can't leave files 1..N-1 changed.
      const writes: Array<{ path: string; next: string }> = [];
      for (const f of files) {
        if (f.content !== undefined) {
          writes.push({ path: f.path, next: f.content });
          continue;
        }
        let current: string;
        try { current = store.readFile(meta.id, branch, f.path).toString('utf8'); } catch { return fail(`No file named "${f.path}" on ${branch}`); }
        const res = resolveEdits(current, f.edits!);
        if (!res.ok) {
          if (res.error === 'invalid_quote') return fail(`${f.path} edits[${res.editIndex}]: ${res.reason}`);
          return ok({ error: 'stale_anchor', file: f.path, edit_index: res.editIndex, reason: res.reason, candidates: res.candidates, contentVersion: contentVersion(meta.id, branch) });
        }
        writes.push({ path: f.path, next: spliceEdits(current, f.edits!, res.ranges) });
      }
      for (const w of writes) store.writeFile(meta.id, branch, w.path, w.next);
      refreshBranchDocsFromDisk(meta.id, branch);
      for (const w of writes) markAgentPresence(meta.id, branch, w.path);
      // Only the batch's own paths: the flush above put collaborators' live
      // edits in OTHER files on disk too, and a whole-tree commit would sign
      // them as Claude (and expose them to the session toast's revert). They
      // reach history through the normal autosave debounce instead.
      const commit = await gitops.commitPaths(meta.id, branch, writes.map((w) => w.path), message, 'Claude');
      const e = await echo(meta.id, branch);
      return ok({ ok: true, contentVersion: contentVersion(meta.id, branch), commit: commit.committed ? e.head : null, ...e });
    } catch (err) { return toolError(err); }
  });

  server.registerTool('compile', {
    description: 'Typeset the project with latexmk: parsed errors [{type,file,line,message}], a ≤4 KB log tail, a PDF link, and a deep link into Aldine. Takes up to ~2 minutes; progress notifications arrive while it runs. Compile after a coherent set of edits, not after each one, and never just to check syntax. On errors: fix and recompile at most 3 times, narrating each attempt ("attempt 2 of 3: added natbib"), then stop and ask the user, quoting the failing file:line. A compiler-not-responding, quota, or typeset-already-running error is for the user to act on — relay it, do not retry.',
    inputSchema: { project: projectParam, branch: branchParam },
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
      key = user ? `u:${user.id}` : 'mcp:operator';
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
      const result = await compileProject(meta.id, branch);
      if (user) await usage.recordCompile(user.id, result.durationMs || 0);
      const base = (process.env.ALDINE_PUBLIC_URL || '').replace(/\/$/, '');
      const deepLink = `${base}/p/${meta.id}${branch !== 'main' ? `?branch=${encodeURIComponent(branch)}` : ''}`;
      return ok({
        ok: result.ok,
        errors: result.errors,
        logTail: logTail(result.log),
        pdfUrl: result.pdfUrl ? `${base}${result.pdfUrl}` : null,
        deepLink,
        durationMs: result.durationMs,
        timedOut: !!result.timedOut,
        contentVersion: contentVersion(meta.id, branch),
        ...(await echo(meta.id, branch)),
      });
    } catch (err) {
      if (err instanceof McpDenied) return fail(err.message);
      return fail('Typesetting failed to start — your Aldine compiler may not be responding');
    } finally {
      if (timer) clearInterval(timer);
      if (key) {
        if (sharedSlot) compileGate.release(key);
        if (agentSlot) agentCompileGate.release(key);
      }
    }
  });

  server.registerTool('commit', {
    description: 'Commit EVERYTHING pending on the branch as author Claude — including collaborators\' unsaved typing, which then reads as Claude\'s work. Your own edits already auto-commit within seconds, so call this only when the user asks for a named checkpoint; prefer batch_write for a scoped, named commit. message = the intent of the session\'s edits.',
    inputSchema: {
      project: projectParam,
      branch: branchParam,
      message: z.string().min(1).describe('Commit message stating the intent.'),
    },
  }, async ({ project, branch = 'main', message }) => {
    try {
      const meta = await resolveProject(identity, project);
      assertWritableProject(meta.id);
      await gitops.ensureWorktree(meta.id, branch);
      flushBranchDocs(meta.id, branch);
      const res = await gitops.commitAll(meta.id, branch, message, 'Claude');
      const e = await echo(meta.id, branch);
      return ok({ committed: res.committed, hash: res.committed ? e.head : null, ...e });
    } catch (err) { return toolError(err); }
  });

  server.registerTool('references_add', {
    description: 'Resolve a DOI, doi.org URL, arXiv id, or OpenAlex id to a BibTeX entry and append it to a .bib file on the branch (default: references.bib next to the root file, created if missing). Returns {key, bibFile, duplicate} — use \\cite{key} right away. Titles are not lookups: for a paper you only know by name, ask the user for its DOI or arXiv id. If the lookup budget is reached or the upstream service fails, tell the user — do not retry in a loop.',
    inputSchema: {
      project: projectParam,
      branch: branchParam,
      query: z.string().min(1).describe('A DOI (10.xxxx/…), doi.org URL, arXiv id (2301.12345 or arXiv:2301.12345), or OpenAlex id (W…).'),
      bibFile: z.string().optional().describe('Target .bib path relative to the project root. Defaults to references.bib beside the root file.'),
    },
  }, async ({ project, branch = 'main', query, bibFile }) => {
    try {
      const meta = await resolveProject(identity, project);
      assertWritableProject(meta.id);
      const target = bibFile || rootSiblingPath(meta.rootFile, 'references.bib');
      assertVisiblePath(target);
      // A wrong target would splice an @entry into a .tex source, which the
      // tool would then report as a success (and commit under Claude's name).
      if (!/\.bib$/i.test(target)) return fail('bibFile must be a .bib file');
      // Branch and path are validated before the budget token is spent and
      // the upstream is hit, so a typo never costs a lookup.
      await gitops.ensureWorktree(meta.id, branch);
      const key = identity.user ? `u:${identity.user.id}` : 'mcp:operator';
      if (!(await refLimiter.take(key))) return fail('Reference lookup budget reached — wait a few seconds before the next lookup');
      let added: Awaited<ReturnType<typeof addReference>>;
      try {
        added = await addReference(meta.id, branch, query, target, 'Claude');
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
      if (!added) return fail(`No reference found for "${query}" — pass a DOI, arXiv id, or OpenAlex id`);
      if (!added.duplicate) markAgentPresence(meta.id, branch, added.bibFile);
      return ok({ ...added, contentVersion: contentVersion(meta.id, branch), ...(await echo(meta.id, branch)) });
    } catch (err) { return toolError(err); }
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
    } catch (err) { return toolError(err); }
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
    } catch (err) { return toolError(err); }
  });

  server.registerTool('wordcount', {
    description: 'Word count of the document as it compiles — the root file plus its \\input/\\include graph, commands and comments excluded: {rootFile, total, files}. Use it for length questions instead of estimating from source.',
    annotations: { readOnlyHint: true },
    inputSchema: { project: projectParam, branch: branchParam },
  }, async ({ project, branch = 'main' }) => {
    try {
      const meta = await resolveProject(identity, project);
      await gitops.ensureWorktree(meta.id, branch);
      return ok({ ...(await wordCount(meta.id, branch)), ...(await echo(meta.id, branch)) });
    } catch (err) { return toolError(err); }
  });

  server.registerTool('create_project', {
    description: 'Create a new project, blank or from a template, and return its id for the write tools. Needs a token with access to all projects — a project-scoped token cannot create; if refused, relay that to the user (they can mint an unscoped token in Settings → Agent access).',
    inputSchema: {
      name: z.string().min(1).max(200).describe('Project name shown in the workspace.'),
      template: z.string().optional().describe('Template id (e.g. "article", "beamer", "report"). Omit for a blank main.tex + references.bib.'),
    },
  }, async ({ name, template }) => {
    try {
      // Scope is the token's blast radius (SECURITY.md risk #2): a project-
      // scoped token must not grow it by creating projects — the same rule
      // the REST preHandler applies to POST /api/projects.
      if (identity.tokenScope?.projectIds) {
        return fail('This token is scoped to specific projects and cannot create new ones — ask the user for a token without a project scope');
      }
      let seed: Record<string, string> | undefined;
      if (template) {
        try { seed = templateFiles(template); } catch {
          const ids = listTemplates().map((t) => t.id);
          return fail(`Unknown template "${template}"${ids.length ? ` — available: ${ids.join(', ')}` : ''}`);
        }
      }
      const meta = await store.createProject(name, seed, identity.user?.id);
      const base = (process.env.ALDINE_PUBLIC_URL || '').replace(/\/$/, '');
      return ok({ id: meta.id, name: meta.name, rootFile: meta.rootFile, engine: meta.engine, deepLink: `${base}/p/${meta.id}`, ...(await echo(meta.id, 'main')) });
    } catch (err) { return toolError(err); }
  });
}
