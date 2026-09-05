# Changelog

All notable changes to Aldine are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/) (pre-1.0: minor bumps may break things).

## [Unreleased]

## [0.6.0] — 2026-09-06

### Added
- Sign in with ORCID. Set `ORCID_CLIENT_ID` and `ORCID_CLIENT_SECRET` from a
  Public API client (`ORCID_SANDBOX=1` for the sandbox) and the sign-in page
  offers it next to Google and GitHub. Most researchers keep their ORCID
  email private, so such an account has no email address: it is keyed by the
  iD, shown in account settings, skipped by password reset and welcome mail,
  and invited to a project by its ORCID iD instead of an address. A public,
  verified ORCID email still matches an existing ORCID account with that
  address. Postgres deployments get the migration on start (`users.email`
  nullable, new `users.subject`). (#10)

## [0.5.0] — 2026-09-05

### Added
- Aldine can live under a URL prefix, for hosts that put several apps behind
  one origin (`https://server/internal/aldine/`). Set `ALDINE_BASE_PATH`, or
  give `ALDINE_PUBLIC_URL` a path: the app, the API, the collaboration
  websocket, plugin assets, OAuth callbacks, reset links and share links all
  follow it, the session cookie is scoped to it, and anything outside the
  prefix is not served — except the two probes an orchestrator aims at the
  container itself: `/api/health` and a bare `GET /`, which answers 200 with
  a pointer to the prefix, so compose healthchecks and load balancers keep
  working. (#27)

### Security
- The hosted staging deployment is isolated from production. It had shared
  the task security group that alone authorises the production filesystem
  (including the secrets directory), received every production SSM secret,
  pushed to the ECR repositories production task definitions resolve, and
  was rolled by the same IAM role a feature branch could assume. Staging now
  has its own security groups, secrets under `/papyr/staging/`, execution
  role, repositories and deploy role; feature branches listed in
  `github_deploy_branches` can reach staging only, and the production deploy
  refuses to build on a task definition the staging role registered.

### Fixed
- Staging no longer inherits `ALDINE_SSO_ONLY` from production, so password
  sign-in works there as documented.
- The demo box pulls `main` and rebuilds during its nightly wipe instead of
  running the commit it was provisioned with.

## [0.4.1] — 2026-09-05

0.4.0 was built but never published: its medium compiler image had been
stitched from the full variant's manifests as well as its own, the release
smoke test refused it, and version tags are never rewritten. 0.4.1 is the
first published 0.4 release and carries everything listed under 0.4.0.

### Fixed
- The release pipeline's per-architecture digest artifacts are named with a
  delimiter the variant cannot contain, so a variant's merge step only sees
  its own manifests.
- The file tree follows what others do. It was a snapshot from page load:
  a file created, renamed or deleted in another tab, by a collaborator or by
  the agent API stayed invisible until reload, and a tab that still had a
  deleted file open wrote it back on its next keystroke. The server now
  signals every open editor on a branch when its files change on disk (the
  same channel the review comments use), a tab coming back to the foreground
  refetches, and an editor whose open file was removed elsewhere moves off it
  and says so; the collab socket for a deleted file is closed and refuses to
  reopen it while the deletion is fresh.
- Uploading a file whose name already exists asks before replacing it; it
  used to swap the content in place, including the file open in the editor,
  with typed work unrecoverable.
- Create in the New project dialog accepts one click: a double-click or a
  held Enter made two identical projects and opened the second.
- Deleting a branch that has checkpoints main does not have says how many
  and names the newest before asking; the question was the same one-liner as
  for an empty branch, and the delete is permanent.
- A typeset that finishes after you switched branch is dropped instead of
  landing its PDF, status and errors on the branch now on screen; and the
  preview resets on a branch change that arrives through Back/Forward, not
  only through the branch menu.

## [0.4.0] — 2026-09-05

### Added
- A theme control in project settings, under Appearance. Dark and light were
  only switchable from the home screen or the command palette, so once you
  were in a project there was no visible way back. It says it applies to this
  browser, like the auto-typeset switch beside it.
- Venue kits fetched from the publisher: 25 more venues in the template
  gallery (NeurIPS, ICLR, ICML, AISTATS, AAAI, IJCAI, ECAI, ACL/EMNLP/NAACL,
  COLING, CVPR, ICCV, ECCV, USENIX and USENIX Security, SIAM, MDPI,
  Copernicus, Springer Nature, IOP, Taylor and Francis, Frontiers, eLife,
  Wiley, Optica, Cell Press) whose class files TeX Live does not carry. The
  tile says "Downloads the official kit from <host>"; picking it downloads the
  publisher's own kit when the project is created, takes only the files the
  registry names, and starts the paper from the kit's own document. Aldine
  redistributes nothing: no publisher file is stored in the repo, and each
  tile links the venue's terms instead of claiming a licence.
  `templates/venues.json` is the only source of kit URLs, so no request can
  influence what is fetched; an entry that is not https, or points off the
  host it declares, is dropped when the registry loads. Caps are 20 seconds,
  25 MB and three same-host redirects, and a successful kit is cached under
  `CACHE_DIR/venue-kits/` for 7 days (and used at any age when the publisher
  is down); the cache is keyed to the registry entry, so changing a venue's
  kit URL or file list refetches instead of serving last year's files. A kit
  that cannot be downloaded never fails project creation: the project is
  created from a skeleton plus a `README-venue.md` naming the kit and what to
  do, and a toast says so. That skeleton typesets as it stands: it stands on
  `article`, keeps the venue's page options where those are article's own (the
  two-column 10pt letterpaper CVPR and USENIX ask for), and leaves the class
  and style lines the kit was going to bring as comments, because the one thing
  a failed kit did not deliver is the venue's class. A venue the
  compiler image already has installed is listed once, as the installed class,
  which needs no download, and the installed and fetched venues are listed in
  one alphabet inside each category.
- Blank projects: a "Blank" tile leads the template grid and creates a project
  with no files; `POST /api/projects` with `template: "blank"` (or `files: {}`)
  does the same. The editor's empty state says "Create a file to start writing"
  with a New file button that suggests `main.tex`. A project without a `.tex`
  file has no typeset root and is not auto-typeset; the first `.tex` created,
  renamed in, or found at typeset time (files can arrive through git) becomes
  the root, and deleting the last `.tex` unsets it again. Typesetting a project
  with no `.tex` answers 400 "No .tex file to typeset" instead of reaching the
  compiler, and the PDF pane says so instead of suggesting the shortcut. A root
  derived from the tree (at typeset time, on the first `.tex`, after the root
  is deleted) is ranked like an import: `main.tex` at the top level over a
  nested one, a file with `\documentclass` over one without.
- `POST /api/projects` validates `files`: a key that would land in `.git` or
  `.aldine*`, escapes the project, is empty, is both a file and a directory, or
  carries non-string content answers 400 and no project is created (previously
  a seeded `.git/config` reached the fresh repo before its initial commit ran
  git). Keys are normalised like ZIP entries (`./a.tex`, backslashes), as are
  roots adopted from a file write or rename. `.git` and `.aldine*` are screened
  without regard to letter case or a trailing dot or space (`.GIT/config`,
  `.git./config`), which reach `.git/config` on macOS and Windows; the same
  screen guards file writes, renames, ZIP imports and the file listing. A seed
  that makes `.gitignore` a directory is refused with 400 rather than failing
  the write of the project's own `.gitignore`.
- The New project dialog only posts a template id the server listed; on a
  server without a templates directory the pick stays empty and Create seeds
  the default article, with the Blank tile still there to choose.
- Project settings dialog (toolbar "Settings", command palette) with a
  Compiler section: main document, compiler (pdfLaTeX, XeLaTeX, LuaLaTeX),
  the connected compiler's TeX Live release and scheme ("2026, full"), "Stop
  on first error" and "Auto-typeset". The preview-header engine picker and
  the log dialog's checkbox stay as shortcuts to the same settings. The
  project name is editable there too. (#7)
- Engine detection on ZIP import: a `latexmkrc` in the archive (`$pdf_mode`
  4 or 5, or a `$pdflatex`/`$xelatex`/`$lualatex` line), a `% !TEX program`
  line, or a root file using fontspec, unicode-math, polyglossia, xepersian,
  bidi or luacode sets the project to XeLaTeX or LuaLaTeX; the import toast
  says which and why, and the settings panel repeats the reason. A
  `$pdflatex` line that only passes flags to pdflatex (the Overleaf
  `-shell-escape` idiom), or an rc that assigns all three engine commands,
  chooses nothing, so the root file still decides.
  Sources that are not UTF-8 are transcoded to UTF-8: Windows-1252 (a
  superset of Latin-1, so Word-era quotes and dashes survive), or Latin-9 /
  Mac Roman when the inputenc option names them; the option is switched to
  `utf8` and the file is named in the toast. A UTF-8 file with a stray byte
  is left as it was, multibyte characters intact. Overleaf exports that need
  XeLaTeX now typeset on first open. (#7)
- The compiler reports its TeX Live release and scheme at `GET /health`
  (`texlive: { release, scheme }`; "unknown" outside the image), and the
  server exposes it, cached, at `GET /api/compiler`. Switching between
  several TeX Live versions (`ALDINE_COMPILERS`) is not part of this change;
  the panel displays the one compiler the server is connected to.
- The e2e suites take `E2E_PORT`, `E2E_MOCK_PORT` and `E2E_AUTH_PORT` so two
  checkouts can run side by side (see AGENTS.md).
- AWS deployment: an optional staging service on the same load balancer
  (`staging_domain_name`), with its own filesystem, log group and certificate,
  so a feature branch can be tried at a real URL before it reaches prod. The
  deploy and rollback workflows take a `target` input (production or staging).

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

- Template gallery: the New project dialog groups templates by category
  (Journals, Conferences, Theses, Slides, General), has a search box, and shows
  each template's licence. Beside the four templates in `templates/`, the
  gallery now offers a template per venue class installed in the compiler image
  (fifteen on the full TeX Live image: Elsevier, IEEE Transactions and
  conference, ACM, REVTeX, Springer LNCS, JMLR, AMS, MNRAS, APA 7, ACS, AIAA,
  ASCE, ASME conference and SPIE): the compiler
  answers `GET /catalog` with the classes it actually
  has, their licence from `tlmgr`, and the class's own sample document when the
  image ships one; where it does not, Aldine generates a skeleton with the
  title block, abstract, a section and the class's usual bibliography style. No
  publisher file is vendored into the repo, and an image without those classes
  (or an older compiler) simply shows the four folder templates.
- Every template folder carries a `LICENSE` file, and `template.json` carries
  `license`, `licenseUrl` and `source` (upstream URL and version). `npm run
  templates:check` fails on a template missing either, and CI runs it.
- AWS deployment: an optional staging service on the same load balancer
  (`staging_domain_name`), with its own filesystem, log group and certificate,
  so a feature branch can be tried at a real URL before it reaches prod. The
  deploy and rollback workflows take a `target` input (production or staging).

### Changed
- Releases no longer move `:latest` on their own. A version tag now runs the
  full CI suite on the tagged commit, builds `aldine-app` and
  `aldine-compiler` as immutable `x.y.z` (and `sha-<commit>`) images, boots
  those exact digests with the user-facing compose file and typesets a
  document with a bibliography inside the sandbox, then waits for a human to
  approve the promote step before `:latest` and the GitHub Release follow.
  The same "Promote to latest" workflow, run by hand with an older version,
  is the rollback: it re-tags what already exists, no rebuild. The compose
  file and the README block pin `${ALDINE_VERSION:-0.3.0}` instead of
  `:latest`, so a running install never changes under you; upgrading is
  `ALDINE_VERSION=x.y.z docker compose pull && docker compose up -d`, and
  rolling back is the same line with the previous version. CI now also runs
  the web unit tests, checks that every place naming the version agrees, and
  discovers the server unit test files instead of listing them (two branches
  each adding a test used to conflict on that line, and the merge dropped one
  side's tests without anything noticing). The server image installs from
  the lockfile (`npm ci`), so the shipped dependency tree is the one CI
  tested; a `.dockerignore` keeps a checkout's `node_modules`, `.git` and
  `.data` out of the build context (a local `--build` used to copy the host's
  `node_modules` over the installed one); and `deploy/backup.sh` and
  `deploy/restore.sh` pin the `alpine` image by digest.
- `POST /api/projects/import` accepts `multipart/form-data` with a `zip` file
  part (and an optional `name` field); the web client uploads the file that
  way, so the browser holds one copy of a 60 MB archive instead of four (file,
  base64, JSON string, request body). The JSON `{ name, zipBase64 }` body
  keeps working for API clients. The 60 MB limit and its message are unchanged.
- Typesetting runs to the end of the document by default instead of stopping
  at the first error: the preview shows the complete PDF and the errors sit in
  the list beside it, like Overleaf. The old behaviour is a per-project setting,
  "Stop on first error" (log dialog and command palette, `stopOnFirstError` in
  `PATCH /api/projects/:id`); with it on, a failing run keeps the previous PDF
  on screen as before.


- The compiler image is published in two variants. `aldine-compiler:<version>`
  is the `medium` scheme, which now includes the publisher classes and the
  Arabic/Persian, Cyrillic, Greek and other-script collections (Persian via
  xepersian or polyglossia verified), about 3.7 GB on disk.
  `aldine-compiler:<version>-full` is all of TeX Live (about 9 GB on disk):
  every script and language, CJK included. Pick it with `ALDINE_TEXLIVE=-full`
  next to `ALDINE_VERSION` in the compose environment; `latest-full` tracks
  `latest`. A missing-package error hint names that switch. Building from
  source (`docker-compose.full.yml`) still takes `ALDINE_TEXLIVE_SCHEME`.
- The compiler image installs `collection-publishers` (elsarticle, IEEEtran,
  acmart, revtex4-2, agujournal, copernicus, and the other journal and
  conference classes) on the medium scheme, and the full scheme's base image
  is pinned by digest like the medium one. Self-hosters must rebuild the
  compiler image (`docker compose build compiler`) to get the classes.
- `deploy/papyr-backup.service` / `.timer` are renamed to `aldine-backup.*`, the
  names the runbook has always used, so the install commands work as written. If
  you installed the old units, disable and delete them or both timers will run.
- `docker-compose.full.yml` passes `COMPILE_TIMEOUT_MS` and
  `MAX_CONCURRENT_COMPILES` through from `.env` instead of hardcoding the
  timeout.

- App instances send `noindex`: an Aldine box holds private documents, and
  the public face for search engines is aldine.dev. This covers the demo and
  every self-hosted install; remove the tag in `apps/web/index.html` if you
  want your instance indexed.

### Fixed
- The hosted deploy (`deploy-aws.yml`) pins the compiler build to full TeX
  Live now that the Dockerfile defaults to medium, assumes its AWS role
  again before rolling the service (the hour-long compiler build outlived
  the first session's token, so the roll failed after the images were
  pushed), and no longer defaults its target to production; the rollback
  workflow reads its revision input from the environment and accepts only
  digits.
- Switching the main document and back no longer shows the other document
  as a clean typeset. The remembered preview URL was keyed on the branch
  only, so a typeset of an unchanged `main.tex` after a spell on `arxiv.tex`
  handed back the URL that still named `arxiv.pdf`. The URL now stands only
  for the PDF the current main document produces. In the same place: with
  "stop on first error" on, a halted run deletes the PDF, and the preview
  kept linking it; a previous PDF is offered only while its file exists.
- Two scans in ZIP import were quadratic on a crafted archive: an upload of
  unterminated `\usepackage{` runs held the server for ten seconds at 256 KB
  and without bound at the 40 MB per-file cap, with no login needed on a
  default install. Both scans are bounded now (190 ms on the same input).
- A ZIP with more than 20 000 entries is refused up front. ZIP64 support
  lifted the old 65 535-entry ceiling, and every entry costs a write and a
  git add whatever its size, so a 60 MB archive of empty entries meant
  hundreds of thousands of them.
- A compiler that is slow to answer its first catalog probe no longer
  empties the venue gallery for the life of the process, and a failed
  refresh on the server keeps the last list it had instead of an empty one
  (which made a tile the gallery had just shown fail with "unknown
  template" on create).
- A project whose main document is `MAIN.TEX` (any capitalisation but
  `.tex`) typesets again. The root picker accepted it, latexmk wrote
  `MAIN.pdf`, and the compiler looked for `MAIN.TEX.pdf`, so every typeset
  came back as a failure with no error to show and a second full rebuild each
  time. The editor's auto-typeset and empty state now recognise it too.
- A `latexmkrc` with `$pdf_mode = 4` now selects LuaLaTeX and `= 5` XeLaTeX,
  which is what latexmk means by them (`-pdflua` sets 4, `-pdfxe` sets 5);
  they were swapped, so an archive that named its engine that way imported
  with the other one and failed its first typeset.
- A bibliography error stays visible on the typesets that follow it. latexmk
  does not re-run bibtex or biber until the `.bib` changes, and only reports
  that the rule "gave an error in previous invocation"; the located error
  from that run (file and line in the `.bib`) was dropped as stale, leaving
  a row with no file to click.
- A failing typeset no longer pays a second full rebuild. The stale-aux
  recovery matched the word "undefined" in any error and the `.aux` mention
  in any log, so nearly every failed compile ran twice; with runs to
  completion, that doubled the wait. It now fires only for an error located
  in the `.aux`/`.bcf` next to one of that file's own macros.
- A cookie on the same host that is not valid percent-encoding (another
  app's `x=100%`, a truncated `%E0%A4%A`) no longer turns every request into
  `{"error":"Internal server error"}` until the user clears site cookies. Such
  a value is now kept as-is and simply fails session lookup; the rest of the
  Cookie header is parsed normally. (#26)

- The preview toolbar fits on one line at ordinary pane widths again. It had
  outgrown the pane, so it wrapped to a second row and left the two pane
  headers at different heights. The pane's own "Preview" title now appears
  only when the pane is wide enough to spare it, and the download button says
  "Download"; the wrap stays as the backstop for narrower panes.
- A dialog taller than the window no longer hides its own buttons. The panel
  caps at 70% of the window height and scrolls; the action row scrolled away
  with the content, so on a laptop-sized window the New project dialog showed
  no Create button and Project settings no Close. The row is pinned to the
  bottom of the panel now, in every dialog.
- The editor no longer scrolls sideways. The preview toolbar (status, engine,
  zoom, Download, Auto) is wider than a narrow preview pane, and it pushed the
  page out instead of fitting: the app toolbar slid off the right edge and the
  Auto switch went with it. The toolbar wraps instead, and shrinking the window
  now pulls an over-wide preview pane back with it rather than leaving it at
  the width it had when the tab was opened.
- Typesetting now really runs to completion: latexmk is forced past a failing
  pass, so bibtex and the reruns that resolve citations and cross-references
  still happen. Dropping `-halt-on-error` alone was not enough — latexmk gave
  up after the pass that errored ("Errors, so I did not complete making
  targets"), and a paper with one bad macro or one malformed `.bib` entry
  rendered with every `\cite` as `[?]` and every `\ref` as `??`. Two real
  papers that used to typeset that way now come out complete (one grew from 41
  pages to 53 once its bibliography returned). "Stop on first error" keeps the
  old behaviour.
- Bibliography errors are reported with the file and line to fix. bibtex and
  biber write them to the `.blg`, never the LaTeX log, so a malformed entry
  used to surface only as hundreds of "Citation undefined" warnings and a
  preview header that said "Failed" with nothing in the problems list. A
  broken `.bib` now lists rows like "refs.bib · line 42 — BibTeX: I was
  expecting a `,' or a `}'" that jump straight to the entry.
- An error inside a generated file (the `.bbl` bibtex just wrote) says which
  file it came from instead of offering a link into the output directory the
  user cannot open, and identical error rows are listed once.
- A failed typeset always says why: a run whose logs parse to no error at all
  falls back to latexmk's own summary rather than an unexplained "Failed".
- `POST /api/projects` rejects a seed whose file name is longer than the 255
  bytes a filesystem accepts, naming the path, instead of failing halfway
  through the write. A creation that fails for any other reason is now a 500
  saying "Could not create the project", with the reason in the server log:
  a full disk or a read-only data directory is this server's fault, not a bad
  request, and its error text names the data directory.
- Templates are read as bytes instead of UTF-8 text, so a template carrying a
  logo, a figure or any other binary file reaches the new project intact.
- A SyncTeX jump from the PDF is refused (409, with a toast) when the preview
  on screen and the SyncTeX file on disk come from different typeset runs,
  instead of landing on the wrong line. Compile results carry a `compileId`
  that the lookup sends back.
- ZIP import reads ZIP64 archives (64-bit sizes and offsets, the ZIP64
  end-of-central-directory record), so exports from tools that write ZIP64
  headers no longer fail as "not a zip file" or import partially. An entry
  compressed with anything but store or deflate (bzip2, LZMA, zstd, ...) or a
  password-protected entry (ZipCrypto or AES) is now refused with a message
  that names the entry and the method, instead of being skipped silently or
  imported as garbage. Entry names without the UTF-8 flag are decoded as UTF-8
  when valid, otherwise from the Info-ZIP unicode path field, cp437 or Latin-1,
  so Windows and 7-Zip archives keep their accented file names.
- Every failed ZIP import writes one info-level log line (`ZIP import failed`)
  with the reason, the archive size and its entry count, never file contents,
  so a hosted instance can be debugged without asking the user for the file.
  The server now logs at `info` by default (per-request access lines stay off);
  `LOG_LEVEL=warn` restores the previous quiet.

- A SyncTeX jump from the PDF is refused (409, with a toast) when the preview
  on screen and the SyncTeX file on disk come from different typeset runs,
  instead of landing on the wrong line. Compile results carry a `compileId`
  that the lookup sends back.

- Importing a ZIP larger than about 24 MB no longer fails with a bare
  "Payload Too Large": the import route now accepts the 60 MB the dialog
  promises (the ZIP travels base64-encoded inside JSON, so the global 32 MB
  body limit cut it off early), and a ZIP over the limit says so with both
  numbers ("ZIP is 65 MB; the limit is 60 MB"). The import dialog's own
  pre-flight toast states both numbers too, and a 413 from a proxy in front of
  the app is reported as "ZIP too large for this server" with the size rather
  than as a generic import failure. Self-hosters running their own nginx:
  raise `client_max_body_size` to 81m as `deploy/nginx.conf` now does
  (`deploy/README.md` said 32m was the load-bearing value; it names 81m now).
- A ZIP whose entry names escape the project (`../x`, absolute paths, drive
  letters) is rejected as a whole before anything is created, and any failure
  after the project exists removes it again, so a bad import no longer leaves
  a half-imported project in the list. Names with dots inside (`data..csv`)
  and Windows-style backslash paths import correctly instead of being dropped
  or written under a literal backslash name.
- Root-file detection on import finds the manuscript instead of the largest
  file: it looks past comment banners longer than 4 KB, prefers a file with
  `\begin{document}` over a class stub, prefers conventional names
  (`main`, `paper`, `manuscript`, `ms`, `article`, `thesis`) and the
  shallowest path, and among equals takes the smaller file rather than a
  bundled template. Without any `\documentclass` it names a `.tex` that is
  actually in the archive instead of a non-existent `main.tex`.
- Setting the typeset engine to anything the compiler cannot run is refused
  with a 400 naming the valid engines (`pdf`, `xelatex`, `lualatex`); it used
  to be stored and then silently typeset with pdflatex. The engine is now
  visible and switchable in the app: a picker in the preview toolbar and
  "Typeset with pdfLaTeX / XeLaTeX / LuaLaTeX" in the command palette, which
  re-typeset straight away when a PDF is on screen (before, the only way to
  change it was the API).
- Forward SyncTeX (editor to PDF) works when the root file lives in a
  subdirectory: the compiler now hands `synctex` the file name relative to
  the compile directory, the way the `.synctex.gz` records it, mirroring the
  inverse direction. In the app the jump is now discoverable and honest: a
  "Jump to PDF" button in the editor header with the shortcut, ⌘J / Ctrl+J
  works from anywhere in the editor page (it used to work only while the code
  editor had focus), and a jump that cannot land says why ("No PDF location
  for this line — typeset first" / "Jump unavailable for this file") instead
  of doing nothing.
- A failed typeset no longer presents the previous PDF as a fresh result. The
  compile result keeps the last successful `pdfUrl` unchanged (the preview
  keeps showing what it showed) and reports `pdfStale: true`, so inverse
  SyncTeX jumps and the preview can say the PDF is from the last successful
  typeset instead of quietly landing lines off. The preview pane shows a
  "Preview is from the last successful typeset" ribbon while the last run
  failed, a double-click on that stale preview says the jump may be off
  before attempting it, and a double-click with no source location says so
  instead of doing nothing. The result also carries the `synctex` path
  again. Deleting a branch (or the project) forgets its remembered PDF, so a
  branch recreated under the same name cannot be handed a URL to a file that
  went with the old worktree; and switching branches empties the preview, so
  a failed first typeset on the new branch no longer labels the previous
  branch's pages as its "last successful typeset". ⌘J / Ctrl+J is left alone
  while typing in a comment, dialog, or palette field.
- The demo box's nightly wipe no longer destroys Caddy's certificate store. It
  used `docker compose down -v`, so every wipe re-issued a certificate for the
  same hostname; on the fifth day in a rolling week Let's Encrypt refuses, and
  the demo answers no TLS handshake at all until the window rolls over. The
  wipe now drops the data volumes by name and leaves `aldine_caddy-data` alone.

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

### Security
- The main document's name could carry latexmk options. A root file such as
  `-pdflatex=<command>` landed bare on the compiler's command line, and
  latexmk ran the command; with auth off, or as any project member with it
  on, that was command execution inside the compiler container, which mounts
  every project. The compiler and the settings route now refuse a path
  segment starting with `-`, and the compiler passes the root file as
  `./<name>` so it can never be read as an option. Reported by the September
  regression review; present since the compiler was written.
- A SyncTeX lookup could name another project's directory in its body and
  read that project's SyncTeX records (file names and line numbers). Only the
  lookup fields cross to the compiler now.
- The minimal `docker-compose.yml` carries the compiler sandbox again: an
  `internal: true` network with no route to the internet, `cap_drop: [ALL]`,
  `no-new-privileges`, and memory/PID bounds. The 0.3.0 split had left all of it
  in `docker-compose.full.yml` while SECURITY.md and the README went on
  promising it, so quick-start instances were compiling untrusted LaTeX in a
  container with full egress and every capability. The README quick start is the
  same file, verbatim, including the `name: aldine` line that fixes the volume
  names.

- The minimal `docker-compose.yml` carries the compiler sandbox again: an
  `internal: true` network with no route to the internet, `cap_drop: [ALL]`,
  `no-new-privileges`, and memory/PID bounds. The 0.3.0 split had left all of it
  in `docker-compose.full.yml` while SECURITY.md and the README went on
  promising it, so quick-start instances were compiling untrusted LaTeX in a
  container with full egress and every capability. The README quick start is the
  same file, verbatim, including the `name: aldine` line that fixes the volume
  names.

- Accepting a review suggestion now applies to the live collaborative
  document on the server. The old client-side path read the disk copy,
  string-replaced, and wrote the whole file back — silently destroying every
  collaborator's not-yet-autosaved edits, and failing with a misleading
  "commented text has changed" toast whenever the target text was younger
  than the autosave debounce.
- Renaming a file flushes pending collaborative edits to disk first. The
  rename endpoint evicted the live document before moving the file, so
  keystrokes from the last few seconds were silently lost.

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

[Unreleased]: https://github.com/trahloff/Aldine/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/trahloff/Aldine/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/trahloff/Aldine/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/trahloff/Aldine/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/trahloff/Aldine/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/trahloff/Aldine/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/trahloff/Aldine/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/trahloff/Aldine/releases/tag/v0.1.0
