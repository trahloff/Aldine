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
  ownership, and sharing (invite-only or link). Google & GitHub SSO, or
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
    image: ghcr.io/trahloff/aldine-app:latest
    ports:
      - "8080:3000"
    volumes:
      - aldine-data:/data
      - aldine-secrets:/secrets
    networks: [frontend, backend]
    init: true
    restart: unless-stopped

  compiler:
    image: ghcr.io/trahloff/aldine-compiler:latest
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

- **The first pull is big** (~2.5 GB; TeX Live is in the compiler image);
  after that, starts take seconds. Ready when `curl localhost:8080/api/health`
  returns `{"ok":true,"name":"aldine"}`. Images are published on release tags.
- **Port 8080 taken?** Change the left side of `ports:`.
- **Everything beyond the minimum**: building from source (latest `main`),
  auth/SSO/AI/email options, TLS, Postgres/Redis. All of it lives
  in [`docker-compose.full.yml`](docker-compose.full.yml), which carries the
  same compiler sandbox and the same volumes, so you can switch without
  losing data:
  `docker compose -f docker-compose.full.yml up -d --build`. The first build
  installs LaTeX packages; expect 15–40 minutes.
- **Need packages beyond the curated set?** Build the full file with all of
  CTAN preinstalled (~9 GB on disk):
  `ALDINE_TEXLIVE_SCHEME=full docker compose -f docker-compose.full.yml up -d --build`.

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
| Package coverage | Curated set, or **all of CTAN** (`ALDINE_TEXLIVE_SCHEME=full`) | All of TeX Live | Whatever you install |
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
# absolute origin used in OAuth callbacks and password-reset links
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
# error tracking
SENTRY_DSN=
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
plugin API and may use any license. `templates/iac-paper/iac.cls` is LPPL-1.3c,
the customary license for a LaTeX class file. Overleaf is a trademark of its
owners; Aldine is an independent project, not affiliated with or endorsed by
Overleaf.

Two things stated plainly, because finding them out later feels like a
bait-and-switch. **A hosted Aldine service is planned**, and contributions are
accepted under a [CLA](CLA.md) that permits relicensing, so a commercially
licensed edition is possible in future. What will not change: the self-hosted
edition stays AGPL-3.0, and no feature that works today moves behind a paid
tier. The name is handled separately in [TRADEMARK.md](TRADEMARK.md).

## Bubble Server Setup

How the bubble-robotics instance is deployed, start to finish. It is a slightly
awkward shape — Aldine shares a box with GitLab, so it cannot own ports 80/443
— and every step below exists because of that or because sign-in is Google-only.

- `https://aldine.bubble-robotics.com`, reachable from anywhere
- co-hosted with GitLab, proxied by GitLab Omnibus's bundled nginx
- accounts are Google Workspace only; there is no password login at all
- the checkout lives in `~/aldine`; system steps need `sudo`, compose calls
  assume your user is in the `docker` group (otherwise prefix those too)
- do not run the clone under `sudo -i`: `~` becomes `/root` and every path
  below stops matching. And `sudo cmd > /file` redirects as *your* user and
  fails — pipe through `sudo tee` instead

### 1. DNS

One record on `bubble-robotics.com`: CNAME `aldine` → `public.bubble-robotics.com`.
The name must resolve publicly before step 4 — Let's Encrypt validates from
outside the network.

```bash
dig +short aldine.bubble-robotics.com     # must end at the office public IP
```

### 2. Google OAuth client

