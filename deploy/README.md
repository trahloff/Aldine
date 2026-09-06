# Deploying Aldine on a single VPS

This is the recommended production setup: one dedicated-CPU box (e.g. a Hetzner
CCX, OVH, or any VPS with ≥8 GB RAM and 2+ dedicated vCPUs), Docker Compose for
the stack, and **your existing reverse proxy** (nginx, Traefik, …) — or the
bundled Caddy if you don't have one — for TLS. No managed platform required.
(Prefer AWS? There's a complete Terraform deployment — Fargate, EFS, ALB, SES —
in [`deploy/aws`](aws/).)

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

# GitHub sync (import repos as projects, push/pull) — a SEPARATE OAuth app with
# repo scope. Callback: <ALDINE_PUBLIC_URL>/api/github/oauth/callback
# (users can also connect with a Personal Access Token, no app needed).
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...

# AI error-fix (bring your own key; unset = feature off). If several are set,
# precedence is OPENROUTER > OPENAI > ANTHROPIC. Leave ALDINE_AI_MODEL unset to
# use the provider's default — if you do set it, use that provider's naming
# (e.g. "anthropic/claude-opus-4.8" for OpenRouter, "claude-opus-4-8" for
# direct Anthropic).
OPENROUTER_API_KEY=sk-or-...
#ANTHROPIC_API_KEY=
#OPENAI_API_KEY=
#ALDINE_AI_MODEL=

# password-reset email: SMTP (any provider) or AWS SES — set one transport.
# Without one, reset tokens are logged server-side (or echoed in the API
# response when ALDINE_RESET_ECHO=1 — dev only).
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

# error tracking (optional)
SENTRY_DSN=

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
Restore with `deploy/restore.sh <backup.tar.gz>` after `docker compose down`.
(If your compose project name isn't `aldine`, set `ALDINE_PROJECT` for both
scripts.)

Check that it took: `systemctl list-timers aldine-backup.timer` shows the next
run, and `systemctl start aldine-backup.service` forces one now. If you
installed these units before 0.4.0 they were named `papyr-backup.*`; disable
the old ones with `sudo systemctl disable --now papyr-backup.timer` and delete
them from `/etc/systemd/system/`, or you will run both.

## 5. Upgrade

```bash
cd /opt/aldine && git pull
docker compose -f docker-compose.full.yml -f deploy/docker-compose.prod.yml up -d --build
# (append --profile tls if you use the bundled Caddy, plus any other profiles you run)
```

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
  Users, sessions, project metadata, comments, and usage move to Postgres;
  git repos stay on disk. The same test suite passes on both backends.
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

Everything is env-gated; blank/unset means "off" or the listed default.

