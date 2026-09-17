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
  can mint a personal access token under **your name (opens Account) →
  Agent access → Access tokens for scripts** (name, optional project scope,
  optional expiry; shown once). Tokens start with `aldn_` and go in
  `Authorization: Bearer …` or in an `X-Aldine-Token` header. The card also
  says when the connector is off on this server, and when its address is one
  claude.ai cannot reach (plain http, localhost, a private network) — Claude
  Code still can, and the card then shows the `claude mcp add` command with
  a copy button.
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

### The shortest local setup

A fresh clone, Docker, auth off, Claude Code on the same machine. Put a
`.env` next to the compose files (compose reads it on every call) with three
lines and nothing else:

```dotenv
ALDINE_MCP=1
ALDINE_MCP_TOKEN=<openssl rand -hex 32>
# the origin you will type into the connector; the PDF links are absolute against it
ALDINE_PUBLIC_URL=http://localhost:8080
# ALDINE_PORT=8081   # only if 8080 is taken; then use 8081 in ALDINE_PUBLIC_URL and in every URL below
```

then `docker compose -f docker-compose.full.yml up -d --build`. The first
build installs TeX Live into the compiler image and takes 20–60 minutes
(the `tlmgr install` step is most of it; the app image takes about ten minutes);
every later start takes seconds. The instance is ready when
`curl localhost:8080/api/health` answers `{"ok":true,"name":"aldine"}`, and
`docker compose -f docker-compose.full.yml logs app | grep 'MCP connector'`
prints the connector URL and which credential it takes:

```
[aldine] MCP connector at http://localhost:8080/mcp — credentials: static token (ALDINE_MCP_TOKEN); PDF viewer: built
```

