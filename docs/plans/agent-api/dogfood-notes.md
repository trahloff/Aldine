# Dogfood notes — agent API (Phase 2 tuning log)

Structured log for spec §2.2/§2.3. Every entry carries a date, the tool(s)
involved, and where it was observed (e2e/unit, a real Claude session, or
prod logs). Phase 3/4 reviews check the tuning against this file.

Conventions:
- One bullet per observation; link to the transcript/test where one exists.
- "Applied tuning" entries name the description or code change and the
  observation that motivated it — never a change without an observation.
- Open questions stay under "To confirm in real sessions" until a session
  answers them; then they move to "Observed" (with the answer) and, when
  they lead to a change, to "Applied tuning".

## Observed in e2e/unit

- 2026-09-02 · `edit_file`/`write_file`/`batch_write` · fix-review stage ·
  Human's uncommitted edits in the same file were co-mingled into the
  Claude commit until the pre-write checkpoint landed (`gitops.checkpointPaths`).
  Applies to `references_add` too, which is why `addReference` checkpoints
  the `.bib` when called with an author.
- 2026-09-02 · presence · fix-review stage · `markAgentPresence` was a silent
  no-op (y-protocols `setLocalStateField` on a null local state) — the chip,
  fade, and session toast could not appear in any session before the fix. A
  real-session check that presence actually shows is still owed (see below).
- 2026-09-02 · `references_add` · unit (`mcp-tools.test.mjs`) · A title
  query ("Attention is all you need") consumes a lookup token and returns
  "No reference found". The description now says titles are not lookups; if
  transcripts show the model still trying titles, consider refusing
  DOI-less queries *before* taking the token.
- 2026-09-02 · `references_add` · unit · The refLimiter (30 burst, 0.5/s)
  is shared with the human's reference panel per user. An agent adding a
  bibliography of 30+ entries in one go will hit it; the description says to
  relay the budget error rather than loop. Not yet observed in practice.
- 2026-09-02 · `list_citations` · unit · Rows are exactly `{key, title,
  author, year, file}`; `year` is a string (BibTeX field), `author` is the
  raw field ("Doe, Jane and Roe, Ron"). Nothing is truncated — a 500-entry
  `.bib` returns ~50 KB. Watch for context cost in real sessions.
- 2026-09-02 · `create_project` · unit · A project-scoped token is refused
  before any state change; the message names the fix (unscoped token).
  Templates come from `templates/` (`article`, `beamer`, `iac-paper`,
  `report`); an unknown id lists the available ones.
- 2026-09-02 · `commit` · review · Commits the whole tree, so a human's
  flushed typing lands under Claude's name and explicit commits consume
  pending attribution. The description now warns and steers to
  `batch_write` for scoped commits. Fixed 2026-09-06 (scoped to the agent's
  own paths, see Applied tuning).
- 2026-09-06 · `edit_file`/`write_file`/`batch_write`/`references_add` · unit
  (`autocommit-split.test.mjs` p5, `autocommit-race.test.mjs`) · An autosave
  firing during the pre-write checkpoint swept the agent's delta into
  `aldine: autosave` (no Claude commit, no review coverage) or collided on
  `index.lock`; reproduced 5 of 8 runs at a 120 ms debounce. Fixed with the
  per-repo write lock (`gitops.withRepoLock`) and the attribution taken
  under it. Still open by design: keystrokes typed into the same file
  between the agent's write and the debounce fire land in the Claude commit
  — closing that needs the attributed commit built from the agent's
  snapshot with plumbing (hash-object / commit-tree), not from the working
  tree.

- 2026-09-06 · `edit_file`/`write_file` + checkpoint · QA (PM loop) ·
  Commit titles misattributed intent: one pending message per branch window
  meant a checkpoint of `main.tex` was titled with the later `write_file`'s
  "Update notes.tex", and `references_add`'s "Add reference …" swallowed a
  15-line rewrite of `main.tex`. Fixed: intents are per path
  (`gitops.registerAttributedPaths`), one commit per intent at the fire and
  at the checkpoint; `edit_file`/`write_file` take an optional `message`.
  Pinned in `autocommit-split.test.mjs` (p8), `mcp-tools.test.mjs` and
  `15-mcp` ("commit titles follow each write's own intent").
