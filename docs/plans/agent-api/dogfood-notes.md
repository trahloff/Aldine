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

## To confirm in real sessions

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

Next revision: after ≥1 week of daily use (spec §2.2), fill "Observed" from
transcripts and move each answered question here with the change it drove.
