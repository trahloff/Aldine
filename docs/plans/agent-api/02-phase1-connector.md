# Phase 1 — The connector (MCP server + 8 tools + agent presence)

Requires Phase 0 merged. Delivers a daily-usable Claude custom connector against
prod, plus the demo-instance trial connector.

## 1.1 MCP server placement and transport

- New module `apps/server/src/mcp/` (`server.ts`, `tools.ts`, `guards.ts`), narrow
  import surface so it can be lifted out later if ever needed.
- Registered only when `ALDINE_MCP=1`. Route: `POST/GET /mcp` (Streamable HTTP via
  the official TypeScript MCP SDK — this is the one deliberate exception to the
  zero-dep instinct; pin it, commit the lockfile).
- Fastify integration: the SDK transport is Node req/res-oriented — use
  `req.raw`/`reply.raw` + `reply.hijack()`. Stateless mode (2026-07-28 spec has a
  stateless core; build against 2025-11-25 auth baseline per Claude docs).
- The same tool registry must be runnable as a stdio binary
  (`apps/server/src/mcp/stdio.ts`, invoked via `node`/tsx) for Claude Code and
  private instances. Same code, two transports; stdio authenticates implicitly
  (local operator) but still respects `ALDINE_MCP_TOKEN` if set.

## 1.2 Auth for /mcp

- If `AUTH_ENABLED`: require a PAT (`Authorization: Bearer aldn_…`) — Claude
  connector configured with `static_headers`. Token resolution via Phase 0's
  `userFromToken`; project scope applies.
- If auth off: require `ALDINE_MCP_TOKEN` (operator-set static bearer,
  timingSafeEqual). **If neither is configured, `/mcp` returns 401 unconditionally**
  and the server logs a one-line setup hint at boot. There is no authless mode; the
  dangerous configuration must be unrepresentable.
- Auth check runs before any JSON-RPC body parsing. Per-message body cap ~2 MB on
  this route (global limit is 32 MB — too generous here).
- New `mcpLimiter` (ratelimit.ts pattern): 60 burst, 1/s sustained, keyed per token
  (fallback IP). Applied to every MCP request.

## 1.3 Tool surface (exactly these 8; names are API)

All tools take `project` and optional `branch`. If the PAT is scoped to exactly one
project, `project` becomes optional and defaults to it (the token is the context —
no per-conversation server state). Read-only tools set `readOnlyHint: true` so
hosts can auto-approve reads while gating writes. Every result echoes
`{branch, head}` (short hash) so the model can narrate what it touched.

1. `list_projects()` → `[{id, name, branches, rootFile, engine}]`
2. `project_structure({project, branch?})` → `{files:[{path,type,size}], rootFile,
   engine, contentVersion}`
3. `read_file({project, branch?, path, from_line?, to_line?})` → `{content,
   totalLines, contentVersion}` — flushes first (Phase 0 fix), caps ~100 KB, line
   ranges beyond that.
4. `edit_file({project, branch?, path, edits:[{quote, replacement, occurrence?}],
   base_version?})` → `{applied, contentVersion, snippet}` or
   `{error:'stale_anchor', edit_index, candidates:[≤3 nearest lines],
   contentVersion}`. Quote ≥8 chars, unique or disambiguated by 1-based
   `occurrence`. Tool description documents retry etiquette: re-read → re-anchor →
   retry, max 2.
5. `write_file({project, branch?, path, content, base_version?})` → `{ok,
   contentVersion}` or `{error:'version_conflict', currentVersion}`.
6. `batch_write({project, branch?, files:[{path, content}|{path, edits}],
   message})` → `{ok, contentVersion, commit}` — one flush, one refresh, ONE named
   commit.
7. `compile({project, branch?})` → `{ok, errors:[{type,file,line,message}],
   logTail (≤4 KB), pdfUrl, deepLink, durationMs, timedOut, contentVersion}`.
   NEVER the raw log (200 KB context bomb). Progress notifications every ~10 s
   ("queued behind 1 compile", "latexmk pass 2, 40 s") — required both for client
   tool-timeouts and the ALB 60 s idle timeout.
8. `commit({project, branch?, message})` → `{committed, hash}`.

Explicitly absent (see 00-overview non-goals): delete/purge, share, GitHub, token
management, branch create/merge (v2 at earliest).

## 1.4 Write-path algorithms (invariants are law; see also SECURITY.md)

