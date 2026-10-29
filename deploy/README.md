# Deploying Aldine on a single VPS

This is the recommended production setup: one dedicated-CPU box (e.g. a Hetzner
CCX, OVH, or any VPS with ≥8 GB RAM and 2+ dedicated vCPUs), Docker Compose for
the stack, and **your existing reverse proxy** (nginx, Traefik, …) — or the
bundled Caddy if you don't have one — for TLS. No managed platform required.
(On Hetzner, [`deploy/hetzner`](hetzner/) creates the box and runs this setup
with backups for about €7 a month. Prefer AWS? There's a complete Terraform
deployment — Fargate, EFS, ALB, SES — in [`deploy/aws`](aws/).)

On a NAS instead of a VPS:

- CasaOS and ZimaOS: import [`deploy/casaos/docker-compose.yml`](casaos/docker-compose.yml) under App Store → Custom Install.
- TrueNAS 24.10 and later: [docs/TRUENAS.md](../docs/TRUENAS.md) (Install via YAML).
- Unraid: [docs/UNRAID.md](../docs/UNRAID.md) (Compose Manager Plus).

## 1. Provision

- A VPS with **2+ dedicated vCPUs, ≥8 GB RAM, ≥40 GB disk**. LaTeX compiles are
  CPU/RAM bursts (~2 GB each) — size for your expected concurrent compiles.
- A domain, with an **A/AAAA record** pointing at the box.
- Install Docker Engine + the compose plugin.

```bash
sudo mkdir -p /opt/aldine && cd /opt/aldine
git clone <your-repo> .
```

## 2. Configure

Create `/opt/aldine/.env` (compose reads it automatically):

```dotenv
ALDINE_PUBLIC_URL=https://aldine.example.com
ALDINE_APP_BIND=127.0.0.1          # app on loopback only; your proxy fronts it
#ALDINE_DOMAIN=aldine.example.com  # only needed for the bundled-Caddy option (3c)

# multi-user mode
AUTH_ENABLED=1
# Single sign-on (optional; each provider is independent). Set the callback/redirect
# URI in the provider console to  <ALDINE_PUBLIC_URL>/api/auth/oauth/<provider>/callback
# Google:  https://console.cloud.google.com/apis/credentials  (OAuth client, type "Web")
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
# GitHub login (SSO):  https://github.com/settings/developers
GITHUB_LOGIN_CLIENT_ID=...
GITHUB_LOGIN_CLIENT_SECRET=...
# ORCID login (SSO): https://orcid.org/developer-tools (Public API client; the
# callback must be HTTPS). Researchers whose ORCID email is private get an
# account without an email; invite them by ORCID iD.
ORCID_CLIENT_ID=...
ORCID_CLIENT_SECRET=...
# Your own OpenID Connect provider (Keycloak, Authentik, Authelia, Pocket ID):
# redirect URI <ALDINE_PUBLIC_URL>/api/auth/oauth/oidc/callback. Leave the
# secret out for a public client (PKCE only). Recipes: docs/OIDC.md
OIDC_ISSUER=https://auth.example.com/application/o/aldine/
OIDC_CLIENT_ID=...
OIDC_CLIENT_SECRET=...
OIDC_LABEL=Company login
#OIDC_ALLOWED_GROUPS=aldine-users

# GitHub sync (import repos as projects, push/pull) — a SEPARATE OAuth app with
# repo scope. Callback: <ALDINE_PUBLIC_URL>/api/github/oauth/callback
# (users can also connect with a Personal Access Token, no app needed).
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
# GitLab sync — an OAuth application on your instance with scope `api`.
# Callback: <ALDINE_PUBLIC_URL>/api/remotes/gitlab/oauth/callback
# (Personal Access Token connect needs none of these, on any https instance).
GITLAB_URL=https://gitlab.com
GITLAB_CLIENT_ID=...
GITLAB_CLIENT_SECRET=...
# Gitea / Forgejo sync (Codeberg included) has no settings: users connect with a
# personal access token and their instance URL.
# REMOTE_PROVIDERS=github,gitlab,gitea   # comma list; leave one out to hide it
# GitLab provisioning — every new project is also created on GitLab, in this
# group or a subgroup the user picks, and every autosave is pushed from the
# server. GITLAB_TOKEN is a service-account PAT with scope `api` and Owner on
# the group (Maintainer cannot delete projects). Off unless both are set.
GITLAB_TOKEN=glpat-...
GITLAB_DEFAULT_GROUP=research/latex
# GITLAB_DEFAULT_VISIBILITY=private   # or internal | public
# AUTOPUSH_DEBOUNCE_MS=30000          # quiet period after an autosave before the push

# AI error-fix (bring your own key; unset = feature off). If several are set,
# precedence is OPENROUTER > OPENAI > ANTHROPIC. Leave ALDINE_AI_MODEL unset to
# use the provider's default — if you do set it, use that provider's naming
# (e.g. "anthropic/claude-opus-4.8" for OpenRouter, "claude-opus-4-8" for
# direct Anthropic).
OPENROUTER_API_KEY=sk-or-...
#ANTHROPIC_API_KEY=
#OPENAI_API_KEY=
#ALDINE_AI_MODEL=
# 1 = a failed typeset opens the Fix tab and diagnoses on its own, once per
# new error (each one is a model call)
#ALDINE_AI_AUTOFIX=1

# email for sign-up confirmation, password-reset links and share invitations: SMTP (any provider)
# or AWS SES — set one transport (plus ALDINE_PUBLIC_URL). Without one, both
# kinds of link are logged server-side for you to pass on (reset tokens are
# echoed in the API response when ALDINE_RESET_ECHO=1 — dev only).
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
SMTP_FROM="Aldine <no-reply@aldine.example.com>"
#SMTP_SECURE=1                    # implicit TLS (port 465) instead of STARTTLS
#SES_FROM="Aldine <no-reply@aldine.example.com>"   # AWS SES instead of SMTP
#AWS_REGION=eu-west-1             # required with SES_FROM

# optional per-user compile quota, in minutes per month (blank = uncapped).
# Useful when hosting for a group; over-quota compiles return HTTP 402.
ALDINE_COMPILE_QUOTA_MIN=

# error tracking (optional). SENTRY_ENVIRONMENT separates this instance from
# your others in the issue list; without it every instance files as production.
SENTRY_DSN=
SENTRY_ENVIRONMENT=production

# Templates from your own git repositories (optional): a JSON array, inline or
# in a file via TEMPLATE_REPOS_FILE. Each entry's templates show in the gallery
# under its label. A private repository takes a read token from the env var
# named by "tokenEnv" ("user": oauth2 for GitLab, x-access-token for GitHub).
# Layout, manifest and placeholders: ../templates/README.md
#TEMPLATE_REPOS='[{"id":"lab","label":"Lab templates","url":"https://gitlab.example.org/latex/templates.git","tokenEnv":"TEMPLATE_REPO_LAB_TOKEN"}]'
#TEMPLATE_REPO_LAB_TOKEN=
#TEMPLATE_REPOS_REFRESH_MS=600000  # re-fetch interval; floor 60000
#TEMPLATE_REPO_MAX_BYTES=52428800  # per-checkout cap, 50 MiB

# Shared rate limits and cross-node access-revocation events (the `redis`
# profile). This does NOT make multiple app nodes a supported topology: routing
# each project's /collab socket to a consistent node isn't built, and client
# cookie stickiness is not a substitute (two collaborators on one project can
# still land on different nodes and dual-seed the document). Run one app node
# and scale it vertically; ../docs/SCALING.md has the details. A single node
# needs none of this.
#REDIS_URL=redis://redis:6379
```