- 2026-09-06 · `compile` · QA (PM loop, compiler on a different DATA_DIR) ·
  "root file not found" came back as a normal failed compile with no errors,
  which the description tells the model to fix-and-retry — a write loop on a
  healthy project. Fixed: compiler-side setup errors are `isError` results
  that tell the model to relay; no `[metric] agent_compile` line for them.
  A missing `.sty` (BasicTeX without biblatex) is now a `hint` naming the
  package; rows without a file fall back to the root file.
- 2026-09-06 · revert · QA (auth on) · "Revert these changes" was authored
  "Writer 457" for a signed-in "PM Stranger". Fixed server-side: with
  `AUTH_ENABLED` the revert, checkpoint and merge routes commit under the
  account name and ignore the browser's name; the toast says "Reverted
  Claude's edits as <name>". Pinned in the auth suite (`mcp.spec.ts`).
- 2026-09-06 · History panel · QA · Did not refresh while open: agent
  commits and the revert stayed invisible until a tab switch. Fixed: refetch
  on the files signal, after a revert, when the session toast fires, and
  every 5 s while the agent is present.
- 2026-09-06 · session review · QA · The review prompt only reached someone
  who had the editor open while Claude worked; a person who opened the
  project afterwards (the claude.ai case) saw nothing but violet dots in
  History. Fixed: the prompt is now driven by a per-user, per-branch visit
  mark (`project_visits` / `visits.json`, localStorage without accounts)
  instead of presence alone; `GET /api/projects/:id/agent-activity` answers
  it read-only and the mark is cleared only by a session, never by a token.
  Pinned in `16-agent-ui` ("a project Claude changed while nobody watched
  prompts a review on the next open"), the auth suite (`mcp.spec.ts`,
  per-user mark) and `agent-review.test.mjs`.

## To confirm in real sessions

Owed before PR #13 leaves draft:
- [ ] A real claude.ai Connect run against staging, with the consent screenshot.
- [ ] A Claude Code HTTP session entry under "Observed".
- [x] The live presence check (chip appears and leaves after the TTL).
      2026-09-17, local stack in Chromium: chip joins on the first edit,
      leaves 60 s after the last. Caveat found the same day: a reload by
      the sole viewer drops it for the rest of the visit (see Observed).

Tool descriptions (§2.2):
- Does the model actually re-read after `stale_anchor`, or does it guess a
  new quote from the candidates alone? Are 3 candidates enough, and is the
  bigram scorer picking the right line on real LaTeX (long lines, macros)?
- Does "at most 2 retries, then ask" hold, or does the model loop?
- Does the model reach for `write_file` on existing files despite the
  steer? Which phrasing of "prefer edit_file" it responds to.
- When does the model compile — after every edit, or after a coherent set?
  Is "never just to check syntax" respected?
- Is the 3-attempt fix-loop cap narrated ("attempt 2 of 3: …") or silent?
  Does the model stop at 3 and quote file:line?
- Does the model call `list_citations` before every `\cite`, or only when
  reminded? Are invented keys still appearing in compile errors?
- Is `list_labels` used before `\ref`/`\cref`, or ignored?
- Does the model relay unreachable / read-only / quota / budget errors, or
  retry them? Which of the four wordings gets retried anyway?

Result shapes:
- `stale_anchor` candidate quality: nearest-line scan vs. a smarter
  disambiguation (spec §2.2 bullet 2) — collect misses.
- Log-tail size (4 KB) and parsed-error filtering: was a session ever
  blocked because the parsed errors were lossy and the log tail did not
  contain the cause? Only if yes: `read_log({tail_kb})` (spec: NOT before).
- `list_citations` size on a real bibliography — does it need a `query`
  filter or pagination?
- `wordcount` — does the model trust it over source estimates?

Presence / audit:
- Presence chip, fade highlight, and session toast actually appear in a real
  claude.ai session against prod (the unit fix landed 2026-09-02; nothing
  has been seen live yet).
- Does the session toast fire at a sensible idle time (~60 s) for real
  conversational pacing, or mid-session?
- [ ] The away prompt across devices: acknowledge on the laptop, open the
  same project on another machine signed in as the same account — no second
  prompt.

Operational:
- Progress-notification cadence vs. the ALB 60 s idle timeout on prod
  during a long compile.
- Does `references_add` on prod reach doi.org/arXiv (egress) — the app
  container has egress, the compiler does not; confirm the app's.