In the Cloud project that already holds the GitLab client
(https://console.cloud.google.com):

1. **OAuth consent screen** — confirm **User type: Internal**. This is what
   limits sign-in to `bubble-robotics.com` accounts, and it is the *only* thing
   that does: Aldine creates an account for any verified email a configured
   provider returns.
2. **Credentials → Create credentials → OAuth client ID**, type **Web
   application**, authorised redirect URI exactly:
   `https://aldine.bubble-robotics.com/api/auth/oauth/google/callback`

A second client rather than reusing GitLab's: the two would share one secret,
so rotating it for Aldine would sign everyone out of GitLab. No JavaScript
origins are needed — the code exchange is server-side.

### 3. Code and config

```bash
git clone https://github.com/trahloff/Aldine.git ~/aldine
```

`~/aldine/.env`, mode 600, never committed:

```dotenv
ALDINE_PUBLIC_URL=https://aldine.bubble-robotics.com
# loopback only; nginx is the only thing that talks to the app
ALDINE_APP_BIND=127.0.0.1
# 8080 is GitLab's Puma; the vhost expects 8090
ALDINE_PORT=8090
# saves repeating -f flags on every compose call
COMPOSE_FILE=docker-compose.full.yml:deploy/docker-compose.prod.yml:images.yml
AUTH_ENABLED=1
# no password endpoints at all, so no SMTP and no reset flow to secure
ALDINE_SSO_ONLY=1
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
```

`images.yml` runs the published images instead of building; on a box already
serving GitLab, building the compiler means compiling TeX Live locally.
Validate the merge with `docker compose config >/dev/null`.

### 4. First certificate

The real vhost cannot be installed yet — nginx refuses to start when
`ssl_certificate` points at a file that does not exist — and bolting an ACME
location onto GitLab's own server block does not reliably work: with
`redirect_http_to_https` on, the port-80 block is a separate 301-only server,
and an unmatched `Host` lands on whichever block is nginx's default. The
challenge then reaches GitLab itself, which answers **404**.

So serve the challenge from a block that must match, via `deploy/nginx.aldine-bootstrap.conf`
(port 80, ACME only, no certificate references):

```ruby
# /etc/gitlab/gitlab.rb — reconfigure rewrites its own config on every run,
# which is why the vhost lives outside /var/opt/gitlab and is pulled in
nginx['custom_nginx_config'] = "include /etc/nginx/conf.d/*.conf;"
```

```bash
sudo apt install -y certbot
sudo mkdir -p /etc/nginx/conf.d /var/www/acme/.well-known/acme-challenge
sudo cp ~/aldine/deploy/nginx.aldine-bootstrap.conf /etc/nginx/conf.d/aldine.conf
sudo gitlab-ctl reconfigure
```

Prove the path works before spending a certbot attempt — Let's Encrypt allows
five failed validations per hostname per hour. Test with an explicit `Host`
header against loopback: from the box, the public name resolves to the office
public IP, which the router does not loop back, and `curl -s` hides the
resulting connection error so you get a confusing blank line.

```bash
echo probe | sudo tee /var/www/acme/.well-known/acme-challenge/probe
sudo chmod -R a+rX /var/www/acme
curl -i --max-time 5 -H 'Host: aldine.bubble-robotics.com' \
  http://127.0.0.1/.well-known/acme-challenge/probe        # want 200 + "probe"
```

403 means webroot permissions (nginx runs as `gitlab-www`); 404 means the
request is being handled by another server block. Then:

```bash
sudo certbot certonly --dry-run --webroot -w /var/www/acme -d aldine.bubble-robotics.com
sudo certbot certonly --webroot -w /var/www/acme -d aldine.bubble-robotics.com \
  --deploy-hook 'gitlab-ctl hup nginx' -m paul@bubble-robotics.com --agree-tos
```

`--webroot`, never `--nginx`: certbot cannot parse Omnibus's generated config.

### 5. Real vhost

```bash
sudo cp ~/aldine/deploy/nginx.aldine.conf /etc/nginx/conf.d/aldine.conf
sudo gitlab-ctl reconfigure          # bad config fails here; nothing is applied
sudo rm /var/www/acme/.well-known/acme-challenge/probe
curl -sI https://aldine.bubble-robotics.com | head -1      # 502 until step 6
```

That 502 is the success signal: TLS terminated, vhost matched, nothing upstream
yet. Check GitLab still answers too. The vhost keeps its own ACME location for
renewals, caps bodies at 32m (ZIP import), rate-limits `/api/auth/`, and names
its WebSocket map `$aldine_connection_upgrade` — GitLab defines
`$connection_upgrade` in the same http block, and duplicates are a hard error.

### 6. Start Aldine

```bash
cd ~/aldine && docker compose pull && docker compose up -d
docker compose ps               # app + compiler → healthy
```

### 7. Verify

- sign in with a work account; a personal `@gmail.com` must be refused by Google
- new project → ⌘S → PDF renders (compiler container + shared volume)
- same project in two browsers → live cursors (`/collab` WebSocket headers)
- `sudo certbot renew --dry-run`

### 8. Backups and upgrades

```bash
sudo cp ~/aldine/deploy/aldine-backup.{service,timer} /etc/systemd/system/
# systemd does not expand `~`; the unit needs the absolute path
sudo sed -i "s|^WorkingDirectory=.*|WorkingDirectory=$HOME/aldine|" \
  /etc/systemd/system/aldine-backup.service
sudo systemctl daemon-reload && sudo systemctl enable --now aldine-backup.timer
```

Daily 03:30 snapshot of both volumes to `/var/backups/aldine`, 14 kept; restore
with `deploy/restore.sh <tarball>` after `docker compose down`. Upgrades are
`git pull && docker compose pull && docker compose up -d`.

### When it breaks

| Symptom | Cause |
| --- | --- |
| `redirect_uri_mismatch` at Google | `ALDINE_PUBLIC_URL` differs from the console URI, character for character |
| 502 through nginx | app down, or `ALDINE_PORT` no longer matches the vhost |
| Login page with no Google button | `GOOGLE_OAUTH_*` blank — and `ALDINE_SSO_ONLY=1` leaves no other way in |
| ACME challenge 404 | a server block other than Aldine's answered; see step 4 |
| `duplicate map name` on reconfigure | the WebSocket map was renamed back to `$connection_upgrade` |
| Editor loads, no live cursors | the `/collab` block lost its `Upgrade` headers |

### Known gap

Nothing in Aldine restricts sign-in by email domain, so the Internal consent
screen is the whole boundary for an internet-facing instance: the day that
client is switched to External, or a GitHub login client is configured here,
this becomes open registration. Worth closing with a domain allowlist plus
Google's `hd` hint.