Continue with "Check it" (the two `curl`s, against `http://localhost:8080`)
and "Connect from Claude Code" below; the whole loop from `claude mcp add`
to a typeset PDF fits in a minute once the containers are up. Compose
interpolates `${VAR:-}` from your shell before it reads `.env`, so a variable
exported in the shell (a developer's `SENTRY_DSN`, say) reaches the
container even when `.env` does not mention it.

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

That is the whole setup. The connection appears under **Connections** on the
Agent access card with the client's name, its project scope and a "via
Connect" badge; **Revoke**
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

### Try it on the demo

The public demo at [demo.aldine.dev](https://demo.aldine.dev) runs the Agent
API with auth off and a token that is public on purpose, so you can watch the
loop before you set up anything of your own:

| Setting | Value |
|---|---|
| Connector URL | `https://demo.aldine.dev/mcp` |
| Header | `X-Aldine-Token: aldine-demo` |

Publishing the token exposes nothing new: the demo is already writable by
anyone with a browser and holds nothing. The no-authless rule under
[Security](#security) is about instances that hold real work, and it still
applies to the demo box — the token is required, it is merely known.

In claude.ai (Claude Desktop and Cowork alike) follow
["With a static token"](#with-a-static-token-auth-off) above: add the custom
connector with that URL, put the header in the additional request headers,
and save without clicking Connect — the demo has no accounts, so there is
nothing for Connect to sign you in to. In Claude Code:

```bash
claude mcp add --transport http aldine-demo https://demo.aldine.dev/mcp \
  --header "X-Aldine-Token: aldine-demo"
```

Then ask Claude to list the projects, create one and typeset it. The PDF
renders inside the chat because the demo's origin is public
(`ALDINE_PUBLIC_URL=https://demo.aldine.dev`), which is the one thing a
private instance cannot show you.

What a shared sandbox means:

- **Every project is world-writable, bar the showcase paper.** The token has
  no scope, so it reaches every project on the box, and so does everyone
  else's; the one exception is a showcase paper the operator has marked
  read-only, where Claude is told "That project is read-only". Put nothing
  there you would mind losing or having read.
- **It is wiped nightly at 04:00 UTC.** Projects, files, git history and the
  secret behind the PDF links all go; the token stays. A project that
  vanished overnight was not deleted by anyone.
- **Typesets are capped per address.** Every visitor gets 6 typesets per
  minute (`ALDINE_COMPILE_PER_MIN=6`) and one running agent typeset at a
  time, keyed by client address whether the call comes from a browser or
  through the connector, so one busy chat cannot spend everyone's budget.
  "Typeset budget reached for this minute — try again shortly" and "An agent
  typeset is already running for this account — wait for it to finish" mean
  your own budget is used up, not that your setup is wrong. The per-token
  half of the `/mcp` rate limit (60 burst, 1/s) is shared, since everyone
  presents the same token; the per-address half is not.

The checks from ["Check it"](#check-it) apply unchanged: the unauthenticated
`POST https://demo.aldine.dev/mcp` answers `401` with
`{"error":"A valid access token is required"}` and no `WWW-Authenticate`
header, and the discovery document is a JSON 404 — both right for auth off.
With the token, a `ping` proves the whole path from any machine:

```bash
curl -s -X POST https://demo.aldine.dev/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H 'X-Aldine-Token: aldine-demo' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ping","arguments":{}}}'
```

expects a `data:` line whose result text is
`{"ok":true,"server":"aldine","user":null}` (`user` is null because a static
token belongs to no account). Without the `accept` header the same request
is a `406` naming the two media types, not a `401`: the token was accepted.

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

`--header "Authorization: Bearer <token>"` works the same for Claude Code;
`X-Aldine-Token` is the form that also works in claude.ai's connector
dialog, which reserves `Authorization` for its own OAuth bearer. Either way,
`claude mcp get aldine` should say **Connected** (it reports "ConnectionRefused"
while the instance is still starting), and the first thing to ask Claude for
is `ping` or the project list — the write tools take project *ids*, which
`list_projects` returns, and on a new instance that list is empty until
`create_project` makes one.

### Claude Code plugin

The repository is also a plugin marketplace. The plugin configures the same
connector and adds three skills — `latex-fix-build` (the compile, read,
edit, recompile loop with a three-attempt limit), `latex-draft-section` (a
section in its own file, wired in as one commit) and `latex-bibliography`
(`references_add`, duplicate check, biber vs bibtex):

```bash
export ALDINE_URL=https://<host>          # no trailing slash; the instance runs ALDINE_MCP=1
export ALDINE_TOKEN=<credential>          # optional: ALDINE_MCP_TOKEN (auth off) or an aldn_ PAT when you cannot use Connect; unset to sign in via /mcp
```

```
/plugin marketplace add trahloff/Aldine
/plugin install aldine@aldine
```

With `ALDINE_TOKEN` unset the server sees no credential and answers with the
OAuth challenge, so `/mcp` → **aldine** runs the Connect flow as above. From
a checkout, `claude --plugin-dir ./claude-plugin/aldine` loads the plugin for
one session; `claude-plugin/aldine/README.md` has the per-skill usage and
troubleshooting.

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
| `project_structure` | File tree of a branch (`binary` is by extension; `read_file` decides text by content) plus `contentVersion` for conflict-safe writes (Versions and conflicts, below). | yes |
| `read_file` | A text file as the editor shows it now (open documents are flushed first), windowable by line (`from_line`/`to_line`, echoed back; a window past the end or running backwards is an error). Text is decided by content, not extension. Returns `contentVersion` and `fileVersion`. | yes |
| `edit_file` | Replaces exact quoted text (`path`, `edits[]` of `{quote, replacement, occurrence?}`, `base_version?`, `message?`); merges with live typing as a CRDT edit. A drifted quote applies nothing and returns candidate lines (`stale_anchor`); a quote that matches several places returns them with the `occurrence` that picks each (`ambiguous_anchor`). | no |
| `write_file` | Creates or replaces a whole file (`path`, `content`, `base_version?`, `message?`); refuses with `version_conflict` when that file changed after the given base version (a change to another file does not conflict). Folders come into being with the first file written inside them; the first `.tex` written into a project with no main document becomes it (`newRoot`). | no |
| `batch_write` | A multi-file change (`files[]` of `{path, content \| edits, base_version?}`, `message`) as one named commit; all-or-nothing. An `edits` entry on a document someone has open lands per span like `edit_file`; only a `content` entry replaces the file. | no |
| `compile` | Typesets with latexmk: errors before warnings (file, line, message, the source line as `context`, the tool behind a warning as `source`; every engine row names a file, a biber row names the `.bib` and its line; `errorsTotal` and `warningsTotal` count them), on failure 4 KB of the log around the first error, page count, a signed PDF link, a deep link into the editor; a missing package or a character pdflatex cannot typeset is reported as a `hint`. A project with no `.tex` file is told so. | no |
| `get_pdf_url` | A fresh signed link to the last typeset PDF without recompiling, whoever typeset it; it does not contain edits made since, so Claude is told to `compile` when it has written since its last run. | yes |
| `commit` | Commits any agent work still waiting on the branch (a write whose own commit git refused), as one named commit (`message`) under Claude's name; everything else pending stays for the anonymous autosave. Every write commits on its own as it lands, so the normal answer is `committed:false` with the current head and Claude's latest commits on the branch (`recentClaudeCommits`), not an error. | no |
| `references_add` | Resolves a DOI, arXiv or OpenAlex id (`query`) to BibTeX — one key rule (`surname2021`) and layout whatever the upstream, made typesettable under pdflatex and biber — and appends it to the project's `.bib` (`bibFile?`, created with its folders when missing — `created:true`); a `note` says when no `.tex` on the branch loads that file. An id the upstream does not know is "No reference found"; only a 5xx is a lookup failure. | no |
| `list_citations` | Citation keys in the project's `.bib` files, with title, author, year. | yes |
| `list_labels` | `\label` targets across the project's `.tex` files. | yes |
| `wordcount` | Words in the root file and its `\input`/`\include` graph; an error, not 0, while the project has no main document. | yes |
| `trash_project` | Moves a project to the workspace trash, where its owner restores it for `ALDINE_TRASH_DAYS` (30 by default); the tool never purges. Accepts only projects made with `create_project` (`agentCreated:true` in `list_projects`) and only for their owner — a person's project is refused and Claude is told to ask them to delete it in Aldine. Its description tells Claude to use it only when asked. | no |
| `create_project` | A new project, blank or from a template — a folder template (`article`, `beamer`, `report`, `iac-paper`) or a venue kit (`venue:<id>`, the publisher's class files downloaded on first use; an unknown id is refused with the full list). Returns the id, the seeded `files` and `contentVersion` for the first write. Refused for a project-scoped credential. | no |

Every tool that works inside a project takes `project` (optional for a
single-project token) and `branch` (default `main`) — `ping`, `list_projects`
and `create_project` take neither. Every structured result — the error
bodies `version_conflict`, `stale_anchor` and `ambiguous_anchor` included —
echoes `branch` and `head` (after a write, the commit that write made), and
a file tool's result names its `path`; a plain refusal is one sentence of text. The exact argument names live in the
tool schema, which Claude reads; for a script author the schema is the
contract; `e2e/tests/15-mcp.spec.ts` shows the transport (the MCP SDK's
`StreamableHTTPClientTransport` with the token in `requestInit.headers`)
and `apps/server/test/mcp.test.mjs` the `listTools()` call that reads the
schemas. A first session that touches every
step is `ping` → `list_projects` → `create_project` → `read_file` →
`edit_file` (a `quote` is at least 8 characters and must match one place;
pass the read's `contentVersion` as `base_version`) → `compile` →
`get_pdf_url` → `commit`, which on a clean run reports `committed:false`
because each write already committed itself. Every tool goes
through the same access, protected-project, trash and hidden-path checks as
the REST API; a project-scoped token is refused outside its scope and
`list_projects` shows only the scope. No tool purges, shares, pushes to a
git remote or manages tokens; the one trash tool reaches only what the
agent created, and only as far as the workspace trash.

### Versions and conflicts

Writes are guarded by three numbers, all per branch and all issued by the
server process that answers:

- `contentVersion` — the branch's change counter. It goes up whenever any
  file on the branch changes on disk (a keystroke that lands, a write tool,
  a git rewrite). `project_structure`, `read_file`, `create_project` and
  every write return it.
- `fileVersion` — the `contentVersion` at which *this* file last changed.
  `read_file` and the write results return it for the file they touched.
- `base_version` — what a write passes back: optional on `edit_file` and
  `write_file`, per entry on `batch_write`. Send the `contentVersion` (or
  `fileVersion`) from the read of that file, or `contentVersion` from
  `project_structure` or `create_project` for a file that does not exist
  yet. Omitted, the write is not checked and lands over whatever is there.

A write is accepted when `fileVersion ≤ base_version ≤ contentVersion`: the
file has not changed since the version the caller saw, and that version came
from this server. It is refused, with nothing written, as
`{error:"version_conflict", reason, currentVersion, fileVersion}` when

- the file changed after `base_version` (a change to another file on the
  branch does not count, so two tools editing two files in parallel never
  conflict), or
- `base_version` is newer than the branch's `contentVersion` — it was issued
  by another server process (a restart, or another node behind the load
  balancer), so the server cannot tell what it saw.

`reason` says which. The fix is the same for both: re-read the file and use
the `contentVersion` that read returns. A git-level rewrite of the branch
(revert, merge, pull, reset) counts as a change to every file. In
`batch_write` a conflict on any entry refuses the whole batch.

Quote-anchored edits have two errors of their own, also with nothing applied:
`stale_anchor` (the quote is not in the file; `candidates` show the region
around the nearest match — re-read, re-anchor, retry) and `ambiguous_anchor`
(the quote matches several places; each candidate carries the `occurrence`
that picks it — resend with it, no re-read needed). Error results carry the
same `path`, `branch`, `head` and `contentVersion` as a success.

## How attribution and review work

- **Commits.** Each write tool commits as author "Claude" before it answers,
  and the result names the commit. `batch_write` and `commit` carry the
  stated intent as the message; `edit_file` and `write_file` take an
  optional `message` and are otherwise titled by file ("Edit main.tex",
  "Update notes.tex"); `references_add` is titled "Add reference <key>".
  Every call is one commit, so a
  commit's title always names what it holds. Before a write, whatever a
  person had typed into that file and not yet committed is checkpointed
  separately, and the commit is built from the text the tool held while it
  applied the edit — not from the working tree — so a Claude commit's diff
  is exactly Claude's change: typing that lands before, between or during
  agent edits reaches history as the person's own autosave, and reverting
  Claude's commits never removes it. The History panel marks these commits
  with a violet dot and shows them as they land. A write that leaves the
  file as HEAD has it makes no commit: the result says `commit: null` with
  `unchanged: true`, and nothing is pending. Should git refuse a commit,
  the result says so (`commit: null` without `unchanged`), the write stays registered under
  Claude's name and the next autosave (or a graceful stop — the server on
  SIGTERM, the stdio process when Claude Code ends the session) commits it;
  only a hard kill in between loses the attribution, and the edit itself
  survives on disk.
- **The `commit` tool is scoped to Claude's own work.** It commits whatever
  agent work is still waiting on that branch, as one commit titled with the
  message it was given — the caller is naming the checkpoint, so the
  per-file intents those writes registered are replaced. A collaborator's
  unsaved typing, and anything a person changed over REST, stays pending and
  reaches history as an ordinary anonymous autosave. Since every write
  commits itself, the usual answer is `committed:false` with the current head
  and the latest Claude commits on the branch (`recentClaudeCommits`), so
  Claude can name the commit that holds its edits. Claude is still steered to
  `batch_write` when the change is one it is making right now.
- **Human authors.** With `AUTH_ENABLED`, a person's checkpoints, merges and
  reverts are committed under their account name (the server ignores the
  name the browser sends), and collaborators and comment threads see that
  name too, with one colour in every browser; the anonymous "Writer N"
  identity applies only without accounts. Autosaves carry no author.
- **Presence.** While Claude edits a document that is open in someone's
  editor, it appears in the presence strip as a violet spark glyph (never an
  initial; the violet is reserved for agents) and leaves about a minute after
  its last call. The session is kept on the server, so reloading the page
  mid-session shows it again with its original start time, and the away
  prompt below waits for it to end. With the experimental flag
  `aldine.experimental.agentPresence` (command palette: "Enable experimental
  agent edit highlights"), incoming agent edits — the first one included —
  get a violet tint that fades over a few seconds.
- **The preview follows Claude.** With auto-typeset on, an agent write arms
  the same debounce a keystroke arms, so an open editor typesets without
  anyone touching the keyboard. Only one tab per branch runs it (the others
  adopt its result), and a typeset Claude issues itself within a few seconds
  cancels the pending one — the status line reads "Typesetting Claude's
  edits…" and every open preview ends up showing that run, its errors and
  its jump-to-source included. With auto-typeset off nothing is armed, no
  status line appears and Claude's run is not adopted: the preview moves
  only when the person presses Typeset. A branch no agent touches behaves
  exactly as before.
- **Review.** When a session that produced commits goes quiet, the editor
  shows a sticky toast, "Claude edited N files", with a **Review** action
  that opens the diff of the session's commits and a **Revert these changes**
  button. Revert creates one new commit that undoes them; history is never
  rewritten. With auto-typeset on the preview re-typesets after the revert,
  with it off the preview is marked stale. When a person's later edit
  overlaps one of the commits the revert stops with nothing committed and
  names the commit it stopped on; undo the overlap by hand (History shows
  both diffs) and revert again. The same prompt reaches you when you were
  not watching at all: open a project whose branch carries Claude commits
  newer than your last visit and the toast says "Claude edited N files while
  you were away" — "in this project" if you had never opened it. The mark is
  per person, project and branch — server-side with accounts, per browser
  without — so it follows you across devices when you are signed in.
  Reviewing or dismissing ends it; an ignored prompt returns exactly once
  more and then counts as seen. There is one review prompt at a time: a
  session ending replaces an away prompt still on screen. Your own commits never trigger
  it, and a branch with a long agent history shows the count with the newest
  20 commits' diffs, which are also the only ones Revert undoes.

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
closed (a fetch error on the PDF card in the chat), never open. The Agent
access card in Aldine's account settings is a different thing; the
Troubleshooting rows name each. Other hosts get the link in
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
- **What it cannot do.** Purge a project (the one trash tool reaches only
  projects the agent created, and only as far as the workspace trash),
  change sharing, push to a git remote (GitHub or GitLab), or create, list or
  revoke tokens; those routes accept browser
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
| Connect probe gets HTML, or `404 {"error":"not found"}` | The URL is not exactly `https://<host>/mcp`: HTML means `/mcp` is missing (the SPA answered); a JSON 404 means the path is off by a trailing slash or a prefix (`/mcp/`, `/api/mcp`), the instance is under a path prefix the URL lacks, or the proxy does not forward `/mcp` — paste the address the Agent access card shows. |
| `You do not have access to this project`, `No project "…" is reachable with this token`, or `This token does not have access to that project` | Three denials. The first: the project exists but the token's user is not a member — share it with them, or use their token. The second: no project has that id for this credential — a project *name* was passed where tools take ids (`list_projects` has them), a typo, or the project is in the trash. The third: the token is scoped to other projects — mint one scoped to this project, or an unscoped one. Over REST the first is a 403 with the same text and a missing project a 404 `project not found`. |
| `version_conflict` on a file nobody edited | `reason` says which rule fired. A `base_version` newer than the branch's `contentVersion` came from another server process (a restart, another node) — re-read the file and use the version that read returns. See "Versions and conflicts". |
| Instance under a path prefix | The connector URL carries it (`https://host/prefix/mcp`) and `ALDINE_PUBLIC_URL` includes it. The discovery documents sit at the origin root with the prefix inserted after the well-known segment (`/.well-known/oauth-authorization-server/prefix`, `/.well-known/oauth-protected-resource/prefix/mcp`), so the proxy must forward those two paths to Aldine as well as the prefix itself (`deploy/nginx.conf` shows it). |
| The PDF card in the chat says the viewer is not built | `apps/server/assets/pdf-viewer.html` is missing: run `npm run build:viewer -w apps/server`. The tools keep returning the link meanwhile. |
| The PDF card in the chat shows a fetch error but the link opens in a tab | `ALDINE_PUBLIC_URL` is not the origin the browser reaches (the viewer may only fetch from that origin). |
| Link expired | Signed links last 15 minutes; ask Claude for the PDF again and it calls `get_pdf_url`. |
| `429 Too many requests` | The per-IP or per-token bucket is empty; slow the loop, or raise `RL_MCP_BURST`. |
| `GET /mcp` answers 401 (or 405 with a valid token) | Expected: the endpoint is POST-only and checks the credential first. |
| `compile` says the compiler cannot see the project | The compiler's `DATA_DIR` is not the server's (a compiler started by hand on the default `.data`, or a compose volume mismatch): the files exist but the compiler looks elsewhere. Point `COMPILER_URL` at a compiler sharing the server's `DATA_DIR`. Claude is told to relay this, not to recreate files. |
| `compile` returns a `hint` about a missing package | The compiler's TeX Live lacks that `.sty` (BasicTeX, for one, has no biblatex). Install it or use the docker compiler image; the document is fine. |
| "An agent typeset is already running" | One agent compile per account at a time; wait for it. |