## Connect flow (OAuth, 06-oauth.md) — checklist for the live check

Toby's manual acceptance against staging, from the default connector
settings. Tick each with the date; anything that fails becomes an
"Observed" bullet with the exact symptom.

claude.ai (Settings → Connectors → Add custom connector, URL
`https://<staging>/mcp`, authentication "Always required", "Use Anthropic's
hosted client metadata"):
- [ ] Add → Connect opens `/oauth/authorize` on staging with the client's
      name and `claude.ai` as the host on the consent card (CIMD fetched,
      not a DCR fallback).
- [ ] Signed out: the sign-in form appears inline; after signing in the
      page stays on `/oauth/authorize` (password) or resumes there (SSO).
- [ ] "Only these projects" with one project → Allow → claude.ai shows the
      connector as connected without a second prompt.
- [ ] In a chat: `list_projects` returns exactly the picked project;
      `read_file` works; a project outside the scope is a tool-level refusal.
- [ ] Deny → claude.ai reports the connection was declined, no token appears
      on the Agent access card.
- [ ] Agent access card: the token is listed with the client name and the
      "via Connect" badge; Revoke there → the next tool call in claude.ai
      fails with an auth error and reconnecting asks for consent again.
- [ ] Leave the connector for > 24 h → the next call still works (refresh
      rotation happened silently; only one live token per connector on the
      card).
- [ ] Wrong host settings: connector URL without `/mcp` → the discovery
      probe fails cleanly (no HTML answer from `/.well-known/*`).
- [ ] Auth off (static token): Add custom connector with
      `X-Aldine-Token: <ALDINE_MCP_TOKEN>` in the additional request headers
      and no Connect → `list_projects` lists every project. Record the exact
      label of that field in the dialog; docs/AGENT_API.md "With a static
      token (auth off)" describes it from the 2026-09-02 staging session and
      must match. If the field only exists for OAuth connectors, the doc must
      say auth-off instances get Claude Code only.

Claude Code (`claude mcp add --transport http aldine https://<staging>/mcp`,
then `/mcp` → login):
- [ ] The browser opens the consent page; the card warns that the client
      redirects only to this computer (loopback-only client).
- [ ] Allow (all projects) → Claude Code reports authenticated;
      `list_projects` lists everything.
- [ ] `/mcp` → logout, then login again → a fresh consent, a fresh token; the
      old one is gone from the card.

Operational:
- [ ] `ALDINE_PUBLIC_URL` is set on the staging task — the discovery
      documents name `https://<staging>` as issuer, not the ALB host.
- [ ] Server logs show no token, code, or refresh secret on any OAuth error.
- [ ] `RL_OAUTH_*` defaults were not hit during the manual run (no 429 in
      the logs).
- [ ] Prefix deployment (`ALDINE_BASE_PATH`): the Agent access card shows
      `<origin><prefix>/mcp`,
      `curl https://<host>/.well-known/oauth-authorization-server<prefix>`
      answers with `issuer` = `<origin><prefix>`, and claude.ai's Connect
      completes (the proxy forwards the origin-root well-known paths).

## Observed in real sessions

### 2026-09-03 · session 1 · Claude Code → staging (OAuth, loopback) · project "Dogfood: Agent API session 1"

Loop: create_project (article) → structure/read/list_citations/list_labels →
references_add (arXiv id) ∥ edit_file (5 edits) → compile → inject an error →
compile → fix → batch_write (new sections/ file + \input) → compile. Wall time
about four minutes; compiles 4–9 s.

Worked first time: anchored edits with a snippet back; stale_anchor with three
ranked candidates; references_add resolved the arXiv id to `vaswani2017`;
wordcount; labels picked up the new file after batch_write; batch_write landed
as one named commit; ping reports the user.

Friction, ranked:
1. `contentVersion` is per branch, not per file. references_add wrote
   references.bib and bumped it, so a simultaneous edit_file on main.tex with
   the version from its own read got `version_conflict` although main.tex had
   not changed. A model working two tools in parallel hits this every time.
   Applied 2026-09-06 (per-file conflict check, see Applied tuning).
2. A clean compile returned 4 KB of font-loading log as `logTail`. Applied:
   empty tail on success.
3. `errors` came in log order; the one real error was item four behind rerun
   and citation warnings. Applied: errors first, then warnings.
4. With errors present the PDF is the whole document (run-to-end is on) but
   latexmk skips biber and the reruns, so citations and cross-references are
   undefined and the bibliography is empty. The result gave no hint. Applied:
   description tells the model to say so; `pdfStale` and `pages` added to the
   result so a model can report "2 pages, bibliography not rebuilt".
5. Every result echoes the ≤4 KB tail even when the model only wants the
   parsed errors; with 2 above this is now only on failure.

Presence and review, observed with the editor open in Chrome (afternoon):
- The violet spark avatar joins the header the moment an edit lands and
  leaves 60 s after the last one (presence TTL). Edits show live in the
  editor; the History tab lists them as Claude with the violet dot.
- The session-review toast ("Claude edited 1 file · Review") DID appear —
  64 s after the last edit, for 8 s, bottom centre. Toby missed it in his
  own test and so did the first screenshot pass here; only a screenshot at
  t+64 s caught it. Applied: the review toast is sticky (stays until Review
  or × is clicked). Still open: 64 s is long for "the session ended" in a
  chat flow; a 30 s TTL would halve it but a compile in the same turn can
  take longer than that, which would split one turn into two reviews.

### 2026-09-17 · local stack · six automated browser sessions (Playwright)

Auth on, compiler on the e2e data dir, MCP calls through the tool script
against `/mcp`. Each session played one person: typing beside Claude
(presence), minting tokens (tokens), a loopback Connect client (oauth),
coming back to a project Claude changed (return), the same flows at 390 px
and in the light theme (responsive), and a newcomer following AGENT_API.md
(stranger). 33 findings confirmed by two independent verifiers (5 major,
16 minor, 12 nit), 8 refuted; full report with screenshots:
`browser-qa-2026-09-17.md` (scratchpad, 2026-09-17), shots under
`qa-shots/<session>/`.

Worked first time: anchored `edit_file` edits merge with live typing and keep
the cursor; the chip appears on the first edit and leaves after the 60 s
TTL; the sticky session toast, Review → DiffView and the revert authored
under the account name; the away prompt on the next open; registration →
consent → PKCE exchange → refresh rotation → revoke on the card with the
"via Connect" badge; scoped tokens refused outside their scope before any
state change; the docs' probe answers a correct RFC 6750 `WWW-Authenticate`.

Friction, ranked (majors only; the rest is in the report):
1. `batch_write` on an open document is a whole-file swap: edits are spliced
   on disk and `refreshBranchDocsFromDisk` reseeds the Y.Text with
   `delete(0,len)+insert(0,content)`, so every line flashes violet and the
   person's caret lands on line 1 — their next keystrokes went in front of
   `\documentclass`. UX.md bans exactly this; `edit_file`'s live path
   (`applySuggestionToDoc` per span) does not have it. Fix: route
   edits-entries for open docs through the `edit_file` path, reseed only
   content-entries.
2. The "still open by design" note above (2026-09-06) bit for real: a line
   typed between edit #2 and edit #3 was committed inside Claude's
   "Name the problem in the introduction" by `checkpointPathsHeld`, History
   Save answered "No changes since last checkpoint", and "Revert these
   changes" deleted the person's sentence. The snapshot-built attributed
   commit is now owed, not optional.
3. Account modal at 1280×800: after "Create access token" the form, and after
   Enter the shown-once token with its Copy button, sit under the sticky
   Close/Update-password footer (`.modal` 70vh, no `scroll-padding-bottom`;
   autoFocus does not scroll past a sticky row). A person reads "copy the
   token now" with nothing to copy. Focus also drops to `<body>` after mint.
4. Reload during a running session: the sole viewer's disconnect unloads the
   doc (Hocuspocus default `unloadImmediately`), `markAgentPresence` is a
   no-op on an unloaded doc and `onLoadDocument` never re-applies it, so the
   chip is gone for the rest of the visit and later commits raise no session
   toast; meanwhile the away check reads `agentPresentRef` before awareness
   syncs and says "while you were away" to someone who was watching.
5. Phone (390 px): the ≤640 px rule hides `.split-pdf, .pdf-pane`, a class
   the markup no longer uses, so `.pane--preview` keeps its inline 360 px and
   the editor is a 30 px column — Claude's edit cannot be seen. Pre-existing
   on main, reachable now through phone deep links to the edited line.

Also observed: the first edit of a session lands untinted because
`markAgentPresence` runs after the apply loop (awareness arrives after the
doc update; the e2e asserts the tint only on edit 2); the preview keeps
Claude's PDF under a green "Typeset in 1.0s" after a revert (reseed is a
remote transaction, `revertAgent` never arms a typeset); the conflict revert
toast reads "Could not revert: Could not revert cleanly …" and leaves the
modal open; away and session review toasts stack; the signed-in person is
still "Writer NNN" in the presence strip beside a named Claude; the card's
Claude Code line prints a literal `<connector URL>`. Refuted, for the
record: Escape closing the create form (Modal contract), the four expiry
presets, the toast wording, the per-user 429 compile gate, and a misread
"light editor" screenshot.

