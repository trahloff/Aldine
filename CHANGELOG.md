# Changelog

All notable changes to Aldine are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/) (pre-1.0: minor bumps may break things).
What 1.0 changes about that is in [docs/STABILITY.md](docs/STABILITY.md).

## [Unreleased]

### Added
- Vim keybindings for the editor, in Source and Visual: turn them on under
  Settings → This browser, or with "Turn Vim keybindings on" in the command
  palette. u and Ctrl-R undo and redo your own edits, never a collaborator's.
  The keybindings download only when first turned on (#188).
- The sidebar beside the editor is as wide as you drag it, from 180 to 520
  pixels, so long file names and the tab labels fit. The arrow keys move the
  divider too, a double-click restores the default width, and this browser
  remembers the width you chose (#193).
- Account management on `/admin` (#192): Manage on each row disables or
  enables an account, confirms its address by hand (for servers without
  email), sends a password reset email or, without email, shows the
  administrator a one-time reset link, and deletes it. A disabled account is
  signed out at once and refused everywhere: password, ORCID and single
  sign-on, access tokens, the Claude connector, MCP and collab sockets.
  Enabling it lets its tokens work again unless the administrator revoked
  them. Deleting asks for the address to be typed and for its projects to go
  to another account or to the trash, and takes it off every share list
  that names it. Administrators cannot disable or delete themselves or
  another account on `ALDINE_ADMIN_EMAILS`. Every action is logged. The
  accounts table shows whether each address is confirmed and each account
  is disabled.

### Fixed
- A crash or a volume that goes read-only no longer leaves the JSON datastore
  with an empty `users.json` and every request failing. Writes of datastore
  files, collaboration snapshots and the signing secret now wait until the
  disk has them, and each datastore file keeps its previous version as a
  `.bak`, which a damaged file is restored from, with a log line naming both.
  With no usable `.bak` the server refuses to start and names the file to
  restore from a backup, and `/api/health` answers 503 instead of ok. A
  damaged collaboration snapshot is ignored and the document loads from its
  file (#199).

### Changed
- Adding an email address or ORCID iD in the share dialog now sends an
  invitation the person accepts, instead of giving access at once. The link
  works only for an account whose confirmed address, or ORCID iD, is the one
  invited, so a forwarded link opens nothing for anyone else. Invitations
  also wait on the invitee's Home page, which is how they arrive on a server
  that sends no email: the dialog says so and offers Copy invite link. The
  owner sees each invitation as pending, declined or expired (after 14 days)
  and can resend, withdraw or invite again. People already on a share list
  keep their access as before.

## [1.2.0] — 2026-10-28

### Added
- Sharing a project by email sends the new collaborator an invitation with a
  link to the project, once per added address. The share dialog says who was
  mailed, and who to tell yourself when the server sends no email or the
  hourly limit (`RL_INVITE_BURST`, default 20) is reached.

## [1.1.1] — 2026-10-27

### Fixed
- The blank New project tile that ends a short shelf has its own test id,
  `new-project-tile`, instead of sharing `new-project-sheet` with the chooser
  it opens (#178).

## [1.1.0] — 2026-10-27

### Added
- Elsevier's CAS classes in the template gallery: "Elsevier journal (CAS, one
  column)" starts from cas-sc and "Elsevier journal (CAS, two columns)" from
  cas-dc, with the title block, keywords and author-year references their
  own template uses (#137).

### Fixed
- Deleting a branch while it typesets waits for the typeset, removes the
  whole worktree and frees the name for a new branch, instead of failing or
  leaving the old output behind. Typesets asked for during the delete are
  refused (#161).
- The ICML, IJCAI, IOP, Frontiers, Optica and Taylor & Francis templates
  create projects that typeset on the first try, and show page 1 in the
  chooser (#172).
- The Wiley template finds its class and logos. Its bundled reference style
  still fails BibTeX on the sample, which is a bug in Wiley's kit.
- USENIX Security, SIAM and Cell Press only hand their kits to a browser. Their
  tiles now link the kit and open the ZIP import instead of creating a project
  without the venue's class.
- Visual mode: "+ col" adds the new column inside a table's outer `|` or
  `@{…}`, so the table keeps its frame and padding (#152).
- Visual mode: a paste always typesets. A pasted link writes `\url` only
  when the preamble (the file's own, or the root file's) loads `url`, `xurl`,
  `hyperref` or `biblatex`, and keeps the address as text otherwise. Plain
  text is escaped like rich text, so `50% & $5` stays text; LaTeX (any
  control word or `$…$` formula) pastes as it is, and so does anything
  pasted into a formula, a listing, a path or a `\ref`/`\cite`/`\label`
  key. The root file's preamble is read again when a file opens and every
  30 seconds, so a package removed there stops `\url` in chapters too
  (#149).
- Visual mode shows `\%`, `\&`, `\$`, `\#`, `\_`, `\{`, `\}`,
  `\textasciitilde{}` and `\ldots` as the characters they typeset, and
  `\url{…}` as a link; inside `\path` and `\nolinkurl` escapes stay as
  written, as LaTeX prints them. `\centering` and a `\label` on a heading's line
  stay hidden until the caret is on them, and End in such a heading stops
  before its brace (#150).
- Visual mode keys around lists and headings: Enter at the end of a list
  item starts the next `\item`, and Enter on an empty last item leaves the
  list. Enter in a formula, listing or other environment inside an item
  just breaks the line, an empty item between others stays, and a list
  holding a comment or a setting besides its only item is not removed.
  Backspace and Delete next to a list's hidden `\begin`/`\end` move the
  caret past it instead of deleting it, on a long paper too. Enter in body
  text keeps the line's own indentation, and Heading on an empty line
  writes an empty heading with the caret in it (#151).

### Changed
- Visual mode reads the preamble's `\newcommand`, `\renewcommand`,
  `\providecommand` and `\DeclareMathOperator` definitions (without an
  optional argument). Formulas that use them render with them and open in
  the formula editor, which keeps `\R` as typed. Editing one definition
  redraws only the formulas that use it (#153).
- Visual mode on a long paper builds its rendering around the caret and
  the part in view first and the rest while the browser is idle, so the
  first switch and KaTeX or the bibliography arriving no longer walk the
  whole document at once (#154).

## [1.0.1] — 2026-10-25

### Added
- Page 1 of 30 of the 40 journal and conference templates in the New
  project chooser. The other ten keep their placeholder until their kits
  typeset (#172).

## [1.0.0] — 2026-10-25

Aldine 1.0. Apart from a new logo and previews of the journal and conference
templates, it works the same as 0.18.0; what is new is a promise about
upgrades. Any 1.x release starts on data written by an earlier 1.x, or by
0.14 or later, with no manual step, on the JSON store and on Postgres.
Stable settings, MCP tools and the plugin API keep their names and shapes
until 2.0, and anything deprecated keeps working for at least one more minor
release, with a warning. [docs/STABILITY.md](docs/STABILITY.md) lists what
is covered and what is not (the web interface's layout and wording, for
one).

None of this is on trust. Before `latest` moves, every release is started on
volumes filled by the previous release and by 0.14.4, with both datastores.
The projects, comments, shares and tokens have to be there afterwards and
the projects have to typeset. It also has to restore from a backup.

Coming from 0.14 or earlier? Read the 0.15.0 notes first: they fix security
problems.

### Added
- The New project chooser can show page 1 of the journal and conference
  templates, not only of the four general ones. The images are typeset in CI
  with the full TeX Live image and were not ready for this release, so these
  tiles still show their title-page placeholder; they arrive in the next one.

### Changed
- A new logo: "aldine." set in Geist SemiBold, and an app icon with a
  lowercase a and a blue full stop.

## [0.18.0] — 2026-10-25

### Added
- New project opens a template chooser: a large sheet (a bottom sheet on a
  phone) with categories down the side, a search, page 1 of each template and
  the project name in the footer, filled in and selected so Enter creates the
  project. Arrow keys move through the templates and the categories, typing
  on a template searches, and Escape closes. On a phone the sheet opens
  without raising the keyboard. Page 1 of each shipped template is rendered
  before release (`npm run templates:previews`, checked by the unit tests)
  and ships in the app image; a template from a template repository is
  typeset by the compiler after a sync that changed it, once per version, and
  retried later when that fails. Both are served with a long cache. Venues
  whose kit is downloaded at create time, and templates not rendered yet,
  show a title page with their name instead. The gallery no longer uses emoji
  icons; the `icon` field of `template.json` is ignored.
  `ALDINE_TEMPLATE_PREVIEWS=0` stops the typesetting of repository templates.

### Changed
- The project list is a new Home: a shelf of first pages, each with when it
  was last edited and by whom, a dot when someone else changed it since you
  opened it, its branch, its sharing and its typeset errors. Projects open on
  the branch you last had open.
- One bar holds search (it narrows the list as you type), New project with
  the imports under its arrow, and your account menu with Appearance, Connect
  Claude and Sign out; Appearance moves there from the toolbar. Sort by last
  edited, last opened, name or date created; Shared with me and Trash have
  their own address, and the trash says when each project goes for good.
- Each project has a menu (the "…" button, right-click, long press,
  Shift+F10) with Rename, Duplicate, Share, downloads and Move to Trash, and
  the list answers the arrow keys, Delete, Cmd/Ctrl+Z to undo and "n" for a
  new project. Several ZIPs import at once, with progress and Cancel.
- The welcome dialog is gone: an empty list offers templates and imports
  instead. On a phone Home has a compact bar, two columns, and project menus
  open as a sheet from the bottom.
- Page-1 thumbnails are rendered 512px wide, enough to stay sharp on a
  high-density desktop and on a phone, without sending more than a sheet shows.
- The shelf fits six projects across at 1440px and five at 1024px, in the
  same sheet size as the empty list's starting points. Names in a row start on
  one edge (the unread dot hangs to their left), and on a phone the "…" sits
  at the end of the name instead of on the page, and the line under it uses
  short units ("Grace · 3 hr ago").
- A project shared with you always names its owner on a chip, with the link
  it came through. The trash says how long it keeps projects, and a page in it
  is dimmed rather than greyed out. The colophon follows the list, and the
  filter's counts appear together, so nothing moves sideways while loading.
- Each "Moved to the trash" notice keeps its own undo: Cmd/Ctrl+Z undoes the
  newest one still on screen. Empty trash can't be started twice. Several ZIPs
  dropped on the trash or Shared with me import into the list of all
  projects, where their progress shows. Download PDF fetches the branch that
  typeset. The starting points are one Tab stop with arrow keys, and the
  current filter stays marked in forced colors.
- Light theme: secondary text is darker than tertiary again, and sheets have
  a stronger edge. `PUT /api/projects/:id/listing` shares the rate limit of
  `POST /api/projects/:id/opened`.
- Undo after "Remove from my list" puts the project back as it was: a change
  you had not opened yet stays marked.

## [0.17.0] — 2026-10-25

### Added
- The project list puts the most recently edited project first and says when
  each one was last edited and by whom (the agent's name for edits made
  through the Agent API), which branch you last had open, and whether that
  branch's last typeset worked or how many errors it had, also after the
  server restarts. A project last changed before this release shows the time
  of its last commit.
- A project you open through a share link appears in your project list, under
  Shared with me, until you remove it with "Remove from my list". Invited
  collaborators can remove a project from their list too; it comes back the
  next time they open it. The share dialog says so.
- Duplicate a project: the copy is yours and holds the files of its main
  branch as they are now, without its history, sharing, remote repository or
  Zotero link. Projects over 256 MB are not duplicated; download them as a
  ZIP instead.
- The trash says when each project in it will be deleted for good.
- Page-1 thumbnails for the project list. After every successful typeset,
  from the editor or through the API, the compiler renders the first page
  into a small image beside the PDF. A typeset that logged errors but still
  wrote a fresh PDF gets an image too, matching what the editor shows; one
  that halted, timed out or wrote no PDF keeps the previous image. The project list and the trash name each project's image (its
  branch, size and version), and `GET /api/projects/:id/thumbnail` serves it
  to whoever may open the PDF, cacheable for good once the version is in the
  link. The compiler image already ships Ghostscript for this; a compiler run
  outside the image uses Ghostscript or poppler's pdftoppm when installed and
  typesets as before without either. Rendering never delays the typeset, and
  `ALDINE_THUMBNAILS=0` on the compiler turns it off.
- Appearance offers Match system next to Light and Dark, in the toolbar's
  appearance menu and in the command palette. Match system follows your
  operating system as it changes. Dark stays the default.
- Menus answer the keyboard: arrow keys, Home and End, typing a letter to
  jump to an item, Escape to close. The file tree's menu also opens with
  Shift+F10 or the Menu key, and with a long press on a touch screen.
- Each tab says where it is: "Projects – Aldine", the project's name in the
  editor, "Sign in – Aldine" on the sign-in page.

### Changed
- The project list loads without the editor's code (CodeMirror, pdf.js,
  KaTeX, Yjs), so it appears sooner; the editor loads in the background.
- One name per action: "New project…", "Import a ZIP…" and "Clone from
  GitHub…" (or GitLab, Gitea / Forgejo) on Home, in the welcome dialog and in
  the command palette. A project created without a name is called "Untitled
  project".
- The command palette lists your newest projects before commands, under
  one heading per group, and typing searches all of them; "op" no longer
  matches every project. It opens without
  animation from the keyboard and gives focus back to where it was opened.
- On a phone, dialogs rise from the bottom edge as a sheet, and the page
  behind them does not scroll.
- Sign-in is a form your password manager recognises, with visible labels,
  and says "Signing in…" while it works.
- The New project dialog labels the name field, Enter in the template search
  creates the project, and a long template name no longer runs out of its
  tile.
- Moving a project to the trash shows a neutral notification instead of a
  success.
- Light theme: tertiary text is a little darker, for contrast.

### Fixed
- A browser that blocks site storage (some private windows) no longer stops
  the app from starting, and an unexpected error shows a Reload button
  instead of a blank page.
- Touch screens no longer leave buttons looking hovered after a tap, focus
  rings on filled buttons are visible against the fill, and Windows contrast
  themes show the chosen palette row, menu item and template.

### Security
- Password sign-ups confirm their address. Until then, projects shared with
  that address by email stay hidden from the account and
  `ALDINE_ADMIN_EMAILS` does not count it, so someone who signs up first
  with an invited address no longer gets the invitation. Sign-up sends a
  one-time link (valid 7 days); without an email transport the link is in
  the server log for the operator to pass on, like a reset link. A banner on
  the project list asks for the confirmation and sends a new link (without
  an email transport, a link the operator already passed on keeps working
  after that), and a completed password reset also confirms the address
  (not with `ALDINE_RESET_ECHO=1`). Shares apply as soon as the address is confirmed.
  Existing accounts and single sign-on accounts count as confirmed; `/admin`
  marks pending ones "not confirmed".
- Password sign-in is also limited per account, across every client
  address: after 5 failed tries in a row each further try waits 1, 2, 4 …
  seconds, at most 60, and the sign-in form counts down. Unknown addresses
  are counted the same way. A browser that signed in to the account before
  keeps a signed cookie that exempts it from this wait, so someone who knows
  your address cannot lock you out. The cookie is tied to the account's
  current password: changing or resetting it ends the exemption of every
  other browser, and signing up issues none. With `REDIS_URL` the count
  holds across app nodes.
- Starting a branch on the git host from `main` is for the project owner
  only, like switching the tracked branch, because the new branch becomes
  the one the project tracks for everyone. Collaborators see why the action
  is unavailable.

### Fixed
- Deleting a project forever while it was still typesetting (right after
  opening it, for example) could fail with a server error and leave the
  project half removed in the trash. The delete now waits for the typeset.

## [0.16.0] — 2026-10-25

### Added
- Search and replace across the project: a Search tab in the sidebar
  (⇧⌘F / Ctrl+Shift+F, changeable in settings) finds text in every file on
  the branch, open or not, with match case, whole word and regular
  expressions. Results are grouped by file with their line; a click opens
  the file with the match selected. Replace one match or all of them: a
  file a collaborator has open changes in front of them, and Replace all
  lands as one commit under your name. Build output, hidden files, symbolic
  links and files over 1 MB are not searched.
- The keyboard shortcuts in settings say when two of them are on the same
  keys, such as one you set to ⇧⌘F before search took it.
- Visual editor: "Edit the formula or table at the cursor" in the command
  palette opens the formula editor or moves into the table's grid, the same
  as Ctrl+Enter or ⌘Enter in the formula's or table's source. Hovering a
  formula says so, or says why it opens as source.

### Changed
- The visual editor is no longer experimental: the Source/Visual switch is
  in the toolbar for everyone, and the command palette offers "Switch to
  Visual editing" and "Switch to Source editing" in place of "Enable
  experimental Visual editor". A document opens as source until you pick
  Visual, and your browser remembers your last choice; one that had the
  experimental flag on keeps the choice it had. Visual applies to `.tex`
  files only: a `.bib`, `.sty` or `.cls` opens as source, without the switch
  or the formatting toolbar, and your choice applies again at the next `.tex`
  file.
- Visual editor: the "TeX" buttons of the formula editor and of tables are
  called "Edit source".
- Upgrading the default compiler image downloads only the layers that
  changed, about 100 MB, instead of TeX Live again (about 1.4 GB). The
  release that brings this still downloads TeX Live one last time; the
  smaller upgrades start with the release after it. A release that moves the
  compiler to a newer TeX Live downloads it again, and says so here.

### Fixed
- Typing `\begin{itemize}` left a stray `}` after the `\end{itemize}` the
  editor inserts, an "Extra }" error at the next typeset.
- Visual editor: after any edit above them, yours or a collaborator's, table
  cell edits, "+ row" and the formula editor's Done wrote to where the table
  or formula had been when it was first drawn, overwriting unrelated text,
  and a click on a citation chip put the caret there. They now act where the
  table, formula or chip is when you use them. An open cell or formula
  editor follows edits above it, and an open cell keeps what you typed, and
  stays the same cell, when someone else edits another cell of the same
  table or adds or removes a row above it. When someone else changes the
  cell you are typing in, the grid says so, and only the next Enter replaces
  their text with yours; a change that cannot be written says so, with your
  text, instead of disappearing.
- Visual editor: the formula editor's Done wrote the whole formula back the
  way MathLive spells it, dropping comments and line breaks, escaping or
  merging `&` and `\\`, and moving `\label`. Done now writes only what you
  changed; the spacing and the rest of the formula stay as written. A
  formula MathLive cannot write back as it is (one with a comment, a line
  break inside, `&` or `\\`, a `\label`, `\tag` or `\ref`, an environment,
  or a macro it would spell differently) opens as source instead; an
  equation whose formula sits on lines of its own between `\begin{equation}`
  and `\end{equation}` opens in MathLive.
- Visual editor: the first formula you clicked on a visit opened its editor
  only once MathLive (about 800 KB) had loaded, and what you typed until then
  went into the text where the caret had been. It now goes into the formula
  editor; Escape, a click elsewhere or the command palette while it loads
  leaves the formula editor closed. MathLive also loads in the background
  once Visual is on, so the formula editor usually opens at once.
- Visual editor: `$$…$$` display math showed as a red error instead of the
  formula.
- Visual editor tables: Escape in a cell saved it, and Enter saved it twice
  and left the keyboard focus nowhere. Escape now cancels, Enter saves once
  and returns to the text, Tab moves to the next cell. %-comment lines and
  the `[2pt]` of `\\[2pt]` no longer show up as cells, and "+ col", which
  did nothing, adds the column to the column spec and to every row.
- Visual editor tables: a cell written over two source lines lost its line
  break, and the words on either side ran together, as soon as it was
  clicked and left, or passed with Tab, with nothing typed. Such a cell now
  opens in the source. "+ row" added its cells to the last row when that row
  had no `\\` (the next typeset failed with "Extra alignment tab"), and for a
  table on one line, as in `Name: \begin{tabular}{@{}l@{}}a\\b\end{tabular}`,
  wrote outside the table, before the start of the line. The new row now
  goes right after the last one, inside the table and above a closing rule.
- Visual editor: End on the last item of a list or on a heading put what you
  typed after `\end{itemize}` or after the heading's closing brace. After a
  heading level chosen in the toolbar, Enter wrote the next paragraph into
  the heading, and after a heading with a `\label` on its line it indented
  the new paragraph. Enter at the end of a heading now starts the next
  paragraph below it (after the `\label`), without an indent. Text after a
  run-in heading such as `\paragraph{…}` no longer looks like part of the
  heading.
- Visual editor: citation chips left out the page and the prenote;
  `\cite[see][p.~12]{key}` now reads "see Knuth 1984, p. 12".
- Visual editor: suggested changes from review were missing after a switch
  from Source to Visual, including in a file that had opened in Source.
- Visual editor: pasting from Google Docs made one `\textbf{…}` across
  paragraphs, which stopped the typeset, and lost italics. Bold and italic
  runs now come across as written. A link to a place on the same page
  (`#section`) keeps its text.
- Visual editor on long files: formulas, headings and figures past the first
  100 KB or so stayed as source until the next edit, and each keystroke cost
  more the longer the file and the more people typed in it. An edit now
  redraws only what it touched.
- Visual editor figures: `\includegraphics{plot}` without an extension
  showed no preview and cost a failed request, PDF graphics showed no
  preview either, and a figure with subfigures showed the first subfigure's
  caption. Both now show their preview, and the chip shows the figure's own
  caption.
- Visual editor with the keyboard: the formula editor, the table buttons and
  the suggestion buttons needed a mouse, and Enter on a focused "accept
  suggestion" button typed a line break. The formula editor is now a dialog
  (Escape closes it and returns to the text, Tab stays inside, Ctrl+Enter or
  ⌘Enter in a formula's source opens it). The table buttons work with Enter
  and Space, a cell opens with Enter, Ctrl+Enter or ⌘Enter in a table's
  source moves into its grid, and Enter on a suggestion button accepts or
  dismisses it. A table whose column spec cannot be found keeps "+ col" in
  the Tab order and says next to it why it does nothing. Switching between
  Source and Visual left the keyboard focus on the switch, or nowhere when
  switched from the command palette; it now goes back to the text, with the
  caret where it was.
- Visual editor with a screen reader: formulas are read out as math, chips
  say what they are and the suggestion buttons have names. The editor, in
  both modes, says which file it holds. The Source/Visual switch is a pair of
  toggle buttons rather than tabs whose arrow keys did nothing, the formula
  editor is a modal dialog, and a figure's preview no longer repeats its
  caption.
- Visual editor on phones: the on-screen math keyboard covered the formula
  editor and ignored the dark theme, table cells broke inside words, and the
  editor's buttons were too small to tap. The formula editor now stays above
  the keyboard, which follows the theme; cells wrap between words; the
  buttons are large enough to tap.

## [0.15.1] — 2026-10-25

### Fixed
- Files with Windows (CRLF) line endings: every edit landed one character to
  the left for each line above it, and the stored file and other people's
  editors no longer matched what you saw. Open documents now use LF line
  endings; a file that uses CRLF throughout keeps it when it is saved.

## [0.15.0] — 2026-10-24

This release fixes security problems found in a review before 1.0 (see
Security below). Upgrade every instance, and run `find "$DATA_DIR" -type l`
to list symbolic links left by projects imported earlier.

### Added
- Install routes for NAS systems, each with the compiler sandbox intact (no
  internet, no Linux capabilities, bounded memory and processes). CasaOS and
  ZimaOS import `deploy/casaos/docker-compose.yml` under App Store → Custom
  Install; it keeps the data in `/DATA/AppData/aldine` and keeps CasaOS's
  global variables, such as API keys, away from the compiler. TrueNAS 24.10
  and later paste the YAML in `docs/TRUENAS.md` into Install via YAML.
  Unraid runs the standard compose file through the Compose Manager Plus
  plugin (`docs/UNRAID.md`).
- `docs/STABILITY.md`: what 1.0 will promise. Which on-disk data, settings,
  MCP tools and plugin API members a 1.x release keeps working, how each kind
  of data migrates today, what counts as breaking, how long a deprecation
  lasts, what is not covered (the REST API among it), and which check backs
  each promise.

### Changed
- Releases go out once a week, on Sunday evening Berlin time, instead of
  after nearly every merge. Security fixes and fixes for bugs that lose or
  corrupt data still ship at once. The rule is in CONTRIBUTING.md,
  "Releasing".
- `deploy/restore.sh` refuses to run while the app is up, since the app
  would keep writing into the volumes being replaced. `--yes` skips its
  confirmation, for scripted restores.

### Fixed
- The upgrade command in the README and on aldine.dev set `ALDINE_VERSION`
  for `docker compose pull` only, so the `up -d` after it started the old
  version again. Both now put the version in `.env`.
- `docker-compose.full.yml` did not pass `ALDINE_AI_AUTOFIX` to the app, so
  setting it in `.env` did nothing.
- The README and aldine.dev said the gallery had 4 templates. It has
  4 starter templates, one per publisher class in the compiler's TeX Live (15
  in the published images) and 25 conference and journal kits. The
  compiler image is about 2.4 GB to download and about 5 GB on disk, not
  1.1 GB and 4.3 GB.
- `deploy/README.md` now lists every variable the server and compiler read,
  with the test and tuning ones in a table of their own, and says that an
  instance switched to Postgres starts without its JSON data.
- On the Postgres datastore `deploy/backup.sh` left the database out, so a
  restore brought back every project's files and history but no accounts,
  sessions, project settings, shares or comments. With `DATABASE_URL`
  pointing at the bundled `db` service the tarball now holds a dump of the
  database, and `deploy/restore.sh` loads it into a database started on its
  own (deploy/README.md, "Restore"). For a database outside the stack the
  backup stops with an explanation instead of leaving it out quietly;
  `ALDINE_BACKUP_DB=skip` writes it without the database.
- `docker compose up` after a restore warned that the volumes were not
  created by Docker Compose. `deploy/restore.sh` labels the volumes it
  creates the way compose does.

### Security
- Symbolic links in a project are no longer followed. Importing, pulling,
  resetting to the remote and opening a branch check a link out as a plain
  file holding its target (the repository keeps the link), and the editor,
  the file API, the PDF route and the agent tools refuse a path through a
  link already on disk. A repository with a link let the server read and
  write files outside the project, its own secrets included. Projects
  imported before this release may still hold links on disk:
  `find "$DATA_DIR" -type l` lists them. Template repositories
  (`TEMPLATE_REPOS`) check links out as plain files too, and a template
  whose `template.json` is a link out of the checkout is not listed.
- Typesetting refuses a project that holds a symbolic link pointing outside
  the project, into its `.git` folder or at nothing, and names the link; a
  link to another file of the project still typesets. The compiler followed
  such a link from an earlier import, so a document could `\input` another
  account's project or write into it. Delete the link in the project's
  repository and pull.
- The compiler no longer reads a project's `latexmkrc` or `.latexmkrc`, or
  any system or user latexmk rc file. latexmk runs an rc file as Perl,
  outside TeX's restricted shell escape and file limits, so a project could
  read and overwrite every other project on the data volume. The engine an
  import picks from a `latexmkrc` still applies; other rc settings, such as
  a custom rule that runs `makeglossaries`, no longer do. The precompiled
  preamble now covers projects with a `latexmkrc` as well.
- Looking up a reference by DOI follows a redirect only to the DOI
  resolver itself or, over https, to a registration agency's metadata
  service (Crossref, DataCite, mEDRA, JaLC). A DOI registered to point
  anywhere else used to make the server fetch that address, an internal
  one included, and a reply starting with `@` was added to the project's
  `.bib`. Such a DOI now finds nothing, as its landing page did before.
- Access tokens and Connect sessions reach only the project routes they are
  documented for: reading, editing files, typesetting, commits, reverts, a
  new branch, references and comments. Sharing, claiming, trashing and
  deleting a project, remote sync and linking, the Zotero link, merging,
  deleting a branch and the AI fix now need a browser session; a token used
  to be able to share a project with another account or delete it for good.
- The app's pages can no longer be shown inside another site's frame
  (`frame-ancestors 'none'` and `X-Frame-Options: DENY`), the Connect
  consent page included.
- A Connect refresh must name the client it was issued to (`client_id`);
  one without it is refused like one naming another client.
- Resetting or changing a password now revokes the account's access
  tokens and Connect sessions (refresh tokens and authorization codes not
  yet exchanged included), not only its browser sessions. A token minted by
  whoever held the account before kept reading and writing every project,
  new ones too. The reset screen and Account settings say when agent
  access was revoked.
- `TRUST_PROXY` is a hop count. `TRUST_PROXY=1` used to take the leftmost
  `X-Forwarded-For` entry, which the client writes itself behind nginx's
  `$proxy_add_x_forwarded_for` or a load balancer, so a changing header gave
  every request a fresh sign-in, sign-up and reset limit. The client address
  is now the one the proxy appends. `2` covers a CDN in front of your proxy,
  and a list of proxy addresses or CIDR ranges works too. Bundled Caddy was
  not affected.
- Per-address rate limits count an IPv6 client by its /64, and an
  IPv4-mapped address as its IPv4 address. Every address of one /64 used to
  get its own sign-in budget.
- Passwords are hashed off the event loop, and changing a password is rate
  limited like signing in (`RL_LOGIN_BURST`). A burst of wrong current
  passwords from one account stalled every request and editing session on
  the server.
- A display name keeps at most 100 characters, without control characters,
  from the sign-up form and from a provider profile alike. Sign-up took a
  name as long as the 32 MB request limit, and a few such accounts made
  every account write on the JSON datastore slow, then failed once
  `users.json` passed what one string can hold.
- The file routes refuse a path that names no file, such as `.` or `./`.
  Deleting `.` removed the branch's whole checkout, and on main the
  repository with its history, for anyone who could edit the project, link
  visitors included. A review comment can no longer be anchored to the
  project folder or to git internals: accepting its suggestion wrote that
  file, `.git/config` included.
- The editor's live documents follow the same rule as the file routes: none
  opens for git internals, compile output or the project folder itself.
  Anyone who could edit a project, link visitors and access tokens
  included, could open `.git/config` or a git hook as a document over the
  collaboration socket and have the server run a command of their choosing
  at its next git operation.
- The welcome email no longer greets the new account by the name typed at
  sign-up. Sign-up does not confirm the address, so the name let anyone
  have the instance send their own text and links to any address.
- Rules that depend on the request path hold however the path is
  percent-encoded: the read-only showcase projects
  (`ALDINE_PROTECTED_PROJECTS`), the sign-in needed to list, create and
  import projects, and the short list of routes an access token may use. An
  encoded project id let a visitor edit or wipe a showcase, an encoded path
  let an anonymous visitor create and import projects that then belonged to
  every signed-in user, and let an access token change its account's
  password. An import without a session is now refused before its upload
  is read, not after up to 80 MB of it sat in memory.
- A link visitor can delete only the review comments their own account
  wrote. The check compared display names, which anyone can pick at sign-up.
  Comments written before this release can be deleted by the owner and
  collaborators only.
- Merging takes an existing local branch as `from`, checked like a new
  branch's name. Any other value reached git's command line, where git read
  it as an option or a revision.

## [0.14.4] — 2026-10-24

### Added
- `ALDINE_AI_AUTOFIX=1` on the server: a failed typeset opens the Fix tab
  and runs the diagnosis without a click. It runs once per new error, so
  auto-typeset failing the same way again makes no second model call. Off
  by default. Plugins can bring their own panel forward with
  `aldine.ui.showPanel(id)`.

### Fixed
- The Fix tab kept showing its diagnosis and Apply fix button after you
  fixed the error yourself. A diagnosis now clears once none of the errors
  it answered is left in the latest compile.

## [0.14.3] — 2026-10-22

### Changed
- A compile log over 200 KB keeps its first 20 KB as well as its end,
  with a line marking the cut. The start names the engine, the format
  and the packages loaded, which a long log used to lose.

### Fixed
- Cite and the `\cite` suggestions showed titles cut at TeX markup: "The
  {\TeX}book" read as "The", and "{\LaTeX}: A Document Preparation System"
  lost its first word. Entries now read as they typeset, with logos,
  accents (M{\"u}ller is Müller), escaped characters, inline math, Greek
  letters, dashes and quotes, and a formatting command keeps its text.
- An unbraced value was dropped, so `year = 2020` showed no year. Bare
  numbers now count, and a bare name is looked up in the file's
  `@string` definitions (`journal = jacm`).

## [0.14.2] — 2026-10-22

### Added
- The sidebar folds away at any width: the button at the end of its tabs
  leaves a slim rail, whose button brings it back. The browser remembers
  the choice; the palette has "Hide the sidebar" and "Show the sidebar".

### Changed
- The sidebar's tabs are Files, Cite and Review. History moved into More,
  beside the other plugin panels.
- Cite lists the project's entries at the top, scrolling on their own;
  paper search and add by identifier stay at the bottom of the panel.

### Fixed
- In the file tree a file's icon sat left of its folder's; files now keep
  the chevron's column, so icons line up level by level. The chevrons are
  drawn instead of a font glyph, here and in the problems panel and the
  More tab.

## [0.14.1] — 2026-10-22

### Added
- Project settings → Keyboard shortcuts in this browser: click a shortcut
  and press new keys for typesetting, commenting, jumping the PDF to the
  cursor or the command palette. Keys the browser keeps, keys the editor
  already uses and bare letters are refused with the reason. Labels, the
  palette and the toolbar follow; Reset brings the default back. The palette
  has "Change keyboard shortcuts…".

### Changed
- Commenting on the selection is ⇧⌘M (Ctrl+Shift+M on Windows and Linux)
  instead of ⌘⌥M, which German keyboards make awkward to press.
- The branch pill uses the slimmer branch icon the git-host chip had
  before 0.14.0.

## [0.14.0] — 2026-10-22

### Added
- ⌘⌥M (Ctrl+Alt+M elsewhere) comments on the selected text. The Comment
  button and the palette show the key.

### Changed
- The editor's top bar names the branch once. In a project linked to a git
  host, that pill lists the host's branches, carries the counts of commits
  waiting, and its menu holds push, pull, autopush, the repository link and
  opening a pull or merge request. Pull or Push appears beside the pill only
  while commits wait. Branches that exist only on this server are listed
  apart; push and pull act on main, so they show while main is open.
  Publishing an unlinked project moved into the same menu.
- Share holds the PDF and source-ZIP downloads for everyone who can open the
  project. Inviting and link sharing stay the owner's.
- The preview header lost its title, the engine picker (Project settings and
  the palette keep it) and Download, and gained Jump to PDF and the word
  count from the editor's header, which leaves the visual mode's formatting
  buttons room.
- Project settings: one column of controls, each explanation under its
  label, a drawn chevron on every select, and the options split into This
  project and This browser. The source download moved to Share; the Claude
  connector serves the whole server, so it is reached from the palette and
  the project list instead.
- Two or more plugin panels share one More tab instead of wrapping the
  sidebar's tab row onto a second line.

### Fixed
- At 1280 px the top bar cut the project name short and the preview header
  wrapped; at 1024 px Comment and Typeset were off the screen. The name and
  the search field now give way first, and the preview header drops its
  shortcut hints before it wraps.
- The TeX Live release in Project settings sat at the far right edge, away
  from every other value.
- The search field's magnifier shrank to a dot in a tight top bar.

## [0.13.2] — 2026-10-21

### Fixed
- Import from GitHub listed one page of 100 repositories, organisations'
  included, and a repository outside it could not be found even by its full
  name. The list now holds your own and collaborator repositories, and
  typing in the filter asks the host: GitHub's search across your account
  and organisations, GitLab's project search. On every host an
  `owner/repo` path or a pasted repository URL is looked up directly.
- The Gitea / Forgejo connect form named `read:user` and `write:repository`
  only; publishing a project as a new repository also needs `write:user`.

## [0.13.1] — 2026-10-20

### Changed
- pdfLaTeX typesets load the preamble from a precompiled format: after the
  first typeset of a document, its packages are dumped once in the
  background (mylatexformat), and every later typeset skips loading them.
  On a biblatex, TikZ and pgfplots paper a one-pass edit went from about
  2.7 s to 1.75 s and a full cycle from 7.5 s to 5.1 s. The format is
  rebuilt when the preamble, a file it reads or TeX Live changes; preambles
  that cannot be dumped faithfully (\makeindex, glossaries, filecontents,
  minted and similar) keep the plain run, and a format that breaks a
  document the plain run typesets is dropped. `ALDINE_PREAMBLE_CACHE=0`
  on the compiler turns it off.

## [0.13.0] — 2026-10-20

### Added
- Manual commits: Project settings → History → "Commit changes: When I
  commit" (also in the palette). Edits still save to disk as you type, but
  no longer become "aldine: autosave" commits; History lists the files
  waiting and commits them with your message. Claude's edits still commit
  under its own name, the ZIP download includes the uncommitted edits
  without committing them, and with autopush each of your commits is pushed.

## [0.12.3] — 2026-10-19

### Changed
- Auto-typeset runs a quick draft while you type: one engine pass, no
  bibliography step. When that leaves a new reference, citation or the
  bibliography behind, the full typeset follows by itself four seconds after
  you stop typing; Typeset and ⌘S / Ctrl+S always run the full cycle. The
  palette switches drafts off.

### Fixed
- The PDF preview rendered every CJK character as blank space (Latin text and
  math were unaffected): pdf.js was not given `cMapUrl`/`cMapPacked`, so it
  could not map the glyphs of Identity-H CID fonts such as XeLaTeX's Fandol.
  The build ships the pdfjs-dist CMaps at `<base>/cmaps/`; in dev they
  resolve from the installed package itself, so no dev middleware is needed.
- Pressing Typeset within two seconds of typing ran a second, empty typeset
  afterwards, which replaced the real duration in the status line.

## [0.12.2] — 2026-10-18

(0.12.1 was tagged on a commit outside main and never built.)

### Changed
- When a document typesets with warnings only, the Problems panel folds to
  one line ("3 warnings"); click it to see the list, and it stays the way you
  left it. Errors still open it in full.

### Added
- An Ignore button on each warning hides that kind of warning in the
  project (the same citation or reference on any line). The panel shows how
  many are ignored, with a button to show them again; so does the command
  palette.

## [0.12.0] — 2026-10-18

### Added
- **Connect Claude**: the connector setup for this server, from the command
  palette, Project settings and the project list. It gives the claude.ai,
  Desktop and Cowork steps or the Claude Code command, including the token
  header on a server without accounts, and says when claude.ai cannot reach
  the server. The connector URL follows `ALDINE_PUBLIC_URL` when it is set.
- A project synced with GitHub, GitLab or Gitea notices new commits by
  itself: it checks every 90 seconds while the tab is open and again when you
  come back to it, highlights Pull, and offers a Pull button in a
  notification when commits arrive.
- A search field in the editor toolbar and on the project list opens the
  command palette and shows its shortcut (⌘K / Ctrl+K). The project list has
  its own palette: new project, import, open a project by name, settings.
- The Cite tab lists the entries of the project's .bib files, with a filter
  once there are more than a few; clicking one inserts its `\cite`.
- `deploy/hetzner`: a production stack on one Hetzner Cloud box (about €7 a
  month), with the released images, Caddy, security updates, and nightly
  backups kept on the box and copied to an S3-compatible bucket.
- `deploy/aws` can point the app domain at a box outside AWS (`app_ipv4`)
  and create a send-mail and backup key for it (`offbox_access`).
  `fargate = false` then removes the Fargate service, ALB, EFS, ECR and
  staging, and keeps DNS, SES and the CI role.
- The divider between editor and preview can be dragged with a finger or a
  pen, moved with the arrow keys (Shift for larger steps) and reset with a
  double-click.
- Escape closes the branch menu and the file menu; the file menu stays
  inside the window when opened near an edge.
- Solid surfaces for people who ask for reduced transparency, stronger lines
  and secondary text for increased contrast.
- Moving a project to the trash no longer asks first; the notification has
  an Undo button.

### Changed
- The remote status check fetches into a ref of its own and at most once
  per 30 seconds per project (`REMOTE_STATUS_TTL_MS`), so polling editors
  cost one fetch and never race a pull.
- Every control responds on press, not on release, and shows keyboard focus.
- Menus, the command palette and notifications are translucent surfaces that
  open from their trigger; notifications slide out the way they came in and
  wait while the pointer is on them.
- PDF zoom resizes the pages at once and sharpens them a moment later.
- Switching theme cross-fades instead of jumping in brightness.
- Reduced motion keeps the spinner and the typesetting dot running and turns
  entrances into plain fades.
- On touch screens: fields no longer zoom the page on focus, the delete
  button on a project card is visible, and cards do not stay lifted after a
  tap.
- Questions and renames use Aldine's own dialogs in place of the browser's:
  the confirming button names the action ("Delete branch", "Delete forever"),
  destructive ones are red, and a rename has the name selected up to the
  extension.
- Dialogs, menus and the command palette fade out on close instead of
  vanishing.
- The Source/Visual switch slides its thumb to the selected side.
- Text sizes follow one scale of seven steps and the browser's text-size
  setting; the smallest label is 11 px.
- New app icon: the letter A with a commit line as its crossbar replaces the
  scroll emoji in the browser tab.
- The connector hint in Account settings names Claude's current menu path
  (Customize → Connectors → Add → Add custom connector).

### Fixed
- Typing in the Cite tab's paper search or the Zotero citation search no
  longer loses focus after the first keystroke or when results arrive.
- The server could exit with an unhandled `write EPIPE` when a git command
  finished before reading its input (seen during agent commits under load).
- Visual mode: math that was drawn before the math renderer had finished
  loading stayed as raw source until the caret moved through it. It now
  renders as soon as the renderer arrives.
- The primary button's hover colour in the dark theme left its label under
  the 4.5:1 contrast minimum.

## [0.11.0] — 2026-09-23

### Added
- Sign in with your own OpenID Connect provider (Keycloak, Authentik,
  Authelia, Pocket ID, Dex, …) (#67). Set `OIDC_ISSUER` and `OIDC_CLIENT_ID`, plus
  `OIDC_CLIENT_SECRET` for a confidential client (without it: a public client,
  PKCE only); the sign-in page shows the button next to Google, GitHub and
  ORCID, labelled by `OIDC_LABEL`. The redirect URI is
  `<ALDINE_PUBLIC_URL>/api/auth/oauth/oidc/callback`. Discovery works for
  issuers with a path, is fetched at startup (never fatal) and cached for an
  hour; an unreachable IdP fails the sign-in with a clear message and never
  the boot. Code flow with
  PKCE (S256), state and nonce; the ID token is verified with jose against the
  issuer's JWKS (asymmetric algorithms only; `iss`, `aud`, `azp`, `exp`,
  `iat`, `nonce`). Accounts are keyed by issuer and `sub`; the email address
  is used only when the IdP marks it verified (`OIDC_EMAIL_VERIFIED=trust`
  overrides). `OIDC_ALLOWED_GROUPS` limits sign-in to members of the named
  groups (`OIDC_GROUPS_CLAIM`, from the ID token or userinfo). Works with
  `ALDINE_SSO_ONLY`, a path prefix, and in the middle of the Agent API
  Connect flow. Network failures name their cause (an untrusted certificate
  points at `NODE_EXTRA_CA_CERTS`), a failed hourly discovery refresh keeps
  the last good document, and a half-set configuration is reported at boot.
  Setup recipes, checked against Authentik 2026.8, Keycloak 26, Authelia
  4.39 and Dex 2.41: `docs/OIDC.md`. Authentik sends `email_verified: false`
  by default; the recipe shows both ways to handle that.
- AWS stack: `agent_api = true` serves the Agent API on the production
  service (`ALDINE_MCP=1`); until now only `staging_env` could enable it.

### Changed
- A single-sign-on login whose verified address matches an account already
  bound to a different identity of the same provider is refused instead of
  moving that account to the new identity. The refusal to sign into a
  password or other-provider account with the same address now names the
  provider by its label ("sign in with ORCID").
- Accounts created by single sign-on (Google, GitHub, ORCID, OIDC) can no
  longer be given a password through the API, get no password reset link,
  and cannot use password sign-in. A password would have kept working after
  the person lost access at their identity provider.
- A single-sign-on account created without an email address takes the first
  verified address a later sign-in reports, unless another account has it.
- A sign-in attempt is bound to the provider it started at: a state from
  one provider's sign-in is refused at another provider's callback.
- A failed single-sign-on attempt in the browser ends on a short page with
  the reason and a link back to sign-in, instead of raw JSON.

## [0.10.0] — 2026-09-19

### Added
- The Aldine Agent API: Claude and any MCP client read and write LaTeX in
  Aldine projects, with Aldine as the source of truth. `ALDINE_MCP=1` serves
  the Model Context Protocol over Streamable HTTP at `POST /mcp` (stateless;
  bodies capped at 2 MB; rate limited per client IP and per token, 60 burst
  and 1/s sustained, `RL_MCP_BURST`); the same tools run over stdio
  (`tsx apps/server/src/mcp/stdio.ts`). Auth is mandatory: with
  `AUTH_ENABLED` a personal access token (`Authorization: Bearer aldn_…` or
  `X-Aldine-Token`), without it an operator-set `ALDINE_MCP_TOKEN`; with
  neither every request is 401 and the boot log says how to fix it. Setup
  guide: `docs/AGENT_API.md`.
- Personal access tokens (auth deployments): `POST /api/tokens` mints an
  `aldn_…` bearer (shown once, only a SHA-256 digest stored), optionally
  scoped to projects and with an expiry; `GET /api/tokens` lists, `DELETE
  /api/tokens/:tokenId` revokes. Bearers follow the same project access rules
  as sessions and are refused outside their scope; account surfaces accept
  session cookies only, so a leaked token cannot mint tokens, set a password
  or reach a stored GitHub credential. The "Agent access" card in account
  settings manages tokens and shows the connector URL. `/api/auth/me` returns
  `mcpEnabled` and `publicUrl`.
- OAuth 2.1 for the connector (auth deployments): claude.ai and Claude Code
  connect with a Connect button. Aldine serves the RFC 9728 / RFC 8414
  discovery documents, a consent page at `/oauth/authorize` where the user
  picks the projects the client may touch, `/oauth/token` (authorization code
  + PKCE S256, refresh-token rotation with reuse detection),
  `/oauth/register` (public clients only, capped at 500) and `/oauth/revoke`.
  Clients identify by a registered `aldc_` id or an https client-metadata URL
  fetched with SSRF checks. Access tokens are ordinary 24 h `aldn_` tokens
  listed under Connections on the Agent access card. `/mcp` 401s carry a
  `WWW-Authenticate` challenge; everything is 404 while `AUTH_ENABLED` is
  off.
- Fifteen tools: `list_projects`, `project_structure`, `read_file`,
  `edit_file`, `write_file`, `batch_write`, `compile`, `get_pdf_url`,
  `commit`, `references_add`, `list_citations`, `list_labels`, `wordcount`,
  `create_project`, `trash_project`, plus `ping`, under the same access,
  trash, hidden-path and token-scope guards as the REST API; every result
  echoes `{branch, head}`. `edit_file` anchors on exact quotes (at least 8
  characters, `occurrence` to disambiguate) and lands them in the live
  collaboration document as CRDT edits; a drifted anchor returns
  `stale_anchor` with up to 3 candidates and applies nothing. `write_file`
  and `batch_write` honour `base_version` and refuse with `version_conflict`
  instead of overwriting; `batch_write` lands a multi-file change as one
  commit. A name differing from an existing one only by case, or starting
  with `-`, is refused. `compile` returns parsed errors (capped at 50 with
  `errorsTotal`; a missing `.sty` as a `hint`), a 4 KB log tail, a signed PDF
  link and a deep link, with progress notifications every 10 s; it takes at
  most one of a person's two typeset slots. `references_add` resolves a DOI,
  arXiv or OpenAlex id into the project's `.bib` (default `references.bib`
  beside the root file); `list_citations` and `list_labels` are the indexes
  to consult before writing `\cite` and `\ref`; `wordcount` walks the root
  file's `\input` graph. `trash_project` moves a project to the workspace
  trash (restorable for `ALDINE_TRASH_DAYS`) and accepts only projects made
  with `create_project` (`agentCreated` in `list_projects`); `create_project`
  is refused for a project-scoped token.
- Every agent write is a reviewable commit under the author "Claude", made
  before the tool answers and titled with the intent (`batch_write` under its
  message, `edit_file` and `write_file` under an optional `message`, else
  "Edit <path>" / "Update <path>"; `references_add` under "Add reference
  <key>"). A Claude commit's diff is exactly the agent's delta; a person's
  concurrent typing lands as their own autosave, and "Revert these changes"
  never removes it. `batch_write` edits an open document per span like
  `edit_file` instead of replacing it. `commit` lands agent work a
  refused commit left waiting, else answers `committed:false` with the
  current head and `recentClaudeCommits`. Shutdown flushes pending agent work
  under Claude's name first.
- Signed PDF links: `compile` returns a `pdfUrl` that opens without a session
  for 15 minutes (HMAC-signed, one artifact on one branch, `no-store`), plus
  `pages`, `typesetAt`, `pdfFile` and `pdfStale`; `get_pdf_url` hands out a
  fresh link without recompiling. The secret is `ALDINE_SIGNING_SECRET` (32+
  characters, checked at boot) or is generated once into `META_DIR`.
- The PDF viewer (MCP App): `compile` and `get_pdf_url` results render inline
  in hosts that speak `io.modelcontextprotocol/ui` (claude.ai, Claude Desktop,
  Cowork; other hosts get the link). One self-contained file (`npm run
  build:viewer -w apps/server`, part of `npm run build`, about 2.1 MB; served
  as `ui://aldine/pdf-viewer` when built) with a status row, an error strip
  whose `file:line` rows deep-link into Aldine, page and zoom controls and
  "Open in Aldine". PDFs over 50 MB are not fetched into the chat column.
- Deep links into the editor: `/p/<id>?file=<path>&line=<n>` opens the file
  (exact path, then a suffix match), scrolls the line into view and flashes
  it once the collab doc has synced. A missing file gets a toast and the root
  file; a line past the end says so.
- Agent presence and review in the editor: an agent session shows in the
  presence strip (violet is now reserved for agents), History marks Claude's
  commits, and behind `aldine.experimental.agentPresence` incoming agent
  edits get a tint that fades; the session survives a reload of the page.
  When a session that produced commits goes quiet, a sticky toast ("Claude edited N files", Review) opens its commits
  with their diffs and a "Revert these changes" button backed by `POST
  /api/projects/:id/revert`, which undoes them as one new commit; history is
  never rewritten. Opening a project with Claude commits newer than your last
  acknowledged visit raises the same prompt ("while you were away"); the mark
  is per person, project and branch (`project_visits` on Postgres,
  `visits.json` on the JSON backend, `aldine.agentSeen.<project>.<branch>` in
  the browser without accounts). `GET /api/projects/:id/agent-activity` is
  read-only and `POST …/agent-activity/seen` session-only, so an agent's
  token can never clear a person's prompt.
- The connector works under a URL prefix (`ALDINE_BASE_PATH`, #40): the
  discovery documents are served at the origin-root locations MCP clients
  probe first as well as under the prefix, and `deepLink`, `pdfUrl`, the
  consent page and the connector URL carry it. Reverse proxies must forward
  the two well-known paths (deploy/README.md, deploy/nginx.conf).
- Success metrics as log lines: `[metric] agent_connect`, `agent_compile
  user=… project=… ok=… ms=…` and `agent_revert … commits=…`;
  deploy/README.md carries the CloudWatch Logs Insights queries.
- The public demo box serves the Agent API with a published token
  (`deploy/demo`, variable `mcp_token`, default `aldine-demo`): connector URL
  `https://demo.aldine.dev/mcp` with `X-Aldine-Token: aldine-demo`,
  world-writable, wiped nightly at 04:00 UTC.
- With auth off, the connector's typeset budget (`ALDINE_COMPILE_PER_MIN`) and
  the one-agent-typeset gate are keyed by client address instead of one
  operator bucket; stdio keeps the operator bucket.
- A Claude Code plugin (`claude-plugin/aldine`; `/plugin marketplace add
  trahloff/Aldine`, then `/plugin install aldine@aldine`): the Aldine MCP
  server configured from `ALDINE_URL` (and `ALDINE_TOKEN`; Connect otherwise)
  plus the skills `latex-fix-build`, `latex-draft-section` and
  `latex-bibliography`. Setup in `docs/AGENT_API.md`, "Claude Code plugin".
- Landing page and README: a "Claude as a collaborator" section with a
  recorded clip of the loop, and `llms.txt` names the Agent API and its guide.
- Gitea and Forgejo as a third remote provider, "Gitea / Forgejo", next to
  GitHub and GitLab; one provider covers any instance (Codeberg is the
  example the connect form offers), sub-path installs included. Connect with
  a personal access token (`read:user` and `write:repository`; publishing
  into an organisation also needs `write:organization`) and the mandatory
  instance URL; there is no OAuth. Import, publish, push and pull, branches
  and pull requests work as for the other providers, and the server only
  syncs with an https URL on the instance the link was made on.
  `REMOTE_PROVIDERS` now defaults to `github,gitlab,gitea`; `GITEA_API_BASE`
  exists for the tests only. (#60)
- Download a project as a ZIP: `GET /api/projects/:id/archive?branch=` returns
  the branch's tracked files from git, flat like an Overleaf download (never
  `.git` or build output), after open documents are flushed and committed.
  Reachable from project settings ("Download as ZIP") and the command
  palette; the archive imports back through the ZIP import. (#58)

### Changed
- Write conflicts for the Agent API and `PUT /file` are detected per file, not
  per branch. The branch `contentVersion` is still what a caller passes as
  `base_version` (`baseVersion` on REST), but a write is refused with
  `version_conflict` only when that file changed after the version the caller
  read; git-level rewrites (revert, merge, pull, reset, branch switch) count
  as a change to every path. `GET /file` returns `x-aldine-content-version`
  and `x-aldine-file-version`, `GET /files` returns `{ files, contentVersion
  }` (previously a bare array), tool results carry `fileVersion`, and
  `batch_write` accepts `base_version` per entry.
- Auto-typeset follows Claude, not only the person typing: an agent edit arms
  the same debounce a keystroke arms; with several tabs open on a branch
  exactly one typesets and the others adopt its run. `POST
  /api/projects/:id/compile` takes `reason: "agent"` and `GET
  /api/projects/:id/compile-status` reports the branch's last run. With
  auto-typeset off the preview moves only when the person presses Typeset.
- Reverts, checkpoints and merges made by a signed-in person are committed
  under their account name, and a person's whole-tree commit inside Claude's
  autosave window commits Claude's pending edits under Claude's name first,
  so a human never signs an agent's delta.
- Agent API result shapes: an ambiguous quote is `ambiguous_anchor`
  (candidates carry the `occurrence` that picks each) and `stale_anchor`
  means the quote is gone. `version_conflict` carries a `reason`, and every
  error result echoes `path`, `branch` and `head`. `compile` reports
  `errorsTotal` for errors only and a new `warningsTotal`. `write_file` and
  `batch_write` adopt the first `.tex` of a rootless project as its main
  document (`newRoot`); `wordcount` without one is an error, not 0 words.
  `references_add` returns `created` and a `note` when no `.tex` loads the
  `.bib`; `create_project` returns `contentVersion` and `files`;
  `project_structure` flags `binary` files; a windowed `read_file` echoes
  `from_line`/`to_line`. Missing branches and projects, malformed paths and
  over-long messages are refused with the cause and the fix.
- Commit messages from the tools, `POST /commit`, `/revert` and the GitHub
  push are capped at 200 characters and stripped of control characters before
  they reach git; a commit that still fails is retried under a neutral title.

### Fixed
- Dialogs open at their title: moving focus to the first control no longer
  scrolls a long dialog to its action row.
- The server's git commands can no longer reach outside `DATA_DIR`
  (`GIT_CEILING_DIRECTORIES`): a project directory that lost its repository
  let git discover an enclosing checkout and commit to it.
- A project or branch deleted inside the autosave window no longer logs
  `[collab] autocommit failed …` on every debounce that fires afterwards.
- A typeset that stops on an error and removes the PDF no longer drops the
  preview's stale flag; the download link goes away until the next successful
  run.
- `GET`/`PUT /api/projects/:id/file` flush open collaboration documents to
  disk first; a REST write could silently discard a collaborator's unflushed
  keystrokes.
- `GET /api/projects/:id/wordcount` no longer serves the previous root file's
  count after the root file is switched.
- A file whose name starts with `-` can no longer reach `git commit` as an
  option (`PUT /file` and rename refuse such names), a glob or pathspec-magic
  name (`*.tex`, `:!x.tex`) commits literally, and `/api/projects/:id/log` is
  parsed so a message can no longer move itself into the author field.
- `compile` over the Agent API: a project with no `.tex` file says it has
  nothing to typeset (not that the compiler is down), and a fatal run with no
  PDF is `pdfStale:true` with the previous run's link. Error rows carry
  `context` (the source line TeX was reading) and warnings a `source`
  (`latex`, the package name, `biber`); a biber warning points at the `.bib`
  and its line, a run that died in the preamble no longer repeats the
  previous run's bibliography warnings, and the log tail is the 4 KB around
  the first error. The editor gets the same `context`.
- `references_add` makes every entry typesettable under pdflatex and biber:
  emoji are dropped, Greek letters and relation symbols become their macros
  with their `$` intact, and doi.org's `month = June` becomes the `jun`
  macro. DOI, arXiv and OpenAlex entries share one key rule (`bender2021`)
  and one layout. An unknown id is "No reference found for …", not a lookup
  failure; an entry already present under an older key style (`LeCun_2015`
  for `lecun2015`) is reported as the duplicate, naming the existing key.
- `write_file` onto a folder, under a file or with a trailing slash, and
  `read_file` on a folder, name the cause instead of a server error.
  `read_file` decides text by content, not extension (`.dat`, `.tsv`, `.log`,
  `.xml`, `.svg`, `.lua`, `.py` count as text in the file tree too), and
  refuses a window past the end or running backwards. An agent write keeps a
  Latin-1 or binary file's bytes exact in the commit it makes, so reverting
  the Claude commit restores the original. A write that changes nothing
  answers `commit: null` with `unchanged: true`.
- The new-project dialog asks for GitLab groups only when `/api/remotes`
  reports provisioning (new field `provisioning`), instead of logging a 404
  on each open of an instance without a service token.
- Editor and review flow: on a phone (≤640 px) the preview pane is hidden so
  the editor gets the width; the review dialog wraps long source lines.
  "Revert these changes" re-typesets the preview when auto-typeset is on and
  marks it stale when off; a revert that overlaps a later edit names the
  commit it stopped on. Signed-in people appear to collaborators under their
  account name with one colour in every browser, not "Writer N".
- The sidebar tab row (Files, History, Review and the plugin tabs) wraps
  again instead of hiding its overflow: on wider system fonts and at browser
  zoom the last tabs were cut off. (#59)

## [0.9.0] — 2026-09-10

### Added
- GitLab as a second remote provider, next to GitHub. Import a project from
  gitlab.com or a self-hosted instance (nested group paths included),
  publish a local project to GitLab, optionally into a group, push and pull,
  switch and create branches, and open a merge request from the editor.
  Connect with a personal access token, which needs no configuration and
  accepts any https instance, sub-path installs included, or with OAuth once
  `GITLAB_CLIENT_ID` and `GITLAB_CLIENT_SECRET` name an application with
  scope `api` on `GITLAB_URL` (default `https://gitlab.com`; callback
  `/api/remotes/gitlab/oauth/callback`). `REMOTE_PROVIDERS` is a comma list
  that hides a provider from the UI (default `github,gitlab`);
  `GITLAB_API_BASE` exists for the tests only. Home, onboarding and the
  publish dialog list every enabled provider. (#51)
- Templates from your own git repositories. `TEMPLATE_REPOS` (or a file
  named by `TEMPLATE_REPOS_FILE`) lists repositories laid out like this
  repo's `templates/` folder, one directory with a `template.json` per
  template, on any host that serves git over https: GitHub, GitLab, Gitea, a
  bare repository. Each is cloned shallowly into `CACHE_DIR/template-repos/`
  and its templates join the new-project gallery under the repository's
  label, refreshed every `TEMPLATE_REPOS_REFRESH_MS` (default ten minutes)
  or on demand with "Refresh templates" in the dialog. A private repository
  takes a read token from the env var its `tokenEnv` entry names
  (`user: oauth2` for GitLab, `x-access-token` for GitHub); the token is
  injected per git operation and never written to the checkout. A host that
  is down leaves the previous checkout listed and marks the repository stale
  on its heading; a checkout over `TEMPLATE_REPO_MAX_BYTES` (50 MiB) is
  refused. Templates may use `{{PROJECT_NAME}}`, `{{AUTHOR}}`, `{{DATE}}`
  and `{{YEAR}}` in text files, LaTeX-escaped in `.tex`/`.sty`/`.cls`.
  Layout, manifest and configuration are documented in `templates/README.md`.
  (#50)
- GitLab provisioning for team instances: with `GITLAB_TOKEN` (a service
  account PAT with scope `api` and Owner on the group) and
  `GITLAB_DEFAULT_GROUP` set, every new project, ZIP imports included, is
  also created on GitLab in that group or in a subgroup the user picks or
  creates in the new-project dialog (`GITLAB_DEFAULT_VISIBILITY` = `private`
  default, `internal` or `public`). The server pushes `main` after each
  autosave, debounced by `AUTOPUSH_DEBOUNCE_MS` (default 30 s) with
  exponential backoff, replacing the 20-second browser interval; the owner
  can switch autopush off per project. Deleting a project deletes the
  GitLab project only when Aldine created it (`createdByAldine`), an
  imported repository is never touched; GitLab's delayed deletion is
  purged where the token may, otherwise the scheduled date is reported, and
  restoring the project re-creates it in the same namespace. When GitLab is
  unreachable the project is still created locally and the editor shows a
  pending banner with a retry. (#51)
- AWS stack: `enable_ecs_exec` (off by default) lets an operator open a shell
  in the running server container with `aws ecs execute-command`, for one-off
  inspection of the datastore on EFS. It grants the task role the SSM
  messaging permissions ECS Exec needs; who may open a session stays with IAM.
  Documented in `deploy/aws/README.md`.

### Changed
- The remote-sync routes are provider-neutral: account routes live under
  `/api/remotes/:provider/*` (`status`, `connect`, `disconnect`, `oauth`,
  `repos`, `import`) and project routes under `/api/projects/:id/remote/*`
  (`link`, `status`, `push`, `pull`, `branches`, `switch-branch`,
  `create-branch`, `change-request`, `reset-to-remote`), where the provider
  comes from the stored link. The old `/api/github/*` and
  `/api/projects/:id/github/*` paths keep working as aliases and are
  deprecated, not removed; the GitHub OAuth callback URL operators registered
  is unchanged. Project summaries carry the link as `remote` and, for GitHub
  links, still as `github` for one release so an older web bundle keeps
  working.
- `GET /api/templates` reports the manifest's upstream `source { url,
  version }` as `origin`; `source` now says where a template is listed from
  (`{ kind: "builtin" | "repo" | "venue" | "kit", label? }`), which is what the
  gallery groups and badges by. The `{{PROJECT_NAME}}`, `{{AUTHOR}}`,
  `{{DATE}}` and `{{YEAR}}` placeholders apply to every template source, the
  shipped folders and venue classes included, not only to repositories.
  `template.json` files are unchanged. (#50)
- Browser-side auto-sync is gone: the 20-second interval in the sync toolbar
  and its `aldine.autopush.<id>` localStorage flag are replaced by server-side
  autopush, which runs whether or not a tab is open. Sync of a linked project
  falls back to the linking user's token when the acting user has none and,
  for provisioned GitLab projects, to the service account; listing and
  importing repositories still use the user's own connection only.

## [0.8.0] — 2026-09-10

### Added
- Server admin: `ALDINE_ADMIN_EMAILS` (comma-separated) names the accounts
  that may open `/admin` and `GET /api/admin/{stats,users}`. The page shows
  how many accounts exist, how many were active in the last 7 and 30 days,
  who is editing right now, project and open-document counts, this month's
  compile time, and an accounts table (sign-in method, joined, last seen,
  owned projects, compile minutes). Metadata only: an admin never sees a
  project's files and the project ACL is unchanged. To support "active", the
  server now records `lastSeenAt` per account, written at most every five
  minutes (Postgres gains a `users.last_seen_at` column automatically).
- AWS stack: `enable_ecs_exec` (off by default) lets an operator open a shell
  in the running server container with `aws ecs execute-command`, for one-off
  inspection of the datastore on EFS. It grants the task role the SSM
  messaging permissions ECS Exec needs; who may open a session stays with IAM.
  Documented in `deploy/aws/README.md`.

## [0.7.0] — 2026-09-09

### Changed
- The default compiler image installs whole TeX Live collections instead of
  a hand-picked list: `collection-pictures` (pgfplots, tikz-cd),
  `collection-latexextra` (about 1900 packages: cleveref, todonotes, minted,
  standalone, …) and `collection-bibtexextra` join the publisher classes and
  the script collections. Every "package not found" report so far was one
  of those three; the image grows by about 360 MB (4.3 GB on disk) and CJK
  stays with `-full`. For anything still missing, the README shows a
  three-line `docker-compose.override.yml` that adds `RUN tlmgr install
  <pkg>` on top of the release image, and the missing-package hint in the
  editor points at it; the image keeps its dated TeX Live snapshot
  configured so that install works after the release has aged. (#4)
- Error tracking says which instance and which build an error came from, and
  keeps the document out of it. `SENTRY_ENVIRONMENT` names the instance
  (`staging`, `production`) instead of the environment being read from
  `NODE_ENV`, which every deployed build sets to `production`; the release is
  `SENTRY_RELEASE`, else the running `ALDINE_VERSION`, else the package
  version. Events are stripped of the request body, cookies and headers, and a
  URL is sent without its query string, which is where the file path, the
  branch and a PDF link's signature live. A run with the test hooks on never
  reports at all, so a developer machine that exports `SENTRY_DSN` for another
  project does not file this app's test errors into it.
- Contributors sign the CLA with one click on
  [cla-assistant.io](https://cla-assistant.io/trahloff/Aldine) instead of
  posting a sentence as a pull-request comment. The `contributor-assistant`
  workflow is gone (its upstream was archived in March 2026); the signatures
  it collected were imported, so nobody signs twice, and the
  `cla-signatures` branch stays as the historical record. (#29)

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

[Unreleased]: https://github.com/trahloff/Aldine/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/trahloff/Aldine/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/trahloff/Aldine/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/trahloff/Aldine/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/trahloff/Aldine/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/trahloff/Aldine/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/trahloff/Aldine/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/trahloff/Aldine/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/trahloff/Aldine/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/trahloff/Aldine/releases/tag/v0.1.0