## 3. Launch + ingress

Start the stack. All options below use the same command: the prod overlay
rotates logs and sets `TRUST_PROXY=1` + `COOKIE_SECURE=1`, the
`ALDINE_APP_BIND=127.0.0.1` line from step 2 keeps the app port on loopback so
only your proxy can reach it, and the compiler runs on an internal-only network
with no egress and all Linux caps dropped.

```bash
docker compose -f docker-compose.full.yml -f deploy/docker-compose.prod.yml up -d --build
```

Then pick the ingress you already run. Aldine is one upstream (`127.0.0.1:8080`)
serving the app, `/api`, `/plugins`, and the `/collab` WebSocket — any reverse
proxy works as long as it forwards WebSocket upgrades and allows 81 MB bodies
(a 60 MB ZIP import travels base64-encoded inside JSON; uploads need 32 MB).

### 3a. nginx (most common)

Use the committed sample vhost — it handles both gotchas:

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/aldine.conf
# edit: server_name + ssl_certificate paths (e.g. certbot --nginx)
sudo ln -s /etc/nginx/sites-available/aldine.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

See [`deploy/nginx.conf`](nginx.conf) — the load-bearing lines are
`client_max_body_size 81m` (nginx's 1 MB default breaks ZIP import; 32m from
an older copy cuts a ZIP import off at about 24 MB) and the
`Upgrade`/`Connection` headers on `/collab` (without them the editor loads but
live cursors never appear).

### 3b. Traefik

If Traefik runs in Docker on the same host, put the app on Traefik's network
and route by labels. Add an overlay of your own (names depend on your Traefik
setup):

```yaml
# traefik.yml overlay — compose -f docker-compose.full.yml -f deploy/docker-compose.prod.yml -f traefik.yml up -d
services:
  app:
    networks: [frontend, backend, proxy]     # `proxy` = your external Traefik network
    labels:
      traefik.enable: "true"
      traefik.http.routers.aldine.rule: Host(`aldine.example.com`)
      traefik.http.routers.aldine.entrypoints: websecure
      traefik.http.routers.aldine.tls.certresolver: letsencrypt   # your resolver name
      traefik.http.services.aldine.loadbalancer.server.port: "3000"
networks:
  proxy:
    external: true
```

WebSockets pass through Traefik without extra config. Bump the body limit only
if you set a global `buffering` middleware (none by default).

Note that the app keeps publishing its host port: compose **merges** port lists
across files, so an overlay cannot remove one by omission. With
`ALDINE_APP_BIND=127.0.0.1` from step 2 that port is on loopback, which is
usually what you want. To drop it entirely, add `ports: !override []` to the
`app` service in your overlay (compose 2.24+).

### 3c. No proxy yet? Bundled Caddy