Answered from this run: presence chip, fade and session toast do appear
live (local, not prod); the session toast fires ~60 s after the last edit,
as before. Not answered: the away prompt across devices, and everything
that needs claude.ai or Claude Code as the client.

### 2026-09-17 · staging · five automated MCP sessions

Five scripted Claude sessions on one account (writing, existing project, edge
cases, concurrency, first-time "stranger"), each finding reproduced once more in
a fresh project and checked against the code before it counted. Full report with
repros and code pointers: `dogfood-staging-2026-09-17.md` (scratchpad, not
committed). About forty "Dogfood QA 2026-09-17 verify-*" projects remain on
staging; the API has no delete tool.

Worked first time, every session: ping; create_project with default, blank,
iac-paper and venue kits; anchored edits with base_version, occurrence and a
snippet back; the per-file conflict check (session 1 friction #1 is gone — a
stale branch version passes when the file did not change, a stale write is
refused with nothing landed, also under three parallel writes in one turn);
batch_write atomic on a refused entry; references_add for DOI, doi.org URL,
arXiv (bare and prefixed) and OpenAlex ids with duplicate detection;
list_citations over every .bib; commit scoped to Claude's files, committed:false
when nothing pending; get_pdf_url refusing cleanly before the first compile.
Compiles: starter (biber) 4.8–5.4 s, minimal article 0.4–0.6 s, unchanged
document 117–183 ms, 1500 pages 11.8 s. Autocommit debounce 20 s, head moved
within ~30 s. The per-account compile gate fired once (another session
compiling at the same second) and released as documented.

