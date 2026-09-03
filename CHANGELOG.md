# Changelog

All notable changes to Aldine are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/) (pre-1.0: minor bumps may break things).

## [Unreleased]

### Fixed
- **Deleting a project now really deletes its GitLab project.** One `DELETE` is
  not enough: GitLab only *marks* a project and keeps it in the group for the
  instance's retention period (30 days on GitLab.com, and the default on every
  tier since GitLab 18.0), so the repo outlived the project it belonged to.
  Aldine now follows up with the immediate purge, addressing the project by id
  because marking it renames its path. Where an instance reserves immediate
  deletion for admins, the delete reports the date GitLab will remove it rather
  than claiming success. A delete against an unreachable GitLab no longer counts
  as done — it keeps the link so the purge sweep retries it.
- **Projects mirrored by an earlier build no longer leak their GitLab project.**
  Their stored link predates the flag recording that Aldine created the repo, and
  the absent flag was read as "imported, leave it alone" — so their repos were
  never deleted, and the log blamed an import that never happened. An unflagged
  link inside the configured group is now recognised as Aldine's; imports record
  the flag explicitly, so an absent one only ever means an older build.
- **The result of the remote delete is reported.** It was only ever a server log
  line, which made a repo left behind look identical to a successful delete. The
  home screen now says when the remote was kept, and why.
- **Syncing works on a service-token deployment.** Push, pull, branch switching
  and merge requests demanded a *personal* GitLab connection, while project
  creation, autopush and templates all fall back to `GITLAB_TOKEN` — so a
  deployment whose users never connect GitLab individually could create and
  auto-push projects but got "Connect GitLab to sync" from every button in the
  sync UI. Sync now uses the same ladder as autopush: the caller's own token,
  then the one that created the link, then the service account. Listing and
  importing repos still require a personal connection — the service token there
  would widen which repositories a user can reach, not just how they authenticate.

### Added
- **Project templates can live in a GitLab group.** Set `GITLAB_TEMPLATE_GROUP`
  and every project in that group (and its subgroups) is offered as a starting
  point in the New project dialog, cloned to seed the new project. Templates get
  version control and merge requests, and the dialog re-reads the group each time
  it opens, so a template pushed to the group is available immediately. The tile
  takes its label and description from the GitLab project, or from an optional
  `template.json` committed at the repo root. Independent of
  `GITLAB_DEFAULT_GROUP`: templates can come from GitLab whether or not new
  projects are mirrored there. Copies, never links — the new project keeps no
  connection to the template repo, so editing a template never rewrites projects
  made from it. An unreachable GitLab leaves the dialog usable with whatever
  local templates exist.
- **Templates can fill in the project name, author and date.** A template may
  use `{{PROJECT_NAME}}`, `{{AUTHOR}}`, `{{DATE}}` and `{{YEAR}}` in its text
  files; anything else in braces is left alone, so ordinary LaTeX passes through
  untouched.
- **A GitLab group can be the home for new projects.** Set `GITLAB_TOKEN` and
  `GITLAB_DEFAULT_GROUP` and every new project is created inside that group and
  pushed there, with a "Save in" picker in the New project modal for choosing or
  creating a subgroup without leaving Aldine. GitLab is a **mirror**, not the
  store: the local repository stays authoritative, so a GitLab outage never
  blocks anyone — creation degrades to a local project with a Retry banner, and
  the next attempt sends it to the group it was meant for. Off unless both
  variables are set. ZIP imports (an Overleaf export, say) are uploaded the same
  way, after their binary assets are committed, so the mirror is complete rather
  than short a figure.
- **Trashing a project deletes its GitLab project**, so a nominated group doesn't
  collect repos for projects nobody can see. Only repos Aldine created are ever
  deleted — one imported from GitLab is left alone. Restoring from the trash
  re-creates the project from the local repository, which survives intact, so the
  content comes back; GitLab-side merge requests, issues and CI history do not.
  The delete is best-effort and never blocks trashing, and the 30-day purge
  sweep retries any that failed. Renaming a project still does not rename it in
  GitLab — that would break existing clone URLs.
- **Import from GitLab**, with the same push/pull/branch parity as GitHub, for
  both gitlab.com and self-hosted instances. Connect with a personal access
  token (scope `api`) or, if the deployment sets `GITLAB_CLIENT_ID`/`SECRET`, a
  one-click OAuth connect. A GitLab-linked project opens *merge requests* where
  a GitHub one opens pull requests. The home screen and first-run onboarding
  offer one import tile per configured host, so a deployment with only GitHub
  configured looks exactly as it did.