Shared invariants: never reseed open docs; `refreshBranchDocsFromDisk` is the only
legal disk→doc push; flush before external reads/writes; evict (tombstone) before
delete/rename; `scheduleCommit` after mutations.

`edit_file`:
```
1. ensureWorktree(project, branch)            // the only await before the sync block
2. guards: canAccess / protected / trash / hidden-path / token scope
3. if the doc is open (hocuspocus registry hit):
     content = ytext.toString()
     resolve every quote(+occurrence) → {from,to}; any miss/ambiguity →
       return stale_anchor + candidates (NOTHING applied)
     apply back-to-front via applySuggestionToDoc — same synchronous tick, so
       atomic vs. human keystrokes; handle 'stale' defensively anyway
4. else (doc closed):
     flushBranchDocs(project, branch)         // other files' docs may be open
     read file, splice all edits synchronously, store.writeFile, bumpContentVersion
5. scheduleCommit
```

`write_file` / `batch_write`:
```
1. ensureWorktree; guards
2. flushBranchDocs(project, branch)
3. base_version mismatch → version_conflict (no write)
4. store.writeFile per file
5. refreshBranchDocsFromDisk(project, branch)
6. batch_write → commitAll(message)  |  write_file → scheduleCommit
```

Edits apply as ONE atomic Y.Doc transact per edit — no keystroke streaming (the
1.5 s debounce would flush half-applied LaTeX where autocommit/compile can grab it).

## 1.5 Compile budget

- Agent-originated compiles acquire a separate per-user gate of 1 concurrent AND
  still respect the shared 2-slot gate → the human always has a slot.
- Token traffic counts against the user's monthly quota (token → user) — correct,
  keep. Turn on `ALDINE_COMPILE_PER_MIN` in prod.

## 1.6 Agent presence + attribution (Aldine UI; see UX.md for full design)

- Awareness payload gains `isAgent: true`; MCP writes set awareness identity
  `{name:'Claude', color: <reserved agent violet>, isAgent:true}` while a tool
  session is active; expire when idle (~60 s).
- Presence chip renders agents with a glyph (not an initial) + reserved violet,
  `data-testid="presence-agent"`. Reserve the violet OUT of the human color picker.
- Fade highlight: CodeMirror decoration on agent-origin Yjs transactions, ~4 s
  decay. Pure decoration — byte-stability contract untouched (cursor-tour e2e must
  stay green). Behind `aldine.experimental.agentPresence`, announced in the command
  palette.
- Agent commits: author "Claude", message = stated intent (from `batch_write`
  message / tool call context). HistoryPanel marks agent-authored commits (violet
  dot; conditional class only).
- Session toast: when an agent session with ≥1 mutation goes idle — "Claude edited
  N files — Review" → existing DiffView modal over the session's commit range +
  "Revert these changes" (git revert of the range; never history rewrite).

## 1.7 Demo trial connector (from-the-start decision)

- demo.aldine.dev gets `ALDINE_MCP=1` + `ALDINE_MCP_TOKEN` (published token — the
  instance is a nightly-wiped sandbox; publishing the token is one-click-trial by
  design) OR authless-with-token-in-URL is NOT acceptable; the published static
  token in docs is the mechanism.
- Compose env in deploy/demo cloud-init template; verify wipe keeps working
  (volumes only; token is env).
- Docs page: "Try it: add https://demo.aldine.dev/mcp to Claude → Settings →
  Connectors with this header." Trial caveat: nightly reset.

## 1.8 Acceptance

- e2e (new spec, main suite): MCP SDK client against the dev server — full loop:
  list → read → `edit_file` incl. (a) stale-anchor retry case, (b) an edit against
  a file held open by a live collab session asserting merge-not-clobber →
  `batch_write` + single commit → compile → parsed errors present. This doubles as
  the Phase 0 regression net.
- e2e: `/mcp` with no credential → 401; wrong token → 401; scoped token crossing
  projects → 403.
- Unit: quote→offset resolution (unique, ambiguous, occurrence, ≥8-char rule),
  version_conflict, log-tail truncation.
- Typecheck + existing suites green; cursor-tour byte-stability green with
  presence/highlight code in.
- Deploy: task-def env vars; verify progress-notification cadence vs ALB idle
  timeout on prod; connect from claude.ai via static_headers; CHANGELOG.
- Dogfood exit criterion (gates Phase 2 → 3 promotion): two weeks daily use, no
  copy-paste, no anger-reverts.
