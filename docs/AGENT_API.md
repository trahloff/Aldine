# Agent API: Claude as a collaborator in your Aldine

The Aldine Agent API serves the [Model Context Protocol](https://modelcontextprotocol.io)
at `/mcp`. Add your instance as a connector in claude.ai, Claude Desktop, Cowork
or Claude Code and Claude reads and edits the LaTeX in your projects, typesets
them, gets the errors back with file and line, and shows the PDF inside the
chat. Every edit lands as a git commit authored "Claude", so the session is one
diff to review and one click to revert.

The endpoint is off by default. This page is the setup guide for the person
who runs the instance.

## Enable it

| Variable | What it does |
|---|---|
| `ALDINE_MCP=1` | Serves `POST /mcp`. Unset: the route does not exist and the MCP SDK is never loaded. |
| `ALDINE_PUBLIC_URL` | The public URL of the instance — origin plus the path prefix when Aldine is served under one (`https://aldine.example.com` or `https://server/internal/aldine`). The Connect flow names it as the OAuth issuer, the PDF links Claude hands out are absolute against it, and the in-chat PDF viewer is allowed to fetch from exactly that origin. Set it for anything beyond a local experiment; behind a proxy it is the only trustworthy value. |
| `ALDINE_SIGNING_SECRET` | Optional. Signs the 15-minute PDF links. Unset, a random secret is generated once into `META_DIR/output-signing-secret` (mode 0600) and reused across restarts. Set it (at least 32 characters, `openssl rand -base64 32`; shorter values refuse to boot) when several app nodes do not share `META_DIR`, or to invalidate every outstanding link at once by rotating it. |

Then choose how Claude authenticates. There is exactly one credential path
per deployment mode, and neither can be left empty:

- **`AUTH_ENABLED=1` (multi-user).** Claude connects with the **Connect**
  button (OAuth 2.1: Aldine is its own authorization server). No token is
  copied anywhere; the signed-in user picks which projects Claude may touch on
  a consent page. For scripts and clients without a Connect button, each user
  can mint a personal access token under **your name → Account → Agent
  access → Access tokens for scripts** (name, optional project scope,
  optional expiry; shown once). Tokens start with `aldn_` and go in
  `Authorization: Bearer …` or in an `X-Aldine-Token` header. The card also
  says when the connector is off on this server, and when its address is one
  claude.ai cannot reach (plain http, localhost, a private network) — Claude
  Code still can.
- **Auth off (single-tenant).** Set `ALDINE_MCP_TOKEN` to a long random
  string and send it the same way (`Authorization: Bearer <token>` or
  `X-Aldine-Token: <token>`). Calls run as the instance operator and reach
  every project. The Connect button cannot work here: with auth off there is
  no account to consent as, so the OAuth routes and discovery documents are
  404.

`ALDINE_MCP=1` with neither `AUTH_ENABLED` nor `ALDINE_MCP_TOKEN` answers 401
to everything and prints a setup hint at boot. In `docker-compose.full.yml`
the three variables pass through from `.env`; the minimal
`docker-compose.yml` has no `environment:` block, so add one (or switch to the
full file) before enabling.

## Check it

Two requests from any machine tell you the endpoint is up and reachable the
way Claude will reach it, before you open a connector dialog:

```bash
curl -si -X POST https://<host>/mcp -H 'content-type: application/json' -d '{}'
```

expects `HTTP/1.1 401` with the body `{"error":"A valid access token is required"}`.
With auth on the response also carries
`WWW-Authenticate: Bearer resource_metadata="https://<host>/.well-known/oauth-protected-resource/mcp", scope="…"`;
with auth off there is no such header. A 404, or HTML, means `ALDINE_MCP` is
unset, the path is wrong, or the proxy does not forward `/mcp`.

```bash
curl -s https://<host>/.well-known/oauth-protected-resource/mcp
```

expects (auth on) a JSON document whose `authorization_servers` entry is
exactly `ALDINE_PUBLIC_URL`; anything else there is what Claude will be sent
to and will fail against. With auth off this is a JSON 404, which is right —
skip the Connect button and use the static-token path below.

## Connect from claude.ai

1. In Claude: **Settings → Connectors → Add custom connector**. Name it,
   paste the connector URL `https://<host>/mcp` (with auth on, the Agent
   access card in Aldine shows and copies it; with auth off there is no
   card — the URL is `ALDINE_PUBLIC_URL` plus `/mcp`, and the boot log
   prints it as "MCP connector at …"), leave authentication at its default.
2. Click **Connect**. Aldine opens `/oauth/authorize`; sign in if you are not
   (the sign-in form appears in place, SSO included, and comes back to the
   consent page).
3. The consent card names the client and its host and asks for the scope:
   **All projects, now and later** or **Only these projects** with a
   checklist. **Allow** finishes the connection; **Deny** leaves nothing
   behind.

That is the whole setup. The connection appears on the Agent access card with
the client's name, its project scope and a "via Connect" badge; **Revoke**
there ends it (and its refresh token) at the next call. Under the hood the
access token rotates daily and the connection renews itself for up to 30
days while in use — the card shows the connection's creation and last use,
not the rotations; you only see the consent page again after a revoke or a
reconnect. Writes prompt for approval in Claude unless you allow
the tool; the read-only tools are marked as such so Claude can allow them
without asking.

### With a static token (auth off)

Without `AUTH_ENABLED` there is no Connect flow, but claude.ai's connector
dialog can send a fixed header with every call. In **Add custom connector**,
open the advanced settings (the additional request headers) and add
`X-Aldine-Token: <ALDINE_MCP_TOKEN>`; leave the OAuth fields empty and save
without clicking Connect. claude.ai keeps `Authorization` for its own OAuth
bearer, which is why the header has its own name. This path skips the consent
page: the calls run as the instance operator and reach every project. The
same header works on an `AUTH_ENABLED` instance with an `aldn_` token, for a
client without a Connect button.

## Connect from Claude Code

```bash
claude mcp add --transport http aldine https://<host>/mcp
claude mcp login aldine        # or type /mcp in a session and pick Aldine
```

The consent page carries a warning that the client redirects only to your own
computer (Claude Code's OAuth client is loopback-only); that is expected when
you started the login yourself. With a static token instead of Connect:

```bash
claude mcp add --transport http aldine https://<host>/mcp \
  --header "X-Aldine-Token: <aldn_… or ALDINE_MCP_TOKEN>"
```

### Private instances

Claude Code runs on your machine, so an Aldine on `localhost` or your LAN is
reachable from it over plain HTTP; the commands above work unchanged with
`http://localhost:8080/mcp`. The PDF link in the text result then opens in
your browser; the inline viewer needs `ALDINE_PUBLIC_URL` to name an origin
the viewer's sandbox can reach.

For an instance whose server is not running, or a checkout you operate by
hand, the same tools speak stdio. From the repository root, after
`npm install`:

```bash
claude mcp add --transport stdio aldine \
  --env DATA_DIR=/path/to/.data --env META_DIR=/path/to/.secrets \
  --env COMPILER_URL=http://localhost:4020 --env ALDINE_PUBLIC_URL=http://localhost:3000 \
  -- npx tsx apps/server/src/mcp/stdio.ts
```

Inside the published image the compiled file is `dist/mcp/stdio.js` in the
container's working directory (`docker compose exec -T app node
dist/mcp/stdio.js`). Notes on the stdio transport:

- It does not need `ALDINE_MCP=1`; it is a separate process that opens the
  data directory itself, so `DATA_DIR`, `META_DIR` and `COMPILER_URL` must be
  the same values the server uses.
- It runs as the local operator. When `ALDINE_MCP_TOKEN` is set the launcher
  must still present it (`--token <t>` after the script path, or
  `ALDINE_MCP_CLIENT_TOKEN` in the environment), so a wrapper cannot bypass a
  configured secret. On an `AUTH_ENABLED` instance the operator has no
  account, and only projects without an owner are visible to it; use the HTTP
  transport with a token there.
- Without `ALDINE_PUBLIC_URL` the PDF and deep links are root-relative and the
  inline viewer is not offered; the text result still carries the links.

## Claude Desktop and Cowork

Both use the same custom connectors as claude.ai (Settings → Connectors), so
the claude.ai steps apply; the PDF viewer renders in both. Like claude.ai,
they call your server from Anthropic's cloud, not from the desktop machine,
so a private instance is not reachable this way even though the app runs
next to it. Claude Desktop can also launch a local stdio server from its own
configuration file, using the command from the previous section.

## What the tools do

| Tool | What it does | Read-only |
|---|---|---|
| `ping` | Confirms the connector is reachable and who the token belongs to. | yes |
| `list_projects` | Projects the credential can reach, with branches, root file and engine. | yes |
| `project_structure` | File tree of a branch plus the content version used for conflict-safe writes (checked per file). | yes |
| `read_file` | A text file as the editor shows it now (open documents are flushed first), windowable by line. | yes |
| `edit_file` | Replaces exact quoted text (`path`, `edits[]` of `{quote, replacement, occurrence?}`, `base_version?`, `message?`); merges with live typing as a CRDT edit. A drifted quote applies nothing and returns candidate lines. | no |
| `write_file` | Creates or replaces a whole file (`path`, `content`, `base_version?`, `message?`); refuses with `version_conflict` when that file changed after the given base version (a change to another file does not conflict). | no |
| `batch_write` | A multi-file change (`files[]` of `{path, content \| edits, base_version?}`, `message`) as one named commit; all-or-nothing. | no |
| `compile` | Typesets with latexmk: errors before warnings (file, line, message — every row names a file), a short log tail on failure, page count, a signed PDF link, a deep link into the editor; a missing package is reported as a `hint` to relay. | no |
| `get_pdf_url` | A fresh signed link to the last typeset PDF without recompiling. | yes |
| `commit` | Commits everything pending on the branch under Claude's name (`message`), for a named checkpoint — including a collaborator's unsaved typing, so Claude is told to prefer `batch_write`. | no |
| `references_add` | Resolves a DOI, arXiv or OpenAlex id (`query`) to BibTeX and appends it to the project's `.bib` (`bibFile?`). | no |
| `list_citations` | Citation keys in the project's `.bib` files, with title, author, year. | yes |
| `list_labels` | `\label` targets across the project's `.tex` files. | yes |
| `wordcount` | Words in the root file and its `\input`/`\include` graph. | yes |
| `create_project` | A new project, blank or from a template; refused for a project-scoped credential. | no |

Every tool takes `project` (optional for a single-project token) and
`branch` (default `main`); the exact argument names live in the tool schema,
which Claude reads — `e2e/tests/15-mcp.spec.ts` is the reference for a script
author. Every tool goes through the same access, protected-project, trash
and hidden-path checks as the REST API; a project-scoped token is refused
outside its scope, `list_projects` included. No tool deletes, shares, pushes
to GitHub or manages tokens.

## How attribution and review work

- **Commits.** Each write tool commits as author "Claude". `batch_write`
  and `commit` carry the stated intent as the message; `edit_file` and
  `write_file` take an optional `message` and are otherwise titled by file
  ("Edit main.tex", "Update notes.tex"). Intents are kept per file, so a
  commit's title always names what it holds. Before a write, whatever a
  person had typed into that file and not yet committed is checkpointed
  separately, so a Claude commit's diff is Claude's change plus anything
  typed into that same file in the ~20 seconds before the commit lands (the
  autosave debounce; the review dialog says so before a revert). The History
  panel marks these commits with a violet dot and refreshes while Claude is
  present. A graceful stop commits pending Claude work under its name before
  exiting — the server on SIGTERM (a deploy), the stdio process when Claude
  Code ends the session (stdin closes, or SIGTERM); only a hard kill inside
  that ~20-second window loses the attribution — the edit itself survives on
  disk and the next autosave commits it as an anonymous autosave.
- **The `commit` tool commits the whole tree.** A collaborator's unsaved
  typing in any file lands under Claude's name; Claude is told to prefer
  `batch_write`, which commits only the paths it wrote. Decide whether to
  allow `commit` without prompting with that in mind.
- **Human authors.** With `AUTH_ENABLED`, a person's checkpoints, merges and
  reverts are committed under their account name (the server ignores the
  name the browser sends); the anonymous "Writer N" identity applies only
  without accounts. Autosaves carry no author.
- **Presence.** While Claude edits a document that is open in someone's
  editor, it appears in the presence strip as a violet spark glyph (never an
  initial; the violet is reserved for agents) and leaves about a minute after
  its last call. With the experimental flag
  `aldine.experimental.agentPresence` (command palette: "Enable experimental
  agent edit highlights"), incoming agent edits get a violet tint that fades
  over a few seconds.
- **Review.** When a session that produced commits goes quiet, the editor
  shows a sticky toast, "Claude edited N files", with a **Review** action
  that opens the diff of the session's commits and a **Revert these changes**
  button. Revert creates one new commit that undoes them; history is never
  rewritten.

## The PDF in the chat

`compile` and `get_pdf_url` return `pdfUrl`: a link to that run's PDF that
works without a session for 15 minutes. It is an HMAC-signed URL for one
artifact on one branch (`GET /api/projects/<id>/output` only), served
`no-store`; nothing else on the server accepts the signature, and a bad or
expired one is refused even in a signed-in browser. Anyone holding the link
can read that PDF until it expires; rotating `ALDINE_SIGNING_SECRET` kills
every outstanding link.

Hosts that support MCP Apps (claude.ai, Claude Desktop, Cowork) render the
result with Aldine's viewer, `ui://aldine/pdf-viewer`: page well, error rows
that deep-link to the failing line, and "Open in Aldine". The viewer's sandbox
may only fetch from the origin in `ALDINE_PUBLIC_URL`; a wrong value fails
closed (a fetch error on the card), never open. Other hosts get the link in
the text result. The viewer is one built file,
`apps/server/assets/pdf-viewer.html`; the published image contains it, a
source checkout builds it with `npm run build:viewer -w apps/server` (part of
`npm run build`). PDFs over 50 MB are linked, not rendered inline.

## Reachability

claude.ai, Claude Desktop, Cowork and the mobile apps call your server from
Anthropic's cloud. Your instance must accept HTTPS from the public internet
at `https://<host>/mcp`, plus `/oauth/*` and `/.well-known/*` for Connect; a
server behind a VPN, on a private network or on `localhost` will not connect,
whichever app you use. Anthropic publishes the outbound range these calls
come from (`160.79.104.0/21` at the time of writing; see
[platform.claude.com/docs/en/api/ip-addresses](https://platform.claude.com/docs/en/api/ip-addresses)).

If you do not want to expose the instance:

- **Claude Code** runs on your machine and reaches a private instance over
  HTTP or stdio (above). The tools, attribution and review are identical;
  only the inline viewer needs a public origin.
- **A tunnel** publishes one hostname without opening the box. Point it at
  the app port and set `ALDINE_PUBLIC_URL` to the hostname the tunnel gives
  you (the OAuth issuer and the viewer's allowlist depend on it):
  `cloudflared tunnel --url http://localhost:8080` (a named tunnel keeps a
  stable hostname; a quick tunnel changes it every start) or
  `tailscale funnel 8080` (your tailnet's `*.ts.net` name; Funnel must be
  enabled for the node). Both terminate TLS for you.
- **IP allowlisting** if you expose it anyway: restrict `/mcp`,
  `/oauth/token`, `/oauth/register` and `/.well-known/` to Anthropic's
  outbound range and your own addresses. Do not restrict `/oauth/authorize`,
  `/api/oauth/*` or the PDF route: the consent page runs in the user's
  browser, and the viewer fetches the PDF from the browser's sandbox, not
  from Anthropic.

## Security

- **No authless mode.** LaTeX projects carry pasted web content, reviewer
  comments and downloaded `.bib` entries, all of which reach the model, so
  the server never relies on the model to decline. An unauthenticated `/mcp`
  would be a public write path into every project; the configuration is made
  unrepresentable instead of discouraged.
- **What a credential can do.** Read, edit, create files, typeset, commit and
  add references in the projects it reaches; create projects if unscoped.
  Protected (showcase) projects stay read-only. Agent typesets take at most
  one of the account's two concurrent slots, so the person always keeps one,
  and count against the account's monthly quota.
- **What it cannot do.** Delete or trash a project, change sharing, push to
  GitHub, or create, list or revoke tokens; those routes accept browser
  sessions only, so a leaked token cannot escalate to a session or mint
  another token.
- **At rest and in transit.** Tokens are stored as SHA-256 digests. `/mcp`
  checks the credential before parsing any JSON-RPC, caps bodies at 2 MB and
  is rate limited per client IP and per token (60 burst, 1/s sustained;
  `RL_MCP_BURST` tunes it).
- **Revocation.** The Agent access card lists every token and Connect session
  with its last use; Revoke takes effect on the next request and, for a
  Connect session, also ends its refresh tokens. A reused refresh token
  revokes the whole family.
- **Rollback.** Every write is a commit; any change is one revert away.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `401 A valid access token is required` | Auth on: the token is revoked, expired or mistyped; reconnect, or mint a new one. Auth off: `ALDINE_MCP_TOKEN` is unset or does not match; the boot log says which. |
| Connect fails; `/.well-known/oauth-protected-resource/mcp` is 404 | `AUTH_ENABLED` is off, so there is no authorization server. Send `ALDINE_MCP_TOKEN` in the `X-Aldine-Token` header instead ("With a static token" above), or turn auth on. |
| Connect probe gets HTML | The connector URL lacks `/mcp`. |
| Instance under a path prefix | The connector URL carries it (`https://host/prefix/mcp`) and `ALDINE_PUBLIC_URL` includes it. The discovery documents sit at the origin root with the prefix inserted after the well-known segment (`/.well-known/oauth-authorization-server/prefix`, `/.well-known/oauth-protected-resource/prefix/mcp`), so the proxy must forward those two paths to Aldine as well as the prefix itself (`deploy/nginx.conf` shows it). |
| The card says the PDF viewer is not built | `apps/server/assets/pdf-viewer.html` is missing: run `npm run build:viewer -w apps/server`. The tools keep returning the link meanwhile. |
| The card shows a fetch error but the link opens in a tab | `ALDINE_PUBLIC_URL` is not the origin the browser reaches (the viewer may only fetch from that origin). |
| Link expired | Signed links last 15 minutes; ask Claude for the PDF again and it calls `get_pdf_url`. |
| `429 Too many requests` | The per-IP or per-token bucket is empty; slow the loop, or raise `RL_MCP_BURST`. |
| `GET /mcp` answers 401 (or 405 with a valid token) | Expected: the endpoint is POST-only and checks the credential first. |
| `compile` says the compiler cannot see the project | The compiler's `DATA_DIR` is not the server's (a compiler started by hand on the default `.data`, or a compose volume mismatch): the files exist but the compiler looks elsewhere. Point `COMPILER_URL` at a compiler sharing the server's `DATA_DIR`. Claude is told to relay this, not to recreate files. |
| `compile` returns a `hint` about a missing package | The compiler's TeX Live lacks that `.sty` (BasicTeX, for one, has no biblatex). Install it or use the docker compiler image; the document is fine. |
| "An agent typeset is already running" | One agent compile per account at a time; wait for it. |