### Security
- The minimal `docker-compose.yml` carries the compiler sandbox again: an
  `internal: true` network with no route to the internet, `cap_drop: [ALL]`,
  `no-new-privileges`, and memory/PID bounds. The 0.3.0 split had left all of it
  in `docker-compose.full.yml` while SECURITY.md and the README went on
  promising it, so quick-start instances were compiling untrusted LaTeX in a
  container with full egress and every capability. The README quick start is the
  same file, verbatim, including the `name: aldine` line that fixes the volume
  names.

### Changed
- **A new project must be named.** The New project dialog's Create button stays
  disabled until you type one, and `POST /api/projects` rejects a blank name
  instead of defaulting to "Untitled Project" — a name nobody chose, that
  everybody then renamed, and that a template's `{{PROJECT_NAME}}` would have
  baked into the document. Names are trimmed and capped at 200 characters, the
  same rules rename has always used. ZIP and repository imports are unaffected:
  they take their name from the file or repo. Scripted callers that relied on the
  default now need to send a `name`.
- **Breaking (HTTP API).** The remote-sync endpoints moved from
  `/api/github/*` to `/api/remotes/:provider/*`, and from
  `/api/projects/:id/github/*` to `/api/projects/:id/remote/*` (`…/pr` is now
  `…/change-request`). The old paths are gone, so anything scripting against
  them needs updating. The OAuth connect callback now returns to
  `/?remote=<provider>` rather than `/?github=connected`.
- **Action required if you use GitHub sync OAuth.** The callback path moved from
  `/api/github/oauth/callback` to `/api/remotes/github/oauth/callback`, so the
  authorization callback URL registered in your GitHub OAuth app must be
  updated or "Connect with GitHub" will fail. Personal access tokens are
  unaffected.
- **Auto-sync moved from per-browser to per-project.** It was a `localStorage`
  flag driving a timer in the browser, which stopped when the tab closed; the
  push now happens on the server after the debounced autocommit, and the setting
  is shared by the project's collaborators. Anyone who had it enabled in their
  browser will find it off after upgrading — enable it once per project instead.
  It defaults on only for auto-provisioned projects, so existing GitHub-linked
  projects never start pushing unbidden.
- Project metadata gained `remote`, which replaces `github` and records which
  host the project is linked to. Existing projects are read through a
  compatibility shim and upgraded in place on their next write, so no migration
  is needed and a downgrade keeps working until something writes.
- `deploy/papyr-backup.service` / `.timer` are renamed to `aldine-backup.*`, the
  names the runbook has always used, so the install commands work as written. If
  you installed the old units, disable and delete them or both timers will run.
- `docker-compose.full.yml` passes `COMPILE_TIMEOUT_MS` and
  `MAX_CONCURRENT_COMPILES` through from `.env` instead of hardcoding the
  timeout.
- `template.json` is now optional in `TEMPLATES_DIR`: any subdirectory holding a
  `.tex` file is a template, named after its folder, so a directory of papers
  works as-is. A folder that *is* skipped now says why in the log instead of
  vanishing silently. `docker-compose.full.yml` passes `TEMPLATES_DIR` through
  and carries a commented mount for it, so a container deploy can use its own
  templates without rebuilding the image.

### Fixed
- A custom `TEMPLATES_DIR` without a template named `article` made **New
  project** fail outright: the dialog's selection was hardcoded to that id, so
  Create posted a template the server had never heard of. The dialog now selects
  the first template a deployment actually offers.
- Binary files in a template (a logo, a bundled PDF) were read as UTF-8 and
  written back corrupted. Templates now carry bytes through untouched.
- A template shipping its own `.gitignore` had it overwritten by Aldine's. Both
  are kept now: Aldine appends only the build-artefact lines that are missing.

### Added
- Download PDF button in the preview toolbar — saves the compiled PDF named
  after the project.
- Public-demo hardening: `ALDINE_PROTECTED_PROJECTS` serves listed projects
  read-only (HTTP and collab socket) so a showcase paper survives a
  world-writable demo, and `ALDINE_COMPILE_PER_MIN` caps each visitor's
  typesets per minute. The demo stack enables the cap by default.
