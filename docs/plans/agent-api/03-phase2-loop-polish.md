# Phase 2 — Feedback-loop polish

Requires Phase 1 in daily use. Small, dogfooding-driven. 3–5 days.

## 2.1 New tools (wrapping existing server capabilities)

1. `references_add({project, branch?, query, bibFile?})` — wraps the existing
   DOI/arXiv → BibTeX endpoint (routes.ts `references/add`). Respects the existing
   refLimiter. Returns `{key, bibFile}` so the model can `\cite` immediately.
2. `list_citations({project, branch?})` — wraps `/bib` index → `[{key, title,
   author, year, file}]`. Exactly what the model needs BEFORE writing `\cite`
   (prevents invented keys, the #1 LLM LaTeX failure).
3. `list_labels({project, branch?})` — wraps `/labels` → `[{label, file}]`.
4. `wordcount({project, branch?})` — wraps `/wordcount`.
5. `create_project({name, template?})` — thin wrapper over POST /api/projects;
   requires an unscoped token (a project-scoped token cannot create).

All read-only tools: `readOnlyHint: true`.

## 2.2 Tuning (the part that makes the integration good)

After ≥1 week of dogfooding, revise from observed transcripts:
- Tool descriptions (the model's real API docs): retry etiquette wording,
  when-to-compile guidance, "prefer edit_file over write_file for open documents",
  3-attempt fix-loop cap with narration ("attempt 2 of 3: added natbib").
- `stale_anchor` candidate quality (nearest-line scan → better disambiguation).
- Log-tail size and error-filtering defaults (are parsed errors ever lossy? If a
  real session needed the raw log, add `read_log({tail_kb})` — NOT before).
- Error messages as user-fixable prose (connector unreachable, protected project,
  quota exceeded → the model should relay, not retry-spin).

## 2.3 Acceptance

- e2e extended: references_add (mock upstream), list_citations, scoped-token
  create_project 403.
- A written dogfood log (docs/plans/agent-api/dogfood-notes.md) with observed
  failure modes and the tuning applied — this is the input Phase 3/4 reviews check
  against.
- CHANGELOG.