Friction, ranked (31 confirmed; 8 refuted, mostly by-design behaviour the
descriptions already cover):
1. compile on a rootless project says "your Aldine compiler may not be
   responding". compile.ts throws the right message ("No .tex file to
   typeset"); the tool's catch-all (tools.ts:727-729) replaces it, and the
   description tells the model to relay that error and never retry. Hit on
   the documented blank-template path. Same catch-all turns an unknown branch
   into a compiler outage.
2. A fatal run that wrote no PDF returns pdfStale:false, a freshly minted
   pdfUrl and the previous run's typesetAt (pages:null is the only clue). The
   compiler's pdfFresh is one mtime-vs-sentinel check that passes for the old
   PDF on staging's shared volume (compile.ts:314-316, compiler/server.js:264-296).
   The same freshness bit lets a previous run's Biber row leak into a compile
   that died in the preamble.
3. references_add appends Crossref titles verbatim: the Stochastic Parrots DOI
   carries a U+1F99C emoji that pdflatex rejects at \end{document}, and the
   parsed error points at main.tex with no mention of the .bib. Also
   `month=June/July/Sept` macros biber rejects on every build. sanitizeBibtex
   (references.ts:42) only decodes entities and escapes &/%.
4. write_file onto a folder, or under a parent that is a file, returns "The
   request failed on the Aldine server" (EISDIR/ENOTDIR unmapped, store has
   isDirectory but the MCP path never asks). A trailing slash silently makes a
   file named like the folder, which then triggers the same error on the next
   write.
5. The MCP writers never adopt a root (REST does, via adoptRootIfUnset), so
   after write_file main.tex on a blank project wordcount returns total 0 with
   no note until the first compile. A model relays "0 words" for a 14-word
   document.