- Search and AI discoverability for aldine.dev: `robots.txt` (all crawlers
  welcome, AI crawlers included), `sitemap.xml`, a canonical URL, JSON-LD
  software metadata, and a curated `llms.txt` overview for LLMs and agents.
  The page title now says what people search for: "open-source Overleaf
  alternative".
- `AGENTS.md` at the repo root (the cross-tool agent-guidance standard);
  `CLAUDE.md` now imports it instead of carrying its own copy.

### Added
- An About dialog, from the home screen and the command palette, naming the
  licence and linking to the source, stamped with the version and the commit
  the bundle was built from. AGPL section 13 requires a network instance to
  offer its users the corresponding source, and every public deployment had
  been serving a UI that mentioned neither.
- [`CLA.md`](CLA.md) and a signing workflow: contributors keep their copyright
  and grant the right to distribute, including under different licence terms
  later, so the project keeps the option of a commercially licensed edition.
- [`TRADEMARK.md`](TRADEMARK.md): the AGPL covers the code, not the name. Run
  and rebrand freely; don't ship a modified Aldine under the Aldine name.
- The README states plainly that a hosted service is planned, that the
  self-hosted edition stays AGPL, and that no feature that works today moves
  behind a paid tier.

### Fixed
- The demo box's nightly wipe no longer destroys Caddy's certificate store. It
  used `docker compose down -v`, so every wipe re-issued a certificate for the
  same hostname; on the fifth day in a rolling week Let's Encrypt refuses, and
  the demo answers no TLS handshake at all until the window rolls over. The
  wipe now drops the data volumes by name and leaves `aldine_caddy-data` alone.

### Changed
- App instances send `noindex`: an Aldine box holds private documents, and
  the public face for search engines is aldine.dev. This covers the demo and
  every self-hosted install; remove the tag in `apps/web/index.html` if you
  want your instance indexed.

### Security
- Accepting a review suggestion now applies to the live collaborative
  document on the server. The old client-side path read the disk copy,
  string-replaced, and wrote the whole file back — silently destroying every
  collaborator's not-yet-autosaved edits, and failing with a misleading
  "commented text has changed" toast whenever the target text was younger
  than the autosave debounce.
- Renaming a file flushes pending collaborative edits to disk first. The
  rename endpoint evicted the live document before moving the file, so
  keystrokes from the last few seconds were silently lost.

### Fixed
- Renaming the typeset root keeps it the root (the setting follows the new
  name; deleting the root already re-derived it). Renaming a missing file now
  returns 404 instead of 500, and a rename conflict from the command palette
  shows the same toast as the file tree instead of failing silently.
- Capacity rejections ("too many typesets in flight") retry automatically
  with backoff instead of rendering as a failed document, and the preview's
  "fix the errors" message only appears when there are errors to fix.
- Auto-typeset now belongs to the author: it no longer fires on every
  collaborator for every remote edit (each open tab used to recompile the
  same PDF and starve the compile gate), and the on-open typeset respects
  the auto-typeset toggle.
- The errors panel lists errors before warnings (a failing biblatex run
  buried the one actionable error behind 100+ citation warnings and a 50-row
  cap), shows the file next to the line number, and no longer offers a jump
  on warnings that carry no file (they landed at a meaningless line in the
  root file). Truncation is labeled instead of silent.
- The typeset badge reports the time you actually waited, not the compiler's
  internal duration ("Typeset in 0.1s" after a 15-second wait).
- Inverse SyncTeX prefers an exact project-path match before suffix
  matching — with the template's stub `main.tex` present, jumps meant for a
  nested `paper/main.tex` opened the stub instead.
- Accepting a `\cite`/`\ref` autocompletion places the cursor after the
  closing brace, so continued typing no longer lands inside the citation key
  (which compiled without error and shipped silently).
- Visual mode: the bullet-list button emitted `\item` before
  `\begin{itemize}`; the heading dropdown on a commented line produced an
  unterminated argument (both broke the compile — headings now keep trailing
  comments outside the braces); table "+ row" inserted below `\bottomrule`
  and "+ col" broke `@{}`-style column specs (row edits without the spec
  edit); pasted hyperlinks emitted hyperref-only `\href` (now `\url`, which
  compiles under far more preambles); cite chips mislabeled corporate
  authors and compound surnames ("{Growth Market Reports}" showed as
  "Reports 2024") — the bib API now computes the display surname before
  brace-stripping.