If the box runs nothing else on 80/443, add `--profile tls` and set
`ALDINE_DOMAIN` in `.env` — Caddy provisions and renews the certificate
automatically:

```bash
docker compose -f docker-compose.full.yml -f deploy/docker-compose.prod.yml --profile tls up -d --build
```

## 4. Backups (systemd timer)

```bash
sudo cp deploy/aldine-backup.service deploy/aldine-backup.timer /etc/systemd/system/
# WorkingDirectory in the .service already points at /opt/aldine
sudo systemctl daemon-reload
sudo systemctl enable --now aldine-backup.timer
```

Daily snapshots of the `aldine-data` (projects/git) and `aldine-secrets` (users,
sessions, keys, comments, usage) volumes land in `/var/backups/aldine`, 14 kept.
On the Postgres datastore (`DATABASE_URL` pointing at the bundled `db`
service) users, sessions, project metadata, comments and usage live in the
database instead, and each tarball also holds a `pg_dump` of it, so the stack
must be up when the backup runs. A database outside the stack, such as a
managed Postgres, is not in the tarball: back it up with its provider's tools
and set `ALDINE_BACKUP_DB=skip` for `deploy/backup.sh`, which otherwise
refuses to write a backup without it. (If your compose project name isn't
`aldine`, set `ALDINE_PROJECT` for both scripts.)

Check that it took: `systemctl list-timers aldine-backup.timer` shows the next
run, and `systemctl start aldine-backup.service` forces one now. If you
installed these units before 0.4.0 they were named `papyr-backup.*`; disable
the old ones with `sudo systemctl disable --now papyr-backup.timer` and delete
them from `/etc/systemd/system/`, or you will run both.

### Restore

On the same box, or on a new one set up with steps 1 to 3 (the checkout and
the same `.env`), with the tarball copied over:

```bash
cd /opt/aldine
docker compose -f docker-compose.full.yml -f deploy/docker-compose.prod.yml down
# Postgres datastore only: start the database by itself, the restore loads into it
docker compose -f docker-compose.full.yml -f deploy/docker-compose.prod.yml --profile postgres up -d db
deploy/restore.sh /var/backups/aldine/aldine-20261024.tar.gz
docker compose -f docker-compose.full.yml -f deploy/docker-compose.prod.yml up -d
# (append --profile postgres, --profile tls and any other profiles you run)
```

`deploy/restore.sh` replaces everything in the two volumes, and the database
when the backup holds one, with the contents of the backup. It refuses while
the app is running, and asks before it overwrites anything (`--yes` skips the
question). Afterwards people are still signed in and access tokens still
work.

Each file of the JSON datastore (`users.json`, `sessions.json` and the
others at the top of the secrets volume, and those in `meta/` and
`comments/`) keeps a `.bak` beside it: the version before its last write. If
a crash or the volume going read-only leaves a file empty or cut short, the
server restores it from the `.bak` the next time it reads it (the top-level
files at startup) and logs both names; only the last change to that file is
lost. When neither can be read, the server refuses to start, or that project
fails to open, with the file named: restore from a backup. The backups carry
the `.bak` files along, and a restore puts them back with the rest.

Every release runs exactly these steps on an empty Docker, for both
datastores, before it can become `latest`: `scripts/lifecycle/drill.sh
restore` seeds a stack, backs it up while it runs, deletes it with its
volumes, restores it and checks every account, file, commit, branch, comment,
share and token. You can run the drill yourself (`DATASTORE=postgres` for the
database); it uses its own compose project, `aldine-lifecycle` on port 8191,
and never touches the `aldine` volumes.

## 5. Upgrade

```bash
cd /opt/aldine && git pull
docker compose -f docker-compose.full.yml -f deploy/docker-compose.prod.yml up -d --build
# (append --profile tls if you use the bundled Caddy, plus any other profiles you run)
```

## Sign-up and invites

With `AUTH_ENABLED=1` and password sign-in on, anyone who can reach the
instance can create an account, and nobody checks the address they type. So a
new password account starts with its address **not confirmed**:

- Sign-up sends a one-time confirmation link (valid 7 days) through the email
  transport. Without a transport, or without `ALDINE_PUBLIC_URL`, the server
  logs the link (`[aldine] email confirmation for <address>: <link>`) for you
  to pass on, the way it logs password-reset links. The banner on the project
  list offers a new link. A mailed new link replaces the previous one; a
  logged one does not, so a link you already passed on keeps working until
  it expires.
- Until the address is confirmed, the account signs in and works on its own
  projects, but projects shared with that address do not appear, and
  `ALDINE_ADMIN_EMAILS` does not count it. Once it is confirmed, the shares
  apply at once; no invite has to be sent again.
- The link confirms only while the account it was sent for is signed in.
- A completed password reset from an emailed (or logged) link also confirms
  the address. With `ALDINE_RESET_ECHO=1` it does not, because the API hands
  the reset token to whoever asks.
- Accounts from before this check, and every single sign-on account, count as
  confirmed: the identity provider vouches for its addresses (see
  `OIDC_EMAIL_VERIFIED` in [docs/OIDC.md](../docs/OIDC.md)). `/admin` marks
  pending accounts "not confirmed".