| Variable | Purpose |
|---|---|
| `ALDINE_DOMAIN` | Domain Caddy serves + provisions TLS for (`tls` profile) |
| `ALDINE_PUBLIC_URL` | The public URL of the instance — origin plus the path prefix when Aldine is served under one (`https://aldine.example.com` or `https://server/internal/aldine`). Used in OAuth callbacks, reset links, and by the MCP connector (OAuth issuer, PDF links, the in-chat viewer's fetch allowlist) — required for SSO, email and the connector |
| `ALDINE_MCP` | `1` = serve the MCP endpoint at `/mcp` for Claude (see [docs/AGENT_API.md](../docs/AGENT_API.md)). Needs a credential: `AUTH_ENABLED=1` (Connect button or personal access tokens) or `ALDINE_MCP_TOKEN`; with neither, every request is 401. `RL_MCP_BURST` tunes its rate limit (default 60) |
| `ALDINE_MCP_TOKEN` | Static bearer for `/mcp` when `AUTH_ENABLED` is off (single-tenant); ignored with auth on. Sent as `Authorization: Bearer …` or `X-Aldine-Token` |
| `ALDINE_SIGNING_SECRET` | Signs the connector's 15-minute PDF links; at least 32 characters (`openssl rand -base64 32`), shorter refuses to boot. Blank = generated once into `META_DIR`; set it when app nodes do not share that volume, rotate it to expire every outstanding link |
| `ALDINE_BASE_PATH` | URL prefix to serve under (`/internal/aldine`) when Aldine shares a host with other apps. Defaults to the path of `ALDINE_PUBLIC_URL`, else the root. The proxy passes the prefix through unchanged; `/api/health` also answers at the root for healthchecks. The Claude connector URL is `<ALDINE_PUBLIC_URL>/mcp`; OAuth discovery also lives at the origin root with the prefix inserted (`/.well-known/oauth-authorization-server<prefix>`, `/.well-known/oauth-protected-resource<prefix>/mcp`), so the proxy must forward those two paths to Aldine as well as the prefix itself |
| `ALDINE_APP_BIND` | Host interface for the app port (set `127.0.0.1` behind a proxy) |
| `AUTH_ENABLED` | `1` = multi-user login, ownership, sharing. Unset = single-tenant, no login |
| `ALDINE_SSO_ONLY` | `1` = disable password auth entirely (SSO only) |
| `GOOGLE_OAUTH_CLIENT_ID/SECRET` | Google SSO |
| `GITHUB_LOGIN_CLIENT_ID/SECRET` | GitHub SSO (login) |
| `ORCID_CLIENT_ID/SECRET`, `ORCID_SANDBOX` | ORCID SSO (login); `ORCID_SANDBOX=1` targets sandbox.orcid.org |
| `GITHUB_CLIENT_ID/SECRET` | GitHub **sync** OAuth app (repo import/push/pull) — separate from login |
| `SMTP_HOST/PORT/USER/PASS/FROM`, `SMTP_SECURE` | Password-reset email via SMTP |
| `SES_FROM` + `AWS_REGION` | Password-reset email via AWS SES (instead of SMTP) |
| `ALDINE_RESET_ECHO` | `1` = echo reset tokens in the API response (dev only, never in prod) |
| `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` / `OPENAI_API_KEY` | AI error-fix; precedence OpenRouter > OpenAI > Anthropic |
| `ALDINE_AI_MODEL`, `ALDINE_AI_BASE_URL` | Override AI model / OpenAI-compatible endpoint |
| `ALDINE_COMPILE_QUOTA_MIN` | Per-user compile minutes per month (blank = uncapped) |
| `DATABASE_URL` | Postgres datastore (blank = flat JSON files) |
| `PG_POOL_MAX` | Postgres pool size (default 10) |
| `REDIS_URL` | Shared rate limits + collab sync across app nodes |
| `SENTRY_DSN` | Error tracking |
| `TRUST_PROXY` | `1` = trust `X-Forwarded-For` (set by the prod overlay; needed behind any proxy) |
| `COOKIE_SECURE` | `1` = Secure session cookies (prod overlay sets it) |
| `RL_LOGIN_BURST`, `RL_REGISTER_BURST`, `RL_AI_BURST`, `RL_AI_REFILL_PER_MIN`, `RL_REF_BURST` | Rate-limit tuning (sane defaults) |
| `RL_COMPILE_CONCURRENCY` | Max concurrent compiles the app forwards (default 2) |
| `COMPILE_TIMEOUT_MS`, `MAX_CONCURRENT_COMPILES` | Compiler-container limits: per-compile timeout (default 120000 ms) and compiles in flight (default 2). `docker-compose.full.yml` passes both through from `.env` |
| `ALDINE_PROJECT` | Compose project name for `backup.sh`/`restore.sh` (default `aldine`) |
| `ALDINE_TEXLIVE_SCHEME` | Compiler image build (`docker-compose.full.yml`): `medium` (default; curated set + publisher classes + Arabic/Cyrillic/Greek scripts, no CJK, ~3.7 GB on disk) or `full` (all of TeX Live, ~9 GB). Prebuilt images: set `ALDINE_TEXLIVE=-full` instead |
| `ALDINE_VERSION`, `ALDINE_TEXLIVE` | Prebuilt images (`docker-compose.yml`): the release to run (default: the current release, pinned in the file) and the compiler variant, empty (curated TeX Live) or `-full` (all of TeX Live, from 0.4.0) |
| `ALDINE_TRASH_DAYS` | Days deleted projects stay restorable in the trash before the daily sweep purges them (default `30`) |