- Keyboard shortcut labels match the platform (Ctrl on Windows/Linux instead
  of a hardcoded ⌘) everywhere they are shown.
- Contrast fixes in both themes: light-theme tertiary text, code comments,
  and ok/warn status text now clear WCAG AA (comments in a LaTeX editor are
  content, not decoration); dark-theme filled surfaces (selected palette
  row, menu hover, primary button) use a fill that carries white text at
  4.5:1.

### Fixed
- The word count now covers the whole document (the root file plus everything
  it `\input`s/`\include`s), keeping the open file's share live while typing.
  It used to count only the open file, which for a multi-file project meant
  the root's preamble — a few hundred words for a ten-thousand-word paper.
  A file outside the include graph still shows its own count (the tooltip
  says which one you're looking at).
- Compile errors now link to the right file in projects whose root file lives
  in a subdirectory: error paths were reported relative to the compile dir, so
  clicking an error in the panel opened the root file at the chapter's line
  number (and the AI fix prompt named files inconsistently). Same root cause
  as the SyncTeX fix below.
- Figure previews in the visual editor now resolve `\includegraphics` paths
  against the root file's directory (with a project-root fallback), instead of
  silently showing nothing in nested-root projects.
- Zotero import and cite-from-search now create their `.bib` next to the root
  file — where `\addbibresource`/`\bibliography` actually look — instead of at
  the project root, where a nested-root document never reads it.
- Double-clicking the PDF now jumps to the right file in multi-file projects.
  SyncTeX reports inputs as the compile dir plus the path TeX opened
  (`…/paper/./chapters/ch1.tex`); the un-normalized `/./` defeated the editor's
  suffix match whenever the root file lived in a subdirectory, so the jump
  landed on the chapter's line number in the still-open root file. The compiler
  now returns clean project-relative paths and the editor tolerates the old
  form.
- The production `.env` example in the README no longer produces broken values.
  Lines like `AUTH_ENABLED=1    multi-user login` set the variable to the whole
  string, which fails the strict `=== '1'` check, so auth stayed off on an
  instance the operator believed was locked down.
- The deploy runbook credited the prod overlay with binding the app to
  `127.0.0.1`; it does not (compose merges port lists, so an overlay cannot
  change a published port by omission). `ALDINE_APP_BIND` does it, and the
  Traefik recipe's "skip the host port entirely" was impossible for the same
  reason.
- Documentation that the code did not back: the AI provider precedence was
  printed backwards (it is OpenRouter, then OpenAI, then Anthropic), plugins
  were said to extend "commands" when the API offers sidebar panels and editor
  insertion, `/api/health` returns a `name` field too, "clone a project and keep
  using VS Code" described a git endpoint that does not exist (the route is
  publish-to-GitHub, then Pull), and the status badge claimed the Playwright
  suite gates CI when CI runs typecheck, build, and the integration suites.
- Multi-node guidance now matches `docs/SCALING.md`: Postgres plus Redis is the
  prerequisite for more than one app node, not permission to run one. Cookie
  stickiness is no longer suggested, since it lets two collaborators on the same
  project land on different nodes and dual-seed the document.
- The contributor setup pointed the compiler at `./.data` while the Playwright
  suites run against `.data-e2e`, which fails every compile test against a
  compiler whose `/health` is green. Both READMEs now say which directory.
- Package manifests said `0.1.0` two releases after v0.3.0, and the release
  procedure neither bumped them nor mentioned that the workflow publishes a
  release immediately rather than drafting one. `CHANGELOG` also had no link
  definitions for 0.2.0 and 0.3.0.
- `docs/` carried two competing user-story inventories, one committed truncated
  mid-sentence. One remains, linked from CONTRIBUTING, with each domain naming
  the suite that automates it and the delete story describing the 30-day trash
  the app actually implements.
