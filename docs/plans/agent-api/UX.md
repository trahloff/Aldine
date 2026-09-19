# Agent API — interaction design

The trust layer decides adoption. Principles: presence like a collaborator (not a
ghost, not a typewriter), git as the audit ledger, one glance to answer "what did
it touch?", and Claude's prose — not custom UI — as the error explainer.

## Agent presence (Phase 1)

- Awareness identity: name "Claude" (never "AI"/"Assistant"/model IDs; "Claude · 2"
  if ever concurrent), `isAgent: true` in the awareness payload.
- Color: ONE reserved desaturated violet (#a78bfa family, tuned for the dark
  default), removed from the human random-color palette — if a human can get
  agent-violet, the semantics collapse.
- Avatar: glyph (spark/asterisk from Icons.tsx), NOT an initial ("C" collides with
  human Claras). Tooltip "Claude (agent session started HH:MM)".
  `data-testid="presence-agent"`.
- Cursor: y-codemirror labels it for free; expires after ~60 s idle — a permanent
  agent avatar destroys the presence chip's meaning.

## Edits landing (Phase 1)

- Unit: anchored span splice (paragraph-to-section), ONE atomic transact each.
  Banned: keystroke simulation (dishonest, slow, uninterruptible, and a
  correctness hazard against the flush debounce) and whole-file swaps on open docs
  (viewport teleport reads as corruption).
- Legibility: inserted range gets an agent-violet background tint decaying ~4 s
  (CodeMirror decoration keyed on agent-origin Yjs transactions; pure decoration,
  byte-stability contract intact).
- Undo isolation: user's Cmd+Z must not swallow agent edits and vice versa
  (y-codemirror origin-tracked undo). e2e-pin this — it regresses silently.
- Conflict etiquette: server returns stale_anchor on drift OR when the user's
  cursor sits inside the target range. Claude re-reads, retries ≤2, then asks
  ("You're editing that paragraph — want me to hold off?"). No locks, ever.

## Audit and undo (Phase 1)

- Every agent mutation → commit with author "Claude" + intent message.
- HistoryPanel: violet dot on agent commits (conditional class, nothing more).
- Session toast on idle-after-edits: "Claude edited N files — Review" → existing
  DiffView modal over the session's commit range + "Revert these changes" (revert
  commit; never history rewrite). Two existing components, zero new panels.

## Tool-result etiquette (Phase 1–2, encoded in tool descriptions)

- Every result echoes branch + short hash → Claude narrates "edited related.tex on
  main (c6108d8)"; converts wrong-branch/stale-read mysteries into one-liners.
- Writes require explicit branch (scoped-token default aside); no silent defaults.
- Compile: progress notifications kill the 120 s dead air; fix loop hard-capped at
  3 narrated attempts, then stop and ask ("tried three fixes, still failing at
  related.tex:12 — revert, or look together?").
- Failure prose is user-fixable and honest: unreachable instance → "your Aldine
  isn't responding" (never claim an unconfirmed write succeeded); 403 protected →
  "that project is read-only"; 401 → "reconnect the Aldine connector".
- If human + agent compiles queue, the waiting side names the holder ("Waiting for
  Claude's typeset to finish").

## Settings: "Agent access" card (Phase 0)

The onboarding funnel — earns real design despite Aldine's slimness:
- "Create access token" → name (+ optional project scope, expiry) → token shown
  ONCE with copy field + "You won't see this again" + connector URL + "In Claude:
  Settings → Connectors → Add custom connector".
- Token list rows: name · created · last used (the built-in "is it connected?"
  debugger) · revoke.

## The viewer (Phase 3)

Preview, not editor: status row (file · branch · typeset time · pages), collapsed
error strip with deep links, page nav, zoom, "Open in Aldine". No recompile
button, no SyncTeX, no editing. Compile-fail state renders status + errors + exit,
never an empty frame. Full spec in 04-phase3-pdf-app.md.

## Explicitly not building

Agent activity sidebar, in-Aldine chat panel, per-edit accept/reject queues (the
comment-suggestion flow already exists for propose-mode), always-on "AI" chrome
branding.

## v2 with strategic teeth (post-Phase 4 candidate)

Agent edits as reviewable suggestions: Claude's changes arrive as tracked changes
via the existing suggestion machinery; accept/reject in the editor. Neither Prism
nor Overleaf has it; it solves the trust job structurally. Design doc required
before build.