- Adding an email address in the share dialog mails that address an
  invitation with a link to the project, once, when it is added. The owner's
  own address must be confirmed, and at most `RL_INVITE_BURST` (default 20)
  invitations go out per owner per hour. Without a transport, without
  `ALDINE_PUBLIC_URL`, or over the limit, sharing still saves and the dialog
  tells the owner to let the person know themselves. ORCID iDs get no mail.

Password sign-in is limited per client address (`RL_LOGIN_BURST`) and per
account across all addresses: after 5 failed tries in a row, each further try
must wait 1, 2, 4 ... seconds, at most 60, and a correct sign-in resets the
count. Unknown addresses are counted the same way, so the answer never shows
whether an account exists. A browser that has signed in to the account before
carries a signed cookie (`aldine_device`, one year) that keeps it out of the
per-account wait, so someone who only knows the address cannot lock its owner
out; it still counts against the per-address limit. Both counters live in
Redis when `REDIS_URL` is set, so they hold across app nodes. The cookie is
signed with `ALDINE_SIGNING_SECRET` and bound to the account's current
password: rotating the secret, or changing or resetting the password, makes
every browser sign in once more before it is exempt again (the browser that
changes the password keeps its exemption).

## Managing accounts

`/admin` lists every account: whether its address is confirmed, whether it
is disabled, how it signs in and when it was last seen. **Manage** on a row
offers the actions below. Each asks first, and each writes one line to the
server log naming the administrator, the action and the account
(`[aldine] admin <you> [<id>] disabled <them> [<id>]`).

- **Disable account** signs the person out everywhere at once and refuses
  every way back in: password, ORCID, OpenID Connect and the other single
  sign-on providers, access tokens, the Claude connector (OAuth refresh and
  MCP) and the collab socket, whose open connections close on every app
  node. Their projects stay, and collaborators keep access; the GitHub,
  GitLab or Gitea connection they linked a project with stops serving it
  (autopush falls back to the GitLab service account, if any), and the
  Zotero library of a project they own stops syncing. **Enable
  account** lets them sign in again, and their access tokens and connector
  work again, unless you ticked "Also revoke …" when disabling, which ends
  those for good (do that when the account may be compromised, and send a
  reset link before enabling it).
- **Confirm address** marks a pending address confirmed, in place of the
  link the server logs when it sends no email. Shares to that address apply
  at once. An address on `ALDINE_ADMIN_EMAILS` cannot be confirmed here:
  that would make whoever signed up with it an administrator.
- **Email reset link** sends the person the mail the "Forgot password" form
  sends. Without an email transport (or `ALDINE_PUBLIC_URL`) the button reads
  **Create reset link** and shows you the one-time link to pass on, valid for
  an hour; it is shown only to you, only then, and never logged. Only
  password accounts have one, and the link is never shown for another
  account whose address is on `ALDINE_ADMIN_EMAILS`, confirmed or not
  (following it would confirm the address and make an administrator).
