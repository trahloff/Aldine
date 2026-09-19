# Agent API — execution runbook (subagent workflows)

How each phase is implemented: orchestrated subagent workflows with adversarial
review gates. This file is the contract for whoever (or whatever) runs a phase.

## Ground rules for every workflow run

1. Specs are law: the phase doc + SECURITY.md + UX.md define scope. An implementer
   who wants to deviate records the deviation in the run summary for human review —
   it does not silently expand scope.
2. Repo conventions bind agents exactly as humans: comments state constraints only;
   `data-testid` on new UI; sentence-case concrete strings; CHANGELOG updated with
   the feature; lockfile committed when deps change; experimental UI behind
   `aldine.experimental.*` flags.
3. NO COMMITS and NO PUSHES from workflow agents. Working-tree changes only. Toby
   commits (public-repo commit-timing policy applies).
4. Never touch: `.git/hooks/`, deploy credentials, `.claude/`, anything in
   `docs/plans/agent-api/` except dogfood-notes.md.
5. Verification is not optional: typecheck (web) + server unit tests + the phase's
   named e2e specs must pass before review; full main e2e suite before a phase is
   declared done (compiler on :4020 with the e2e data dir — a compiler on the
   default .data makes compile tests fail while looking healthy).

## Canonical phase pipeline

```
Stage A  Implement (sequential agents, shared working tree — the touchpoints
         overlap, so parallel mutation is forbidden):
         A1 server changes → A2 web/UI changes → A3 tests (unit + e2e authoring)
Stage B  Verify: one agent runs typecheck + unit + named e2e specs; fixes
         mechanical failures; reports anything structural back instead of hacking
         around it.
Stage C  Review (parallel, read-only, each with a distinct lens):
         C1 correctness/data-loss (Yjs invariants, races, flush discipline)
         C2 security (SECURITY.md checklist, auth boundaries, injection surface)
         C3 conventions/UX (repo conventions, UX.md, strings, testids, CHANGELOG)
         Findings are adversarially verified (attempt to refute) before acceptance.
Stage D  Fix: apply confirmed findings; re-run Stage B checks.
Stage D' Fix review: the fix stage's diff gets the same adversarial review as
         Stage C (at least the lens whose finding it addressed). A fix that
         changes a pipeline (Phase 1's attribution split) is a design change and
         shipped four major defects when it went unreviewed. Never skip D'.
Stage E  Summary: diffstat, checks run + results, deviations, open questions.
         Human gate: Toby reviews + commits.
```

## Per-phase notes

- Phase 0: A1 = routes.ts/auth.ts/collab.ts/db (races, contentVersion, PAT); A2 =
  settings card + api client; A3 = conformance + unit + auth-e2e + flush-race e2e.
  C1 focuses on the flush/refresh ordering and the never-reseed invariant; C2 on
  the bearer path (timing-safe compare, token-cannot-manage-tokens, scope check
  placement in the preHandler).
- Phase 1: A1 = mcp/ module + limiters + compile gate; A2 = presence/highlight/
  toast/history dot; A3 = MCP-client e2e loop + auth-negative e2e. C1 adds the
  atomicity claim (edit resolution and apply in one tick — verify no await between
  read and apply); C2 adds the 401-unconditional rule and body cap. Extra stage:
  demo-box env wiring is a proposal in the summary, not an agent-executed mutation
  (infra changes go through Toby).
- Phase 3: viewer HTML is built as an asset with its own Playwright spec; signed-
  URL code gets a dedicated adversarial review (C2 checks the never-generalize
  rule and META_DIR secret placement).
- Phase 4: docs + plugin are parallelizable (different files); OAuth (if
  greenlit) is its own run with a dedicated security review stage.

## Review checklists (Stage C agents read these)

C1 correctness:
- Every external write: flush → mutate → refresh order? Evict before
  delete/rename? scheduleCommit after?
- Any new path that could reseed an open doc? (Grep for Y.Doc construction.)
- edit_file: read-resolve-apply synchronous? stale_anchor on every miss?
- contentVersion bumped by every disk change? 409 honored?

C2 security:
- Auth before parsing? No-credential → 401? Token scope enforced in shared
  preHandler, not per-route copies?
- New tools vs the forbidden list (delete/share/GitHub/tokens)?
- Secrets: nothing new under DATA_DIR; signing secret in META_DIR/env; no token
  in logs or error messages?
- Rate limits on every new mutating path?

C3 conventions:
- CHANGELOG entry present? Strings sentence-case + concrete? data-testid on new
  UI? Comments = constraints only? e2e for the headline behavior? Lockfile if deps
  changed? Byte-stability (cursor-tour) green if the editor was touched?
