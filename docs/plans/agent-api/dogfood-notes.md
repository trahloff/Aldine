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
  `batch_write` for scoped commits.
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

## To confirm in real sessions

Owed before PR #13 leaves draft:
- [ ] A real claude.ai Connect run against staging, with the consent screenshot.
- [ ] A Claude Code HTTP session entry under "Observed".
- [ ] The live presence check (chip appears and leaves after the TTL).

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

Next revision: after ≥1 week of daily use (spec §2.2), fill "Observed" from
transcripts and move each answered question here with the change it drove.