- **Delete account** asks you to type the address (an account without one:
  its name) and to choose what happens to the projects it owns, the ones in
  its trash included. Give them to another enabled account, yours included,
  which becomes their owner (their Zotero links are removed, since they hold
  the deleted person's key). Or move them to the trash, where nobody can
  restore them and the daily sweep purges them after `ALDINE_TRASH_DAYS`;
  as when an owner trashes a project, a GitLab repository Aldine created for
  it is deleted with it. The account comes off every share list that names
  its ORCID iD or its confirmed address (an invite to an address it never
  confirmed stays, for whoever owns the address), and its sessions, access
  tokens, connector grants, linked GitHub/GitLab/Gitea connections and
  project-list state are removed. Its compile seconds stay in the instance
  totals, and comments and commits keep the name they were written under.
  The address is free for a new sign-up afterwards, which inherits nothing.

You cannot disable or delete your own account, nor another account on
`ALDINE_ADMIN_EMAILS` (remove the address from the list and restart first).
An account whose address is on the list but not confirmed is not an
administrator, so you can disable or delete it: it may be someone who signed
up with that address before its owner did. The actions need `AUTH_ENABLED=1`
and a signed-in browser session (access tokens are refused), accept only a
JSON body, so a form on another site cannot trigger them, and are limited
to `RL_ADMIN_BURST` (default 30) in a row per administrator.

## Scaling notes

- **Scale vertically first** — a bigger box absorbs a lot of users before you
  need HA. LaTeX compiles are the resource driver; if you host for a group,
  cap them per user with `ALDINE_COMPILE_QUOTA_MIN` and read `/api/usage` for a
  usage UI. Users over quota get HTTP 402 with `quotaExceeded: true`.
- **When one box isn't enough**, move the compiler off the app box: run the
  compiler container on a cheap burstable machine against the shared data volume
  (NFS or similar) and set `COMPILER_URL` to point at it. The app knows exactly
  one compiler URL, so a *fleet* of them needs a load balancer in front, and
  that path isn't tested yet.
- **Datastore**: the default is flat JSON files (fine for one node). Postgres is
  the prerequisite for ever running more than one app node, and the switch is
  config, not code:
  ```bash
  # in .env
  DATABASE_URL=postgres://aldine:aldine@db:5432/aldine
  # bring up with the bundled Postgres (or point at a managed one)
  docker compose -f docker-compose.full.yml -f deploy/docker-compose.prod.yml \
    --profile postgres up -d
  ```
  Users, sessions, tokens, project metadata, comments and usage are then
  stored in Postgres; git repos stay on disk, and the Yjs snapshots and the
  signing secret stay in the secrets volume. The same test suite passes on
  both backends. Nothing copies an existing instance's JSON files into
  Postgres: an instance switched over starts with no accounts and lists no
  projects, so choose the backend before people use it. `deploy/backup.sh`
  puts a dump of the bundled database in its tarball (section 4).
  On Kubernetes, or wherever the secrets volume is network storage, use
  Postgres even for one node: the JSON files are only as safe as that
  volume's handling of a crash or a forced read-only remount.
  Enabling Redis works the same way: `--profile redis` plus the `REDIS_URL`
  line in `.env`.

See [../docs/SCALING.md](../docs/SCALING.md) for the full multi-node picture
and the remaining single-node walls.

## Agent API metrics

The app writes one log line per agent-initiated typeset and one per revert
of Claude-authored commits — no extra storage, so any log store that can
filter lines answers the three questions from
[docs/plans/agent-api/00-overview.md](../docs/plans/agent-api/00-overview.md):

```
[metric] agent_compile user=<id> project=<id> ok=<true|false> ms=<n>
[metric] agent_revert user=<id> project=<id> commits=<n>
```

`user` is `operator` on an auth-off instance. On the AWS stack the app's
log group is in CloudWatch; these Logs Insights queries run over a 14-day
window (Claude's own commits are those authored "Claude"; the total agent
commit count for the revert share is
`git log --author=Claude --since=… --oneline | wc -l` over the project
repos, or the History panel):

```
# 1. second-week agent compile: users whose SUCCESSFUL agent compiles span
#    more than a week (first and last more than 7 days apart); a broken
#    compiler or a user who never got a PDF must not count as retained
filter @message like /\[metric\] agent_compile/
| parse @message "user=* project=* ok=* ms=*" as user, project, ok, ms
| filter ok = "true"
| stats min(@timestamp) as first, max(@timestamp) as last by user
| filter last - first > 7 * 24 * 3600 * 1000

# 2. agent compiles per connected project per week
filter @message like /\[metric\] agent_compile/
| parse @message "user=* project=* ok=* ms=*" as user, project, ok, ms
| stats count() / 2 as perWeek by project
| sort perWeek desc

# 3. reverted agent commits (divide by the Claude-authored commit count)
filter @message like /\[metric\] agent_revert/
| parse @message "commits=*" as commits
| stats sum(commits) as reverted
```

Connections are logged as `[metric] agent_connect user=… via=pat|oauth
scope=all|N` when a token is minted or a Connect consent is granted, so
"connected" in query 2 can be the set of users with an `agent_connect` line
rather than one inferred from compiles. A compile the compiler refused
before running (its `DATA_DIR` is not the server's) is logged as
`[aldine] agent compile could not start …`, not as a metric line. Metric 4
(the demo-connector → self-host funnel) is Phase 4 and not instrumented.

Without CloudWatch: `docker compose logs app | grep '\[metric\]'` and the
same arithmetic.

## All configuration

Everything is env-gated; blank/unset means "off" or the listed default. The
compose files hand a variable to a container only when they name it:
`docker-compose.full.yml` passes most of the table through from `.env`. For
`ALDINE_ADMIN_EMAILS`, `ALDINE_TRASH_DAYS`, `PG_POOL_MAX`, `LOG_LEVEL`,
`CACHE_DIR`, `PLUGINS_DIR`, the `RL_*` limits and the compiler's
`ALDINE_PREAMBLE_CACHE`, `ALDINE_THUMBNAILS` and `THUMBNAIL_TIMEOUT_MS`, add
the line under `environment:` of the `app` (or `compiler`) service in an
override file.

| Variable | Purpose |
|---|---|
| `ALDINE_DOMAIN` | Domain Caddy serves + provisions TLS for (`tls` profile) |
| `ALDINE_PUBLIC_URL` | The public URL of the instance — origin plus the path prefix when Aldine is served under one (`https://aldine.example.com` or `https://server/internal/aldine`). Used in OAuth callbacks, reset links, and by the MCP connector (OAuth issuer, PDF links, the in-chat viewer's fetch allowlist) — required for SSO, email and the connector |
| `ALDINE_MCP` | `1` = serve the MCP endpoint at `/mcp` for Claude (see [docs/AGENT_API.md](../docs/AGENT_API.md)). Needs a credential: `AUTH_ENABLED=1` (Connect button or personal access tokens) or `ALDINE_MCP_TOKEN`; with neither, every request is 401. `RL_MCP_BURST` tunes its rate limit (default 60) |
| `ALDINE_MCP_TOKEN` | Static bearer for `/mcp` when `AUTH_ENABLED` is off (single-tenant); ignored with auth on. Sent as `Authorization: Bearer …` or `X-Aldine-Token` |
| `ALDINE_SIGNING_SECRET` | Signs the connector's 15-minute PDF links and the browser cookie that exempts a known browser from the per-account sign-in wait; at least 32 characters (`openssl rand -base64 32`), shorter refuses to boot. Blank = generated once into `META_DIR`; set it when app nodes do not share that volume, rotate it to expire every outstanding link (and that exemption) |
| `ALDINE_BASE_PATH` | URL prefix to serve under (`/internal/aldine`) when Aldine shares a host with other apps. Defaults to the path of `ALDINE_PUBLIC_URL`, else the root. The proxy passes the prefix through unchanged; `/api/health` also answers at the root for healthchecks. The Claude connector URL is `<ALDINE_PUBLIC_URL>/mcp`; OAuth discovery also lives at the origin root with the prefix inserted (`/.well-known/oauth-authorization-server<prefix>`, `/.well-known/oauth-protected-resource<prefix>/mcp`), so the proxy must forward those two paths to Aldine as well as the prefix itself |
| `ALDINE_APP_BIND` | Host interface for the app port (set `127.0.0.1` behind a proxy) |
| `ALDINE_PORT` | Host port for the app in `docker-compose.full.yml` (default `8080`). The bundled Caddy reaches the container directly and ignores it; if you run the nginx sample, change its two `proxy_pass` upstreams to match, and use the same port in a local `ALDINE_PUBLIC_URL` |
| `AUTH_ENABLED` | `1` = multi-user login, ownership, sharing. Unset = single-tenant, no login |
| `ALDINE_ADMIN_EMAILS` | Comma-separated emails that may open `/admin` (accounts, active users, projects, compile time) and disable, confirm, reset or delete accounts there (see [Managing accounts](#managing-accounts)). Never project content; needs `AUTH_ENABLED=1` to mean anything. A password account counts only once it has confirmed its address (see [Sign-up and invites](#sign-up-and-invites)) |
| `ALDINE_SSO_ONLY` | `1` = disable password auth entirely (SSO only) |
| `GOOGLE_OAUTH_CLIENT_ID/SECRET` | Google SSO |
| `GITHUB_LOGIN_CLIENT_ID/SECRET` | GitHub SSO (login) |
| `ORCID_CLIENT_ID/SECRET`, `ORCID_SANDBOX` | ORCID SSO (login); `ORCID_SANDBOX=1` targets sandbox.orcid.org |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | OpenID Connect SSO with your own identity provider; redirect URI `<ALDINE_PUBLIC_URL>/api/auth/oauth/oidc/callback`. No secret = public client (PKCE only). Setup recipes in [docs/OIDC.md](../docs/OIDC.md) |
| `OIDC_LABEL`, `OIDC_SCOPES` | Button text (default `Single sign-on`); scopes (default `openid email profile`, `openid` always added) |
| `OIDC_ALLOWED_GROUPS`, `OIDC_GROUPS_CLAIM` | Comma-separated groups allowed to sign in (unset = everyone the IdP authenticates); the claim holding them (default `groups`) |
| `OIDC_EMAIL_VERIFIED` | `require` (default): use the IdP's address only when `email_verified` is true; `trust`: always (only if users cannot edit their address at the IdP) |
| `GITHUB_CLIENT_ID/SECRET` | GitHub **sync** OAuth app (repo import/push/pull) — separate from login. Its redirect URL stays `<ALDINE_PUBLIC_URL>/api/github/oauth/callback` |
| `GITLAB_URL` | GitLab instance the OAuth connect talks to (default `https://gitlab.com`). Users connecting with a personal access token can point the dialog at any https instance, sub-path installs included |
| `GITLAB_CLIENT_ID/SECRET` | GitLab **sync** OAuth application with scope `api`; redirect URL `<ALDINE_PUBLIC_URL>/api/remotes/gitlab/oauth/callback`. Unset = token connect only |
| `REMOTE_PROVIDERS` | Comma list of remote providers offered in the UI (default `github,gitlab,gitea`; `gitea` is Gitea and Forgejo, Codeberg included, token connect with a mandatory instance URL and no server-side settings); leave one out to hide it |
| `GITLAB_TOKEN` | Service-account personal access token for GitLab provisioning: scope `api`, Owner on `GITLAB_DEFAULT_GROUP` (Maintainer cannot delete projects). Used only to create projects and subgroups in the group, push provisioned projects, and delete projects Aldine created; never to list or import a user's repositories. Provisioning is off unless both this and `GITLAB_DEFAULT_GROUP` are set |
| `GITLAB_DEFAULT_GROUP` | Full path of the root group new projects are created in (`research/latex`); users may pick any subgroup of it in the new-project dialog, or create one. Deleting a project deletes the GitLab project only when Aldine created it, an imported repository is never touched; GitLab's delayed deletion is handled (a purge is requested, otherwise the scheduled date is reported), and restoring the project re-creates it in the same namespace |
| `GITLAB_DEFAULT_VISIBILITY` | Visibility of provisioned GitLab projects: `private` (default), `internal` or `public` |
| `AUTOPUSH_DEBOUNCE_MS` | Quiet period after an autosave commit on `main` before the server pushes a provisioned project (default `30000`). Failed pushes back off exponentially, capped at 15 minutes, and stop after 8 attempts until the next commit |
| `SMTP_HOST/PORT/USER/PASS/FROM`, `SMTP_SECURE` | Sign-up confirmation and password-reset email via SMTP |
| `SES_FROM` + `AWS_REGION` | Sign-up confirmation and password-reset email via AWS SES (instead of SMTP); `AWS_DEFAULT_REGION` is read when `AWS_REGION` is unset |
| `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` / `OPENAI_API_KEY` | AI error-fix; precedence OpenRouter > OpenAI > Anthropic |
| `ALDINE_AI_MODEL`, `ALDINE_AI_BASE_URL` | Override AI model / OpenAI-compatible endpoint |
| `ALDINE_AI_AUTOFIX` | `1` = a failed typeset opens the Fix tab and diagnoses without a click (default off) |
| `ALDINE_COMPILE_QUOTA_MIN` | Per-user compile minutes per month (blank = uncapped) |
| `DATABASE_URL` | Postgres datastore (blank = flat JSON files) |
| `PG_POOL_MAX` | Postgres pool size (default 10) |
| `REDIS_URL` | Shared rate limits + collab sync across app nodes |
| `SENTRY_DSN` | Error tracking. Server errors only (5xx and unhandled rejections); URLs are sent without their query string, and request bodies, cookies and headers are dropped |
| `SENTRY_ENVIRONMENT` | Which instance an error came from (`production`, `staging`, …). Defaults to `NODE_ENV`, then `production` |
| `SENTRY_RELEASE` | Build an error belongs to. Defaults to `ALDINE_VERSION`, then the package version |
| `TRUST_PROXY` | How many reverse proxies stand in front of the app; the client address is the one the outermost of them adds to `X-Forwarded-For`. `1` = one proxy (set by the prod overlay; needed behind any proxy), `2` = a CDN or load balancer in front of your proxy. Or the proxies' addresses and CIDR ranges, comma-separated (`loopback,10.0.0.0/8`). Unset or `0` = off |
| `COOKIE_SECURE` | `1` = Secure session cookies (prod overlay sets it) |
| `RL_LOGIN_BURST`, `RL_REGISTER_BURST`, `RL_AI_BURST`, `RL_AI_REFILL_PER_MIN`, `RL_REF_BURST`, `RL_SEARCH_BURST`, `RL_REPLACE_BURST`, `RL_COPY_BURST` | Rate-limit tuning (sane defaults) |
| `RL_ADMIN_BURST` | Account actions on `/admin` one administrator may take in a row (default 30, then one every 2 seconds) |
| `RL_INVITE_BURST` | Invitation mails a project owner may send per hour when sharing by email (default 20). Over it, sharing still saves and the owner is told who was not mailed |
| `COPY_MAX_BYTES` | Largest project, in bytes of files, that Duplicate copies (default 256 MB); a larger one is refused with a pointer to Download ZIP |
| `RL_MCP_BURST`, `RL_VISIT_BURST`, `RL_OAUTH_TOKEN_BURST`, `RL_OAUTH_REGISTER_BURST`, `RL_OAUTH_CLIENT_BURST` | Bursts for MCP requests (default 60), review-mark writes (60), the OAuth token endpoint (30), client registration (10) and consent-page client lookups (60) |
| `ALDINE_SEARCH_MS` | Time a project search or replace may scan before it is stopped and refused (default 2000 ms). Each scan runs in a worker thread of its own; one per person and four per server at a time |
| `ALDINE_COMPILE_PER_MIN` | Typesets per minute per client (default: no limit). Meant for a public demo under launch traffic |
| `ALDINE_PROTECTED_PROJECTS` | Comma-separated project ids that every visitor may read and typeset and nobody may change (a public demo's sample papers) |
| `LOG_LEVEL` | Server log level (default `info`; `warn` keeps only warnings and errors) |
| `DATA_DIR` | Project git repositories, their branch worktrees and each branch's `.aldine-out` compile output. The image sets `/data`. The compiler's `DATA_DIR` must be the same volume |
| `META_DIR` | Secrets and metadata: the JSON datastore (each file with its last-good `.bak`), the Yjs snapshots, the generated signing secret. The image sets `/secrets`. Keep it out of `DATA_DIR`: the compiler must never see it |
| `CACHE_DIR` | Template-repository checkouts and downloaded venue kits (default `.cache/latex` in the install directory, which in the image is not on a volume: the cache starts empty when the container is recreated) |
| `COMPILER_URL` | Where the app reaches the compiler (default `http://localhost:4020`; the image sets `http://compiler:4020`) |
| `PORT` | Port inside the container: the app listens on `3000`, the compiler on `4020` |
| `PLUGINS_DIR` | Folder of plugins the app serves (the image sets `/srv/plugins`, the built-in three) |
| `ALDINE_MCP_CLIENT_TOKEN` | For the stdio MCP entry point (`dist/mcp/stdio.js`): the value of `ALDINE_MCP_TOKEN`, which it must present when that is set (or pass `--token`) |
| `RL_COMPILE_CONCURRENCY` | Typesets one client (the signed-in user, else the IP address) may have in flight on an app node (default 2) |
| `COMPILE_TIMEOUT_MS`, `MAX_CONCURRENT_COMPILES` | Compiler-container limits: per-compile timeout (default 120000 ms) and compiles in flight (default 2). `docker-compose.full.yml` passes both through from `.env` |
| `ALDINE_PREAMBLE_CACHE` | Compiler container. `0` turns off the precompiled preamble (pdfLaTeX projects load their packages from a format built in the background, rebuilt when the preamble or a file it reads changes). On by default |
| `ALDINE_THUMBNAILS`, `THUMBNAIL_TIMEOUT_MS` | Compiler container. After each successful typeset, page 1 is rendered with Ghostscript into a small image for the project list. `0` turns that off; the timeout (default 10000 ms) bounds one render, which runs after the typeset has answered. On by default |
| `ALDINE_PROJECT` | Compose project name for `backup.sh`/`restore.sh` (default `aldine`) |
| `ALDINE_BACKUP_DB` | `skip` = `deploy/backup.sh` writes a backup without the database when `DATABASE_URL` points outside the stack (back that database up with its own tools); unset, it refuses |
| `ALDINE_TEXLIVE_SCHEME` | Compiler image build (`docker-compose.full.yml`): `medium` (default; scheme-medium + pictures/latexextra/bibtexextra + publisher classes + Arabic/Cyrillic/Greek scripts, no CJK, about 5 GB on disk) or `full` (all of TeX Live, ~9 GB). Prebuilt images: set `ALDINE_TEXLIVE=-full` instead |
| `ALDINE_VERSION`, `ALDINE_TEXLIVE` | Prebuilt images (`docker-compose.yml`): the release to run (default: the current release, pinned in the file) and the compiler variant, empty (medium TeX Live plus the common collections) or `-full` (all of TeX Live, from 0.4.0). Single extra packages: a derived image with `RUN tlmgr install <pkg>`, see the root README, "Need a package it does not have?" |
| `ALDINE_TRASH_DAYS` | Days deleted projects stay restorable in the trash before the daily sweep purges them (default `30`) |
| `TEMPLATE_REPOS` / `TEMPLATE_REPOS_FILE` | Git repositories whose template folders join the gallery under their label: a JSON array of `{ id, label?, url, ref?, path?, tokenEnv?, user? }`, inline or in the file `TEMPLATE_REPOS_FILE` names. Read once at boot; a bad entry is logged and skipped. Checkouts live in `CACHE_DIR/template-repos/<id>`. Field reference in `templates/README.md` |
| *(per repository)* the variable `tokenEnv` names | Read token for a private template repository, e.g. `TEMPLATE_REPO_LAB_TOKEN`. Any name; injected per git operation, never written to the checkout's `.git/config` |
| `TEMPLATE_REPOS_REFRESH_MS` | How often template repositories are fetched again (default `600000` = 10 min; values below `60000` are raised to it). "Refresh templates" in the new-project dialog fetches on demand |
| `ALDINE_TEMPLATE_PREVIEWS` | App server. Each template from a template repository is typeset by the compiler once per version, after a sync that changed it, so the New project chooser shows its page 1 (kept in `CACHE_DIR/template-previews/<repo>`; a failed render is retried on a later sync). `0` turns that off and those templates show a title-page placeholder. Shipped templates are rendered before release and ship in the image; a folder in your own `TEMPLATES_DIR` shows the placeholder. On by default |
| `TEMPLATE_REPO_MAX_BYTES` | Size cap per template-repository checkout (default `52428800` = 50 MiB); an oversize checkout is deleted and reported as an error |

### Tests and internals

These exist for the test suites, for development and for tuning. They are
not covered by [docs/STABILITY.md](../docs/STABILITY.md) and may change or go
away in any release; none of them belongs in a production `.env`.

| Variable | Purpose |
|---|---|
| `ALDINE_RESET_ECHO` | `1` = echo reset tokens in the API response (dev only, never in prod). A reset completed this way does not confirm the account's address |
| `ALDINE_TEST_HOOKS`, `ALDINE_TEST_ALLOW_LOOPBACK_CIMD` | `1` = test-only routes, and http or loopback URLs for template repositories, venue kits and OAuth client metadata. Never set in production |
| `GITLAB_API_BASE` | Tests only: replaces `<instance>/api/v4` for every GitLab call and disables the https check on pasted instance URLs. Never set in production |
| `GITEA_API_BASE` | Tests only: replaces `<instance>/api/v1` for every Gitea/Forgejo call and lets a pasted instance URL be http. Never set in production |
| `GITHUB_API_BASE`, `ZOTERO_API_BASE`, `OPENALEX_API_BASE`, `DOI_API_BASE`, `ARXIV_API_BASE`, `ORCID_API_BASE`, `ORCID_PUB_API_BASE` | Tests only: point that client at a mock server |
| `ALDINE_AUTOCOMMIT_MS` | Quiet period after an edit before it is committed (default `20000`) |
| `ALDINE_AGENT_PRESENCE_TTL_MS` | How long Claude's presence in a document outlives its last write (default `60000`) |
| `REMOTE_STATUS_TTL_MS` | How long one fetch of a remote serves every editor's ahead/behind status (default `30000`) |
| `VENUE_KIT_TIMEOUT_MS` | Shortens the 20-second download limit for a venue kit |
| `TEMPLATES_DIR`, `VENUES_FILE`, `WEB_DIST`, `ALDINE_PDF_VIEWER_HTML` | Where the app finds the folder templates, the venue-kit registry, the built web app and the in-chat PDF viewer (the defaults point into the install) |
| `TEXLIVE_SCHEME_FILE` | Compiler: the file it reads its TeX Live scheme name from (the image writes it) |