6. errorsTotal is the mixed rows count: every fresh project's first compile is
   `{ok:true, errorsTotal:2}`. Three sessions independently read it as an
   error count. Biber warnings are stamped file:main.tex, line:null although
   the .bib line is in the message. Undefined-control-sequence errors omit the
   token (the `l.NN …` form is skipped by the compiler parser) and the 4 KB
   positional log tail loses it after a few dozen warnings.
7. head echoed by edit_file/write_file/references_add is the commit before the
   write (debounced autocommit); batch_write returns its own. Descriptions say
   "Committed as author Claude" and "Every result echoes {branch, head}" with
   no timing caveat; error bodies echo nothing; short vs 40-char hashes.
8. Error wording: 'Branch not found' / 'Project not found' / 'Invalid file
   path' (five causes) name neither the value given nor the fix, unlike the
   file message that does; a doi.org 404 is relayed as "Reference lookup
   failed: DOI lookup failed (HTTP 404)" — the 2026-09-02 tuning aimed at
   outages, but for 404 it steers the model to report an outage instead of a
   wrong DOI while arXiv unknowns get "No reference found"; stale_anchor
   candidates are the first 200 chars of a paragraph-length line and never
   contain the quote; read_file returns "" for a window past the end or
   inverted; .dat (pgfplots data) is "a binary file" to read_file but
   writable and editable.
9. Docs: AGENT_API.md never explains contentVersion/fileVersion/base_version
   or the two error shapes and sends script authors to a test file; "Every
   tool takes project and branch" is false for three tools; venue kits and
   iac-paper are absent from the template description; the 200-char message
   limit surfaces only as raw zod text.

