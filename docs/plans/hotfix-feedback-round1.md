# Hotfix: feedback round 1 (bugs only, no behavior changes)

Branch `hotfix/feedback-round1` off `main` (e52c4a0). Ships as its own release before
the Agent API branch. Scope is strictly bugs + the missing engine UI; anything that
changes compile semantics (`-halt-on-error`), import auto-detection, blank projects,
templates, ORCID is OUT (tracked as GitHub issues).

Source: user feedback from a long-time Overleaf user on prod + code diagnosis
(file:line below are on main).

## H1 Import: body limit and honest messaging (S)
- `apps/server/src/index.ts:30` global `bodyLimit` 32 MB caps zip imports at ~24 MB raw
  (base64 ×4/3) while `apps/web/src/pages/Home.tsx:64` and `routes.ts:411` promise 60 MB.
  Reproduced: 25 MB zip → 413 "Payload Too Large" in 5 ms.
- Fix: route-level `bodyLimit` on `POST /api/projects/import` = 60 MB × 4/3 + 1 MB
  (keep the global limit unchanged); `deploy/nginx.conf:38` `client_max_body_size`
  raised to match (+ fix its comment at :10-11). Toasts state the real limit and size
  ("ZIP is 25 MB; the limit is 60 MB" / on 413: "ZIP too large for this server").
- Orphan on failure: `routes.ts:410-433` creates the project BEFORE writing binaries; a
  path failure in the loop returns 400 but leaves a half-imported project. Validate all
  entry paths (segment-wise `..` check — `p.includes('..')` at :413 also drops legitimate
  `data..csv`; use the `util.ts:16` segment logic; also reject/convert backslash paths)
  BEFORE `createProject`, and delete the project in the catch if creation already happened.
- Tests: server test with a >32 MB base64 body (route accepts), orphan test (bad path
  → 400 AND no project left), unit for path filter.

## H2 Import: root-file detection (S)
- `apps/server/src/unzip.ts:52-63` `guessRoot`: largest `.tex` with `\documentclass` in
  the first 4 KB. Journal templates have >4 KB comment banners (missed); bundled
  `sample.tex` outsizes the manuscript (wrong root); fallback picks the first `.tex` in
  central-directory order or the literal `main.tex`.
- Fix: scan whole file (cap ~256 KB) for `\documentclass` AND prefer files containing
  `\begin{document}`; prefer names `main|paper|manuscript|ms|article|thesis(.tex)`;
  prefer shallowest path; tie-break smallest. Never return a non-existent `main.tex`:
  if nothing qualifies, first `.tex` by shallowest path.
- Tests: unit table for the above cases (banner, sample.tex decoy, nested root,
  no-documentclass fallback).

## H3 Compiler image: publisher classes (S)
- `apps/compiler/Dockerfile:25-26` `tlmgr install` list lacks `collection-publishers`
  (elsarticle, IEEEtran, acmart, revtex4-2, agujournal, copernicus…). Add
  `collection-publishers` to the medium install line. Keep the snapshot pin.
- Also pin `latest-full` (`Dockerfile:28`) by digest like medium — hygiene, no
  behavior change. (Document the digest source in the existing comment style.)
- Note in CHANGELOG that self-hosters must rebuild the compiler image.

## H4 Engine: validation + picker (S)
- `routes.ts:458` PATCH accepts any string for `engine`; compiler silently falls back
  to pdflatex. Validate against `['pdf','xelatex','lualatex']` → 400 otherwise.
- UI: a `<select>` in the Preview pane header (`Editor.tsx:739-773`, next to zoom)
  labelled by engine name (pdfLaTeX / XeLaTeX / LuaLaTeX), calling `api.patchProject`
  then `loadProject()` — copy the `rootFile` pattern at `Editor.tsx:596-600`. Plus three
  palette commands "Typeset with pdfLaTeX/XeLaTeX/LuaLaTeX" in the `commands` memo
  (`Editor.tsx:417-433`). `data-testid="engine-select"`. Changing engine triggers a
  re-typeset if a compile result exists.
- e2e: switch engine via select → project meta reflects it → palette command works.

## H5 Forward SyncTeX (editor → PDF) (S)
- Exists (`Editor.tsx:393-403` `jumpToPdf`, ⌘J at `CodePane.tsx:308`, palette
  `Editor.tsx:421`) but: (a) broken for sub-directory roots — `apps/compiler/server.js:214-215`
  passes the project-relative file while synctex records root-dir-relative names (the
  inverse direction normalizes at `:230-240`; mirror it: `path.relative(rootDir, body.file)`
  with cwd consistent); (b) ⌘J bound only inside CodeMirror — add to the window handler
  at `Editor.tsx:251-263` like ⌘S; (c) silent failure at `Editor.tsx:400/402` — toast
  "No PDF location for this line — typeset first" / "Jump unavailable for this file";
  (d) no affordance — add a small "Jump to PDF" button in the editor pane header with
  the shortcut hint, `data-testid="jump-to-pdf"`.
- e2e: project with root in a subfolder (`paper/main.tex` + `paper/sections/a.tex`):
  ⌘J from a line in `sections/a.tex` → PdfPane scrolls + `.pdf-flash` appears. Runs the
  compiler.

## H6 Inverse SyncTeX + stale preview honesty (S)
- On a failed compile the compiler returns the OLD pdf (`server.js:188-195` keys on file
  existence, not `ok`) and `compile.ts:73-75` mints a FRESH cache-buster → the pane
  re-renders a stale/truncated PDF as if fresh, while the editor has moved on → inverse
  jumps land N lines off. `Editor.tsx:783` passes `onInverse` unconditionally; every
  failure path is silent (`Editor.tsx:375,387,389`).
- Fix (no compile-semantics change): (a) `compile.ts` — when `!ok`, do NOT mint a new
  `pdfUrl`; keep the previous result's URL (client keeps showing what it showed) and
  set `pdfStale: true` in the result; (b) `PdfPane.tsx` — persistent "Preview is from
  the last successful typeset" ribbon when `status==='error'` and a PDF is showing,
  `data-testid="pdf-stale"`; (c) `onPdfInverse` — when stale, toast "This preview is
  from the last successful typeset — fix the errors and typeset again to jump
  accurately", still attempt the jump; when no record → toast "No source location for
  that spot"; (d) restore the dropped `synctex` field in `compile.ts:63-72` (informational).
- e2e: compile ok → break the doc → compile fails → ribbon visible, pdfUrl unchanged,
  double-click shows the stale toast; fix → compile ok → ribbon gone.

## Out of scope (issues): drop `-halt-on-error`; generation token binding pdf↔synctex;
latexmkrc/fontspec engine detection on import; latin-1 fallback; ZIP64/codepages;
blank project; templates + license tracking; ORCID.

## Conventions
CHANGELOG (Fixed/Added under Unreleased) with each item; data-testids; sentence-case
strings; comments = constraints only; e2e for every user-visible change; no new deps.
