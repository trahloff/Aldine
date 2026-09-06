# Aldine

**Write LaTeX together. Fast, versioned, yours.**

[![CI](https://github.com/trahloff/Aldine/actions/workflows/ci.yml/badge.svg)](https://github.com/trahloff/Aldine/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-ffdd00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/trahloff)

Aldine is a slim, self-hosted, open-source LaTeX collaboration platform, an
Overleaf alternative built for speed and simplicity. Real-time multi-cursor
editing, every project a real git repo with branches, native Zotero, ~2s warm
recompiles. Two containers and flat files by default: no database to migrate,
nothing to babysit.

**[Try the live demo](https://demo.aldine.dev)** (resets nightly) ·
[Quick start](#quick-start) · [How Aldine compares](#how-aldine-compares) ·
[Screenshots](#screenshots) · [Self-hosting](#production-deploy) ·
[Contributing](CONTRIBUTING.md)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="e2e/shots/editor-dark.png">
  <img alt="Aldine editor: LaTeX source on the left, live PDF on the right, collaborator cursors visible" src="e2e/shots/editor-light.png">
</picture>

Live collaboration, a recompile, and a SyncTeX jump, in one real recording (compile wait trimmed):

![A collaborator's edits stream in live, the PDF recompiles in about two seconds, and double-clicking the PDF jumps the editor to the source line](e2e/shots/demo.gif)

> **Status:** Aldine is young (v0.x). It compiles real papers daily and every
> headline feature has a Playwright end-to-end test, but expect rough edges.
> (CI runs typecheck, build, and the integration suites; the browser tests run
> locally, since they need a TeX Live container.) File issues generously.

## Features

- **Bring your Overleaf projects**: download any Overleaf project as a ZIP,
  drop it on the home screen, keep writing — root file detected, first typeset
  automatic.
- **Real-time collaboration**: CRDT-based (Yjs), multi-cursor with live
  presence, conflict-free by construction. Unlimited collaborators.
- **Git-native with branches**: every project is a real git repository.
  Create branches, edit them independently, merge back from the UI. Publish a
  project to GitHub and a co-author can clone it and keep using VS Code; their
  commits come back with one Pull.
- **Fast, sandboxed compiles**: TeX Live + latexmk with persistent
  incremental builds (~2s warm recompiles) in a no-egress container with
  restricted shell-escape; errors surfaced with line numbers and
  click-to-jump.
- **GitHub sync**: import a repo as a project *or publish a local project to
  a fresh repo*, push/pull with ahead/behind indicators, conflict resolution,
  opt-in auto-sync, and open a pull request, all from the editor.
- **Native Zotero integration**: link your whole Zotero library *or a single
  collection*, no premium tier required; keep a `.bib` in sync with cheap
  version-aware refresh, insert citations from a search panel or via `\cite{`
  autocomplete.

<details>
<summary><strong>Everything else</strong>: visual editor, review mode, AI error fix, SyncTeX, plugins, auth, scaling…</summary>

- **Visual editing mode** (experimental): LaTeX renders as formatted text
  while the source stays authoritative and **byte-stable** (it never rewrites
  source you didn't deliberately edit). WYSIWYG math (click an equation to edit
  it in a MathLive popover), editable tables, inline tracked changes from review
  suggestions, paste-rich-text-to-LaTeX, image-previewing figure chips, and an
  outline. Cursor-reveal shows raw source under the caret, including a remote
  collaborator's. Enable it in the command palette (⌘K), off by default.
- **Review mode**: select text and leave an anchored, threaded comment;
  optionally attach a suggested replacement the author accepts with one click.
  Comments highlight in the editor, resolve/reopen, and track edits.
- **AI error fix** (optional, BYO key): on a failed typeset, get a
  plain-English diagnosis and one-click fixes. Set `OPENROUTER_API_KEY`,
  `OPENAI_API_KEY`, or `ANTHROPIC_API_KEY` on the server to enable (that
  precedence order if several are set; `ALDINE_AI_MODEL` overrides the model).
  The key stays server-side and never reaches the browser. Unset the key and
  Aldine is a 100% AI-free editor.
- **Find and cite papers without leaving the editor**: search the literature
  by title or author (OpenAlex), or paste a DOI / arXiv id — one click appends
  the BibTeX and inserts the `\cite` (no account, free public APIs).
- **SyncTeX both ways**: double-click the PDF to jump to source; ⌘J to jump
  the PDF to your cursor, with a highlight flash.
- **Plugin system**: manifest + ES module plugins add sidebar panels and
  write into the editor. Zotero, references, and AI-fix ship as plugins;
  write your own.
- **Templates & import**: article, IAC conference paper, beamer,
  report/thesis; or import an existing project from an Overleaf ZIP.
- **Editor niceties**: auto-typeset on idle, live whole-document word count,
  spellcheck, PDF zoom + download, drag-drop figure upload, plain-English
  error hints + raw log, command palette (⌘K / Ctrl+K).
- **Multi-user auth** (optional): set `AUTH_ENABLED=1` for login, per-project
  ownership, and sharing (invite-only or link). Google, GitHub & ORCID SSO, or
  email/password (scrypt-hashed, revocable HTTP-only-cookie sessions);
  `ALDINE_SSO_ONLY=1` disables passwords entirely. Off by default
  (single-tenant); the collab socket is access-checked.
- **Scales when you need it**: flat-file storage by default; set
  `DATABASE_URL` for Postgres and `REDIS_URL` for shared rate limits and
  cross-node collab events. One app node is still the supported topology;
  [docs/SCALING.md](docs/SCALING.md) says exactly what is and isn't built.
- **Apple-style UI**: system fonts, hairline borders, light & dark mode,
  keyboard-first (⌘S typeset, ⌘J jump, ⌘K command palette).

</details>

## Quick start

No clone, no build: save this as `docker-compose.yml` and run `docker compose up -d`:

```yaml
name: aldine

services:
  app:
    image: ghcr.io/trahloff/aldine-app:${ALDINE_VERSION:-0.6.0}
    ports:
      - "8080:3000"
    volumes:
      - aldine-data:/data
      - aldine-secrets:/secrets
    networks: [frontend, backend]
    init: true
    restart: unless-stopped

  compiler:
    image: ghcr.io/trahloff/aldine-compiler:${ALDINE_VERSION:-0.6.0}${ALDINE_TEXLIVE:-}
    volumes:
      - aldine-data:/data
    # The compiler runs untrusted LaTeX. Keep this block.
    networks: [backend]
    mem_limit: 2g
    pids_limit: 256
    cap_drop: [ALL]
    security_opt: [no-new-privileges]
    init: true
    restart: unless-stopped

networks:
  frontend: {}
  backend:
    internal: true # no route to the internet

volumes:
  aldine-data:
  aldine-secrets:
```

Open http://localhost:8080. That's it. Projects live in the `aldine-data`
volume, and everything else (auth, SSO, AI fix, email) is opt-in via
environment variables when you want it.

That is the repo-root `docker-compose.yml` verbatim, so a clone works
identically: `git clone https://github.com/trahloff/Aldine && cd Aldine &&
docker compose up -d`. Keep the `name: aldine` line wherever you save it: it
fixes the volume names, which is what lets you switch compose files later and
what `deploy/backup.sh` looks for.

- **You are pinned to a version.** The block above says
  `${ALDINE_VERSION:-0.6.0}`, so a fresh copy installs the current release and
  nothing under a running install changes on its own. To upgrade, read the
  [CHANGELOG](CHANGELOG.md), back up (`deploy/backup.sh`), then:

      ALDINE_VERSION=0.4.0 docker compose pull && docker compose up -d

  To roll back, set `ALDINE_VERSION` to the previous release and run the same
  command. Your projects live in the `aldine-data` and `aldine-secrets`
  volumes and an image swap does not touch them. `:latest` still exists and
  points at the newest release; pinning is what lets you choose when to move.
- **Pre-1.0 stability.** Versions follow SemVer with one caveat: before 1.0
  a minor bump (0.3 to 0.4) may change behaviour or on-disk layout, a patch
  bump (0.4.0 to 0.4.1) will not. Every release is built from a commit that
  passed CI, and its images are booted and made to typeset a real document
  before `:latest` moves to them. Upgrades across a minor are not yet tested
  against existing data, so back up first. Watch the repo's Releases for
  security fixes: per [SECURITY.md](SECURITY.md), only the latest release
  gets them.
- **The first pull is big.** TeX Live lives in the compiler image: about
  1 GB compressed, 3.7 GB on disk. It carries a curated package set, the
  publisher classes, and the Arabic, Persian, Cyrillic and Greek scripts;
  the one family it leaves out is CJK. After the first pull, starts take
  seconds. Ready when `curl localhost:8080/api/health` returns
  `{"ok":true,"name":"aldine"}`.
- **Need a package it does not have?** Every release from 0.4.0 also ships
  all of TeX Live as `-full` (about 2.8 GB compressed, 9 GB on disk). Add
  `ALDINE_TEXLIVE=-full` next to `ALDINE_VERSION` and pull again; the
  missing-package error in the editor tells you the same thing. Project
  settings show which one you are on.
- **Port 8080 taken?** Change the left side of `ports:`.
- **Everything beyond the minimum**: building from source (latest `main`,
  not a release), auth/SSO/AI/email options, TLS, Postgres/Redis. All of it
  lives in [`docker-compose.full.yml`](docker-compose.full.yml), which carries
  the same compiler sandbox and the same volumes, so you can switch without
  losing data: `docker compose -f docker-compose.full.yml up -d --build`.
  The first build pulls TeX Live; expect 15–40 minutes.
  `ALDINE_TEXLIVE_SCHEME=full` builds the all-of-TeX-Live variant instead.

## How Aldine compares

| | Aldine | Overleaf CE (self-hosted) | git + VS Code + LaTeX Workshop |
|---|---|---|---|
| Deploy | 2 containers, `docker compose up` | Toolkit-managed monolith + Mongo + Redis | n/a (local) |
| Real-time collaboration | ✅ CRDT, unlimited collaborators | ✅ | ❌ (async via git) |
| Review comments / suggested edits | ✅ free | Server Pro (paid) | PR reviews |
| Git branches from the UI | ✅ projects *are* git repos | ❌ (git bridge is a paid feature) | ✅ (it *is* git) |
| GitHub sync + PRs from the editor | ✅ | Paid tiers | ✅ natively |
| Zotero | Whole library **or one collection**, free | Premium, whole library | Via Better BibTeX, manual |
| Warm recompile | ~2s (persistent latexmk cache) | Comparable | Fastest (local) |
| Templates gallery | 4 built-in | Huge community gallery | CTAN / your own |
| Package coverage | Curated TeX Live by default (publisher classes, most scripts); **all of TeX Live** with `ALDINE_TEXLIVE=-full` | All of TeX Live | Whatever you install |
| Rich-text / visual editing | ✅ experimental: byte-stable, WYSIWYG math, editable tables, tracked changes | ✅ (rewrites your source) | ❌ |
| Maturity | Young (v0.x, 2026) | A decade in production | Very mature |
| License | AGPL-3.0 | AGPL | MIT/varies |

If Overleaf CE fits you, use it; it's good software. Aldine exists for people
who want track changes, git, and Zotero without paid tiers, in a deployment
they can hold in their head.

## Screenshots

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="e2e/shots/visual-dark.png">
  <img alt="Visual editing mode: the same LaTeX paper rendered as formatted text with typeset math, next to the live PDF" src="e2e/shots/visual-light.png">
</picture>

*Visual editing (experimental): the source rendered as formatted text, byte-stable, with math and tables editable in place. Enable via ⌘K.*

| | |
|---|---|
| <picture><source media="(prefers-color-scheme: dark)" srcset="e2e/shots/review-dark.png"><img alt="Review mode: anchored comment threads with suggested edits" src="e2e/shots/review-light.png"></picture> | <picture><source media="(prefers-color-scheme: dark)" srcset="e2e/shots/branches-dark.png"><img alt="Branch menu on a project" src="e2e/shots/branches-light.png"></picture> |
| Review mode: threads + one-click suggestions | Branches: create, switch, merge from the UI |
| <picture><source media="(prefers-color-scheme: dark)" srcset="e2e/shots/zotero-dark.png"><img alt="Zotero panel: search your library and insert citations" src="e2e/shots/zotero-light.png"></picture> | <picture><source media="(prefers-color-scheme: dark)" srcset="e2e/shots/history-dark.png"><img alt="History view with checkpoints and diffs" src="e2e/shots/history-light.png"></picture> |
| Zotero: cite from your library or collection | History: auto-checkpoints, named checkpoints, diffs |

## Development

```bash
npm install
npm run dev:server     # API + collab on :3000
npm run dev:web        # Vite on :5173 (proxies to :3000)
docker build -t aldine-compiler apps/compiler
docker run -d -p 4020:4020 -v $PWD/.data:/data aldine-compiler
```

### Tests

```bash
npm run typecheck -w apps/web && npm run test -w apps/web   # tsc + vitest
npm run test:github -w apps/server                          # GitHub-sync integration
npm run test:db -w apps/server                              # datastore conformance
```

End-to-end (Playwright; covers compile, collab, branches, plugins, Zotero). The
suite starts its own app on :3100 but not the compiler, and it runs against
`.data-e2e`, so the compiler has to point at that directory or every compile
test fails against a healthy-looking compiler:

```bash
npx playwright install chromium
DATA_DIR=$(pwd)/.data-e2e PORT=4020 node apps/compiler/server.js &   # or a container on the same dir
npm run test:e2e
ALDINE_URL=http://localhost:8080 npm run test:e2e   # against a running compose stack instead
```

## Production deploy

Settings live in a `.env` file next to the compose files, so every later
`docker compose` call picks them up. Give each comment its own line: anything
after a value becomes part of the value, and `AUTH_ENABLED=1  multi-user login`
is not `1`, so auth silently stays off.

```dotenv
# app on loopback only; your reverse proxy fronts it
ALDINE_APP_BIND=127.0.0.1
# absolute URL of the app, used in OAuth callbacks and password-reset links.
# Give it a path to serve Aldine under a prefix (https://server/internal/aldine)
ALDINE_PUBLIC_URL=https://aldine.example.com

# Everything below is optional and off unless set.
# multi-user login, ownership and sharing (unset = single-tenant)
AUTH_ENABLED=1
# Google SSO
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
# GitHub SSO
GITHUB_LOGIN_CLIENT_ID=
GITHUB_LOGIN_CLIENT_SECRET=
# ORCID SSO: a Public API client (orcid.org/developer-tools, HTTPS callback
# <ALDINE_PUBLIC_URL>/api/auth/oauth/orcid/callback); ORCID_SANDBOX=1 for sandbox.orcid.org
ORCID_CLIENT_ID=
ORCID_CLIENT_SECRET=
# GitHub repo sync: a separate OAuth app with repo scope
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
# AI error fix, bring your own key
OPENROUTER_API_KEY=
# password-reset email: SMTP, or SES_FROM + AWS_REGION instead
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=
# error tracking, and which instance the errors came from
SENTRY_DSN=
SENTRY_ENVIRONMENT=production
```

```bash
# Behind your existing reverse proxy (nginx, Traefik, …), the usual setup. The
# prod overlay trusts proxy headers, sets secure cookies, and rotates logs;
# point your proxy at 127.0.0.1:8080.
# Sample nginx vhost (WebSocket + body-size gotchas handled): deploy/nginx.conf
docker compose -f docker-compose.full.yml -f deploy/docker-compose.prod.yml \
  up -d --build

# …or, if nothing else owns ports 80/443, add the bundled Caddy for
# zero-config HTTPS: append `--profile tls` and set ALDINE_DOMAIN in .env.

# Back up the data + secrets volumes:
deploy/backup.sh aldine-backup.tar.gz
# Restore, after stopping the stack with `docker compose down`:
#   deploy/restore.sh aldine-backup.tar.gz
```

Every variable Aldine reads is listed in
[deploy/README.md](deploy/README.md#all-configuration).

**Isolation & limits.** The compiler runs on an internal-only Docker network
(no internet egress), drops all Linux capabilities, and is bounded on CPU /
memory / PIDs; LaTeX compiles with **restricted shell-escape** (whitelist
only) and `openin_any=p`. Per-client rate limits guard login, AI, and
reference lookups; compiles are concurrency-capped, with optional per-user
compile quotas (`ALDINE_COMPILE_QUOTA_MIN`) if you host for a group.

See [deploy/README.md](deploy/README.md) for the full single-VPS runbook
(nginx/Traefik/Caddy ingress, backups, SSO setup, Postgres/Redis, every
config variable),
[deploy/aws](deploy/aws) for a Terraform/Fargate deployment, and
[SECURITY.md](SECURITY.md) for the threat model and how to report
vulnerabilities.

## Architecture

```
┌────────────┐   HTTP/WS    ┌──────────────────────────────┐
│  Browser   │ ───────────► │  app (Node 22)               │
│  React +   │              │  Fastify API + Hocuspocus    │
│  CM6 + Yjs │              │  git repos + worktrees       │
└────────────┘              └──────────┬───────────────────┘
                                       │ shared volume /data
                            ┌──────────▼───────────────────┐
                            │  compiler (TeX Live medium)  │
                            │  latexmk wrapper, sandboxed  │
                            └──────────────────────────────┘
```

- One Yjs document per file per branch (`project::branch::path`), persisted
  straight to the git worktree with debounced writes and auto-commits.
- Branches are git worktrees, so every branch is editable concurrently.
- Compile output stays inside the project tree (`.aldine-out/`, kept out of
  git history) which keeps latexmk's incremental cache warm.

### Data & storage

Two separate concerns, behind two seams:

- **Project files**: real git repos + worktrees on disk (`store.ts`). This is
  what gives you branches and history.
- **Relational/metadata**: users, sessions, project metadata, review comments,
  and usage go through the `DataStore` interface (`db/`). Two backends:
  - **JSON files** (default, zero-dependency): the slim single-node self-host.
  - **Postgres** (set `DATABASE_URL`): the horizontally-scalable backend, and
    the prerequisite for ever running multiple app nodes. `pg` is an optional
    dependency; the same conformance suite runs against both.

For how this scales past one box (and what the remaining walls are), see
[docs/SCALING.md](docs/SCALING.md).

## Plugins

A plugin is a folder in `plugins/`:

```
plugins/hello/
├── manifest.json   # { "id": "hello", "name": "Hello", "version": "1.0.0", "entry": "index.js" }
└── index.js        # export default { activate(aldine) { ... } }
```

The `aldine` API exposes `ui.registerSidebarPanel`, `editor.insertAtCursor`,
`project` context, `compile()`, `toast()`, and `fetch()`. See
`plugins/zotero` for a complete example.

## License

Copyright (C) 2026 Tobias Rahloff.

[AGPL-3.0](LICENSE): self-host freely; if you offer a modified Aldine as a
service, share your changes. Third-party plugins interact with Aldine over its
plugin API and may use any license. Each folder under `templates/` carries its
own `LICENSE` and states it in `template.json` (the gallery shows it on the
tile): the generic templates are MIT, and `templates/iac-paper` is LPPL-1.3c,
the customary license for a LaTeX class file. Venue templates are generated
from the classes installed in the compiler image, with the license `tlmgr`
reports; no publisher file is stored in this repository. Overleaf is a
trademark of its owners; Aldine is an independent project, not affiliated with
or endorsed by Overleaf.

Two things stated plainly, because finding them out later feels like a
bait-and-switch. **A hosted Aldine service is planned**, and contributions are
accepted under a [CLA](CLA.md) that permits relicensing, so a commercially
licensed edition is possible in future. What will not change: the self-hosted
edition stays AGPL-3.0, and no feature that works today moves behind a paid
tier. The name is handled separately in [TRADEMARK.md](TRADEMARK.md).
