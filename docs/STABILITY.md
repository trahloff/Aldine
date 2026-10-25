# What 1.0 promises

People keep their papers in Aldine. This page says what a 1.x release will
not break, what an upgrade will need from you (nothing beyond pulling the
new images), and what the promise leaves out. It is written for the person
who runs the instance.

Aldine is at 0.14 today. Until 1.0 the rule in the
[CHANGELOG](../CHANGELOG.md) still holds: a minor release may change
behaviour or the on-disk layout, a patch release will not. Where this page
says "from 1.0", it describes the promise and the check that will back it;
the last section says which of those checks exist today.

## Versions

From 1.0, versions follow [SemVer](https://semver.org/) for everything this
page lists as covered:

| Release | What it may do |
|---|---|
| Patch (1.2.0 to 1.2.1) | Fix bugs. Nothing covered changes shape. |
| Minor (1.2 to 1.3) | Add settings, MCP tools, parameters, result fields and plugin API members. Deprecate, never remove. |
| Major (1.x to 2.0) | Remove what an earlier minor deprecated. The release notes say what and how to move. |

A change counts as breaking when an instance that worked before needs a
manual step after the upgrade: data it cannot read, a setting that stops
working or changes meaning, an MCP tool call or a plugin that stops working.

Releases go out once a week, with security fixes and data-loss fixes in
between ([CONTRIBUTING.md](../CONTRIBUTING.md#releasing)). Every release
publishes immutable `x.y.z` images. The `x.y` tag (the newest patch of that
minor) and `latest` move only after the maintainer approves the release.
The quick-start compose file pins `ALDINE_VERSION`, so nothing changes under
a running instance until you change the pin. The promise covers tagged
releases, not a build of `main`.

## Your data

### Where it lives

| What | Where | Format |
|---|---|---|
| Projects | `DATA_DIR/projects/<id>`: one git repository per project, with `main` checked out | git |
| Other branches | `DATA_DIR/worktrees/<id>/<branch>`: a git worktree each | git |
| Compile output, the page-1 thumbnail included (`.<root>.thumb.jpg` and `.json`) | `.aldine-out/` beside the root file, kept out of git | rebuilt on the next typeset |
| Accounts, sessions, tokens, project settings, comments, usage, each person's project list (`opens.json`) and each project's last edit and typesets (`activity.json`) (JSON, the default) | `META_DIR`: `users.json`, `sessions.json`, `tokens.json` and the other flat files, `meta/<id>.json`, `comments/<id>.json` | JSON |
| The same, with `DATABASE_URL` set | the Postgres database | tables Aldine creates |
| Collaboration state | `META_DIR/yjs/`, one `.ybin` file per document | Yjs binary update |
| Signing secret for PDF links and sign-in device cookies | `META_DIR/output-signing-secret`, unless `ALDINE_SIGNING_SECRET` is set | text |
| Caches | `CACHE_DIR`: template-repository checkouts, downloaded venue kits | disposable |

The project repositories are plain git: you can clone, read and back them up
without Aldine running. The compose files put `DATA_DIR` (`/data`) on the
`aldine-data` volume and `META_DIR` (`/secrets`) on `aldine-secrets`. The
compiler mounts only the first, which is why the two must stay apart.
`deploy/backup.sh` archives both volumes, and with the bundled Postgres a
dump of the database (one outside the stack is backed up with its own
tools). From 1.0 the image names (`ghcr.io/trahloff/aldine-app`,
`aldine-compiler`, `-full` for all of TeX Live), the volume names and these
two paths stay as they are within 1.x.

### How each part migrates today

- **Git repositories.** Nothing rewrites them. Aldine keeps `.aldine-out/`
  (and `.papyr-out/`, the name before the rename) in the repository's
  exclude file and takes either out of the index on the next commit.
- **JSON files.** There is no schema version. Readers treat a missing field
  as absent, and an older shape is converted where it is read: `usage.json`
  from before July 2026, and a project's `github` link, which becomes
  `remote` on its next write. Metadata from the old location
  (`DATA_DIR/meta`) is moved to `META_DIR` at start.
  An account without `emailPending` (the `email_pending` column in Postgres)
  counts as having a confirmed address, so accounts written before 1.0 need
  no step.
- **Postgres.** At every start Aldine runs `CREATE TABLE IF NOT EXISTS` and
  `ADD COLUMN IF NOT EXISTS` for its tables. There is no version table and no
  down-migration.
- **Project list state.** `opens.json` and `activity.json` (the
  `project_opens` and `project_activity` tables) start empty on an upgrade.
  A project without a recorded last edit gets one from its git history, the
  newest commit on any branch, without a name; a branch's typeset shows after
  its next typeset.
- **Yjs snapshots.** Not versioned: each file is what Yjs 13 writes for a
  document's state. The `.tex` file on disk is the source of truth. A
  snapshot that does not match the file is brought in line with it, and one
  that cannot be read is dropped and the document starts from the file.
- **Switching between JSON and Postgres** is not a migration. Nothing copies
  one into the other, so choose the backend before people use the instance.

### The upgrade promise

From 1.0: **any 1.x release starts on data written by an earlier 1.x, or by
0.14 or later, with no manual step.** That covers every row of the table
above, with either datastore.

The upgrade check in the release workflow backs this
(`.github/workflows/lifecycle.yml`). It starts the previous release, and the
oldest release the promise covers (0.14.4, `OLDEST_SUPPORTED` in that file),
on a fresh instance, fills it through the API (accounts, projects with
several files, commits, a branch, review comments, a share, a personal
access token), then starts the candidate on the same volumes and checks that
all of it is still there and still works, typeset included, with the JSON
and with the Postgres datastore. A failure stops the release before `latest`
moves. The same check runs on pull requests that change how data is stored.
It covers what it seeds, not everything an instance can hold, so back up
before an upgrade all the same.

Not promised: going back to an earlier release. Releases so far have added
fields and columns rather than changing them, but nothing checks a
downgrade. Back up before you upgrade, and restore that backup to go back.

## Settings

**Stable from 1.0:** every variable in the main table of
[deploy/README.md, "All configuration"](../deploy/README.md#all-configuration).
Within 1.x a stable variable keeps its name and its meaning. A minor release
may add new ones, and a changed default is listed under "Changed" in the
CHANGELOG.

**Not covered:** the variables under "Tests and internals" in the same file.
They exist for the test suites and for tuning, and may change in any release.

**Experimental:** no environment variable is experimental today.
Experimental features are switched on per browser, from the command palette
(`aldine.experimental.*` flags), and may change or disappear in any release.

`DATABASE_URL` and `REDIS_URL` are stable settings, but running more than
one app node with them is not a supported topology
([SCALING.md](SCALING.md)).

## Agent API (MCP tools)

The MCP endpoint (`ALDINE_MCP=1`, [AGENT_API.md](AGENT_API.md)) serves 16
tools. The schema a client reads from `tools/list` is the contract:

| Tools | Parameters |
|---|---|
| `ping`, `list_projects` | none |
| `project_structure`, `compile`, `get_pdf_url`, `list_citations`, `list_labels`, `wordcount` | `project?`, `branch?` |
| `read_file` | `project?`, `branch?`, `path`, `from_line?`, `to_line?` |
| `edit_file` | `project?`, `branch?`, `path`, `edits[]` of `{quote, replacement, occurrence?}`, `base_version?`, `message?` |
| `write_file` | `project?`, `branch?`, `path`, `content`, `base_version?`, `message?` |
| `batch_write` | `project?`, `branch?`, `files[]` of `{path, content \| edits, base_version?}`, `message` |
| `commit` | `project?`, `branch?`, `message` |
| `references_add` | `project?`, `branch?`, `query`, `bibFile?` |
| `create_project` | `name`, `template?` |
| `trash_project` | `project` |

From 1.0, within 1.x: no tool is removed or renamed; no parameter is removed,
renamed or made required; no result field is removed; the error names
`version_conflict`, `stale_anchor` and `ambiguous_anchor` stay. A minor
release may add tools, optional parameters and result fields. Tool
descriptions are wording for Claude and may change.

## Plugin API

A plugin is a folder with a `manifest.json` (`id`, `name`, `version`,
`entry`, and optionally `description`, `icon`, `slots`, `enabled`) and an
ES module whose default export has `activate(aldine)`. The `aldine` object says
`version: 1` and has:

- `project`: `id`, `branch`, `activeFile()`, `lastCompile()`,
  `refreshFiles()`, `refresh()`
- `editor.insertAtCursor(text)`, `compile()`, `toast(text, kind?)`,
  `fetch(url, init?)`
- `ui.registerSidebarPanel({ id, title, render(el) })`, `ui.showPanel(id)`

From 1.0 these keep working across 1.x. A change that breaks a plugin raises
`aldine.version` and ships in a major release. The routes a plugin reaches
with `fetch()` are the REST API, which is not covered (below), and neither
is the page around a panel: its markup and styles.

## REST API

The `/api` routes are the web app's own and are not documented. They are not
covered and may change in a minor release. Personal access tokens work
against them, but a script that should survive upgrades uses the MCP tools.
One exception: `GET /api/health` keeps answering `{"ok":true,"name":"aldine"}`
while the app is up, because healthchecks rely on it.

## Deprecation

From 1.0, a stable setting or MCP tool that a minor release deprecates keeps
working for at least one further minor release, logs a warning when it is
used, and is listed under "Deprecated" in the CHANGELOG with what replaces
it. It goes away no earlier than the next major release.

A renamed setting is read with `envWithFallback(new, [old])` from
`apps/server/src/config.ts`: the new name wins, the old one keeps working,
and each old name in use logs one warning per process that names both. No
setting has been renamed so far, so nothing logs this warning today.

## Not covered

- The web interface: layout, wording, default keyboard shortcuts.
- Experimental features and everything under "Tests and internals".
- The REST API, apart from `/api/health`.
- TeX Live. A release may move to a newer snapshot, and a package update can
  change how a document typesets. Pin `ALDINE_VERSION` to keep the TeX Live
  you have.
- More than one app node, builds of `main`, and downgrades.

## How each promise is checked

| Promise | Check | Today |
|---|---|---|
| Upgrades start on older data, JSON and Postgres | the upgrade check in the release workflow (`lifecycle.yml`), from the previous release and from 0.14.4 | in place |
| Both datastores behave the same | the datastore conformance suite, in CI on every pull request and release | in place |
| Released images boot and typeset | the smoke test in the release workflow, against the published digests | in place |
| MCP tool names and parameters | `apps/server/test/mcp-contract.test.mjs` compares `tools/list` with the snapshot in `test/fixtures/mcp-contract.json` and fails on a removed or renamed tool or parameter, a parameter made required or a changed type; it also calls the tools for the three error names | in place |
| Plugin API | `e2e/tests/06-plugins.spec.ts` loads the fixture plugin in `e2e/fixtures/plugins/api-probe` and checks every member listed above by what it does | in place |
| Stable settings keep their names | `apps/server/test/stable-settings.test.mjs` reads the main table of `deploy/README.md` and fails on a variable that the server, the compiler or (for the deployment's own) the compose files no longer read | in place |
| Deprecations warn | settings: `apps/server/test/env-fallback.test.mjs` checks that an old name read through `envWithFallback` still works and warns once. MCP tools: none, no tool is deprecated | in place for settings |