Refuted: the per-account compile lock (by design, SECURITY risk #4), commit
result shape (documented), coalescing concurrent compiles (calls were
serialised; the fast run is latexmk finding nothing to do), raw zod text for
schema bounds (actionable as is), the "LaTeX Warning:" prefix (carries the
source), windowed read_file not echoing its window.

## PDF in chat (Phase 3, 04-phase3-pdf-app.md §3.4) — manual matrix

The viewer needs an Aldine the host sandbox can reach: the iframe's fetch
goes to `ALDINE_PUBLIC_URL`, so `localhost` never works from claude.ai —
use staging or a tunnel, and set `ALDINE_PUBLIC_URL` to that origin (the
CSP allowlists exactly it). Tick with the date; a failure becomes an
"Observed" bullet with the exact symptom and the host.

claude.ai web (Chrome + Safari):
- [ ] "Typeset my paper" → the compile card renders the PDF inline: status
      row shows `main.pdf · main · typeset <time> · N pages`, page 1 within
      ~2 s of the card appearing, pages white in both the light and dark
      claude.ai themes.
- [ ] Scroll the well → later pages rasterize on approach, none stay blank;
      ‹ › and the page counter track the scroll.
- [ ] Zoom − / + → 100 % is fit-width in the ~750 px column; 125 % adds a
      horizontal scroll inside the well, never on the chat page.
- [ ] "Open in Aldine" opens the project in a new tab (host link flow), the
      chat stays put.
- [ ] Ask for the PDF again 20 min later → the model calls `get_pdf_url`
      (not `compile`), the new card renders; the old card shows "This PDF
      link has expired" with a working Open in Aldine, not a blank frame.
- [ ] Failing compile (add `\thisisnotacommand`): the card shows
      "Typesetting failed", the amber strip is expanded with `main.tex:N`
      rows, no canvas; a row click opens Aldine at that line, flashes it,
      and the URL drops `?file=&line=`; "Show the previous PDF" (when one
      exists) loads it in place with the "previous PDF" marker.
- [ ] Figure-heavy ~10 MB PDF (the demo paper with the full-resolution
      figures, or a scanned appendix): first page still within ~3 s,
      scrolling stays smooth, memory in the tab does not climb page by page
      (bitmaps are released off-screen); note the actual size and timing.
- [ ] Mobile web (or the narrowest window claude.ai allows): the well
      shrinks with `containerDimensions`, controls stay reachable; if the
      host offers no app frame, the text result with `pdfUrl` + `deepLink`
      is what the model shows.
- [ ] Two compiles in one conversation → each card keeps its own PDF (the
      second card must not hydrate the first).

Claude Desktop (macOS):
- [ ] Same first three rows as web; note whether the app frame is offered at
      all and whether the fullscreen toggle (`viewer-expand`) appears.
- [ ] Open in Aldine hands off to the default browser.

Cowork:
- [ ] Compile from a Cowork task → the card renders; error-row deep link
      opens the browser at the line.

Server side, once per host:
- [ ] The compile card's `pdfUrl` fetch shows in the server log as an
      anonymous `GET /output` with `sig`, `access-control-allow-origin: *`,
      one request per card (no retry storm); nothing else in the log carries
      `sig=`.
- [ ] `ALDINE_SIGNING_SECRET` unset → `META_DIR/output-signing-secret`
      exists (0600) and survives a redeploy; set → no file.
- [ ] Run the three Logs Insights queries from deploy/README.md once against
      real prod `[metric]` lines: `user` and `project` parse as bare ids
      (no `ok=…`/`ms=…` tail in either field) and query 2 shows one row per
      project, not one per compile.
- [ ] Record the GIF (web, light theme): typeset → card → scroll → error
      strip → deep link.

## Applied tuning

- 2026-09-02 · all tool descriptions · Rewritten as the model's API docs
  (spec §2.2 first pass; motivated by the spec's list, not yet by
  transcripts): each states when to call, what the result means, and the
  failure etiquette. Specifics: `edit_file` — re-read → re-anchor from
  candidates → ≤2 retries → tell the user what was tried; `version_conflict`
  → re-read, re-apply once. `write_file` — "prefer edit_file for an existing
  file", conflict → re-read, re-write once, then ask. `batch_write` — fix the
  stale entry and resend the whole batch; imperative intent message.
  `compile` — compile after a coherent set of edits, never for syntax; ≤3
  narrated attempts ("attempt 2 of 3: added natbib"), then stop and quote
  file:line; unreachable/quota/already-running → relay. `commit` — warns it
  commits collaborators' typing under Claude. `ping` — failure means relay,
  not continue. `list_citations` — "always call before writing \cite, never
  invent a key". `references_add` — titles are not lookups; budget/upstream
  failure → relay. `create_project` — scoped-token refusal → relay, names
  where to mint an unscoped token.
- 2026-09-02 · `references_add` · Attribution parity with the other write
  tools (checkpoint the `.bib`, commit as "Add reference <key>" by Claude)
  so the session-review toast covers bibliography changes too.
- 2026-09-06 · auto-typeset · PM QA note ("the source moved and the PDF did
  not for two minutes") · An agent write now signals the branch and every
  open editor arms the auto-typeset debounce; the branch elects one client so
  N tabs cannot race the compile gate, and a typeset the agent starts itself
  cancels the pending one and is adopted through the new compile-status
  route rather than duplicated.
- 2026-09-02 · `references_add` · Upstream errors are relayed with the
  status ("Reference lookup failed: DOI lookup failed (HTTP 404)"); a bare
  network failure is worded as "could not be reached from your Aldine
  server" so the model does not claim the DOI is wrong.
- 2026-09-06 · `edit_file` / `write_file` / `batch_write` / `PUT /file` ·
  Conflicts are per file (session 1 friction #1): the branch
  `contentVersion` stays the `base_version` a model passes, but a write is
  refused only when its own file changed after that version — git-level
  rewrites (revert, merge, pull, reset) count for every path, a base newer
  than the branch is refused as unknowable. `read_file` and the write
  results carry `fileVersion`; `batch_write` takes `base_version` per entry;
  descriptions say "writes to other files never conflict, so parallel tools
  on different files are safe".
- 2026-09-06 · `commit` · Scoped to Claude's own work: the tool commits the
  paths the attribution ledger (`gitops.pendingAttributed`) holds for that
  branch, as one commit under the caller's message, and leaves everything
  else to the anonymous autosave — a whole-tree commit signed a
  collaborator's flushed typing as Claude and put it inside "Revert these
  changes", and the description had to warn about the tool itself. Nothing
  pending is now `committed:false` with the head, not an error, so a model
  calling `commit` after its edits already auto-committed reports "already
  committed" rather than a failure. The description names the scope, keeps
  steering to `batch_write` for a change being made now, and no longer warns
  about a behaviour the tool does not have. Pinned in `mcp-tools.test.mjs`
  and `15-mcp` ("the commit tool commits only the files Claude wrote").

Next revision: after ≥1 week of daily use (spec §2.2), fill "Observed" from
transcripts and move each answered question here with the change it drove.