- The AWS runbook said the images build for amd64 (they are arm64, to match the
  Graviton task), never mentioned the rollback workflow that 0.3.0 added, and
  linked to a heading anchor that does not exist. Its helper scripts fell back
  to a different region than Terraform's default, which surfaces as `docker
  push` failing against a registry that was never created. The demo runbook
  described resizing a server type that is no longer the default.
- The landing page announced "Typeset in 0.4s" a paragraph above "about two
  seconds"; the README says ~2s, so the page does now too.

## [0.3.0] — 2026-08-03

### Added
- **Claim for legacy projects** — on servers that enabled accounts after
  projects already existed, those ownerless projects now show a Claim button
  (first claim wins, resets sharing to private and ends other users' access).
  Previously every signed-in user was treated as their owner.
- **Rollback workflow for the AWS deploy** — deploys register SHA-pinned task
  definitions; `rollback-aws.yml` restores any previous revision. Which commit
  runs in production is now always answerable.
- **Share from the editor** — the toolbar gains a Share button (owner-only,
  multi-user mode) opening the same dialog as the home-screen card. The dialog
  now shows the share URL with a Copy link button when link mode is on.

### Changed
- The repo-root `docker-compose.yml` is now the minimal prebuilt-image setup
  (identical to the README quick start). The previous full configuration —
  build-from-source, every option documented, TLS/Postgres/Redis profiles,
  hardening — moved to `docker-compose.full.yml`. Both share the same project
  name and volumes, so switching between them keeps your data.
- A share link now grants the document, not the project. Opening one lets you
  read and edit; renaming the project, syncing it to the owner's GitHub repo,
  and searching or unlinking their Zotero library are for the owner and
  invited collaborators.

### Fixed
- The PDF preview renders only pages near the viewport instead of rasterizing
  the whole document up front — long papers no longer hold hundreds of MB of
  bitmaps (or gigabytes when zoomed), the first page appears without waiting
  for the last, and zoom clicks debounce into one re-render.
- `\cite`/`\ref` autocomplete no longer re-reads and re-parses every .bib/.tex
  file in the project on each keystroke — the server caches the indexes per
  branch and invalidates on any content change.
- With `REDIS_URL` set (multi-node), revoking access or deleting a project now
  ends live collaboration sessions on every node, not just the one that
  handled the request. Deleting also closes local sessions (it previously
  closed none).
- Link-shared projects no longer appear in every signed-in user's project
  list. "Anyone with the link" now means exactly that: the project opens via
  its URL but is listed only for the owner and invited collaborators.
- The collaborator list is no longer disclosed to everyone who can open a
  project — only the owner sees the email addresses they invited.
- Revoking access now ends live editing sessions. Previously the check ran
  only when a collaboration socket connected, so someone already in the
  document kept editing (and their edits kept being committed) after being
  removed.
- Buttons the server refuses are no longer offered: Delete on projects shared
  with you, and Publish/sync to GitHub when you are not the owner. A failed
  delete or rename now reports the error instead of silently doing nothing.
- Invalid collaborator addresses are rejected in the dialog instead of being
  silently dropped after a "Sharing updated" confirmation; semicolon- and
  newline-separated lists are accepted.
- Typing in a dialog is no longer interrupted when the editor re-renders
  underneath it (an auto-typeset tick or a collaborator's cursor moving would
  pull focus back to the first control).

## [0.2.0] — 2026-07-23

### Added
- **Visual editing mode (experimental)** — LaTeX renders as formatted text
  while the source stays the single source of truth. **Byte-stable by
  construction**: rendering never rewrites source you didn't deliberately edit
  (proven by an e2e test) — unlike Overleaf's visual editor. Includes:
  - Styled headings, bold/italic/underline, real itemize/enumerate lists.
  - **KaTeX math with click-to-edit** in a MathLive WYSIWYG popover; edits
    write back precise source.
  - **Editable tables** — `tabular` renders as a grid you edit in place
    (cell edit, add row/column).
  - **Inline tracked changes** — review suggestions show as strikethrough +
    proposed text with accept/dismiss.
  - **Paste rich text → LaTeX** — HTML from Word/Docs/web converts on paste.
  - Figure chips render the image; cite chips show author-year from the `.bib`;
    a Contents dropdown lists and jumps to headings.
  - Cursor-reveal shows raw source for the construct under any caret — including
    a remote collaborator's, so it stays collab-correct.
  Enable via "experimental Visual editor" in the command palette (⌘K), then the
  Source|Visual toggle. Off by default. Mod-B/Mod-I work in both modes.
- `ALDINE_TEXLIVE_SCHEME=full` build option: compiler image with **all of
  CTAN** preinstalled (scheme-full, ~9 GB on disk) instead of the curated medium set.
  Missing-package compile errors now name the package and point at the option.
- **Publish to GitHub** — locally-created projects can now be pushed to a
  fresh GitHub repo (`POST /api/projects/:id/github/link`; private by
  default), after which the regular sync (auto-push, pull, PRs) takes over.
  Previously only imported repos could sync. The editor shows a Publish
  button for unlinked projects and a one-time hint that unpublished work
  lives on a single server.
- **Trash instead of hard delete** — deleting a project moves it to a trash
  restorable for 30 days (`ALDINE_TRASH_DAYS`); a Trash view on the home
  page offers Restore and Delete forever. A boot + daily sweep purges
  expired entries. `DELETE …?permanent=1` bypasses the trash.
- Sample **nginx config** (`deploy/nginx.conf`) and a bring-your-own-proxy
  deployment path (nginx/Traefik first, bundled Caddy optional); the AWS
  deployment now enables **daily EFS backups** (AWS Backup, 35-day retention).

### Changed
- Relicensed from MIT to AGPL-3.0 (pre-launch, sole-author): self-hosting is
  unaffected; hosted derivatives must share their modifications. Plugins are
  separate works and may use any license.

### Fixed
- Documents no longer duplicate when a collaborator reconnects after a server
  restart/deploy (Yjs docs now reload from a binary snapshot, preserving
  operation identity, instead of reseeding from text).
- Creating or renaming a file onto an existing name no longer destroys it.
- DOI/arXiv citation import escapes `&` and other specials so the imported
  `.bib` always compiles.
- A stale biblatex `.aux` no longer breaks later compiles after the package set
  changes (the compiler cleans aux and rebuilds).
- Review-comment anchors track their text after edits above them, across reload.
- Deleting the typeset root re-points it at another `.tex`.
- Modals are proper dialogs (focus trap, Escape); editor is usable on small
  screens; assorted validation, error-state, and a11y fixes.

## [0.1.0] — 2026-07-19

First public release. Everything below is new.

### Editor & compile
- CodeMirror 6 LaTeX editor with auto-typeset on idle, live word count,
  command palette (⌘K), light/dark themes.
- TeX Live + latexmk compile service with persistent incremental builds
  (~2 s warm recompiles), sandboxed: no network egress, dropped capabilities,
  CPU/memory/PID limits, restricted shell-escape, compile timeouts.
- Error panel with plain-English hints, line numbers, click-to-jump, raw log.
- SyncTeX both ways: double-click the PDF to jump to source, ⌘J to jump the
  PDF to the cursor.
- Drag-drop figure upload, PDF zoom.

### Collaboration & versioning
- Real-time collaboration via Yjs CRDTs (embedded Hocuspocus): multi-cursor,
  live presence, conflict-free merges, unlimited collaborators.
- Every project is a real git repository; branches are git worktrees and are
  editable concurrently. Auto-checkpoints while writing, named checkpoints,
  history view with diffs, one-click revert.
- Review mode: anchored threaded comments on text selections, optional
  suggested replacements the author accepts with one click.

### Integrations
- GitHub sync: import a repo as a project, push/pull with ahead/behind
  indicators, conflict resolution, opt-in auto-sync, branch switching, open a
  PR from the editor. OAuth or personal access token.
- Zotero: link a library or a single collection, version-aware `.bib` refresh,
  citation search panel, `\cite{` autocomplete.
- Cite by DOI / arXiv identifier — BibTeX appended, `\cite` inserted.
- AI error fix (optional, BYO key via OpenRouter or Anthropic): plain-English
  diagnosis of failed typesets with one-click fixes. Key stays server-side.
- Plugin system: manifest + ES-module plugins extend sidebar, editor, and
  commands. Zotero, references, and AI-fix ship as plugins.

### Self-hosting & operations
- Two-container `docker compose up` deploy; flat-file storage by default,
  zero external services required.
- Optional multi-user auth (`AUTH_ENABLED=1`): per-project ownership and
  sharing, Google & GitHub SSO, email/password (scrypt, revocable HTTP-only
  cookie sessions), SSO-only mode, password reset via SES/SMTP.
- Scale-out path: Postgres (`DATABASE_URL`) + Redis (`REDIS_URL`) for
  multi-node; see docs/SCALING.md.
- TLS profile (Caddy auto-certificates), backup/restore scripts + systemd
  timer, Terraform for a full serverless-ish AWS deployment (deploy/aws).
- Templates: article, IAC conference paper, beamer, report/thesis.

[Unreleased]: https://github.com/trahloff/Aldine/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/trahloff/Aldine/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/trahloff/Aldine/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/trahloff/Aldine/releases/tag/v0.1.0
