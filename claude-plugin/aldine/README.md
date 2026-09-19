# Aldine plugin for Claude Code

Claude writes, typesets and reviews LaTeX in your [Aldine](https://aldine.dev)
instance. The plugin connects Claude Code to Aldine's MCP server and adds
three skills: a build-repair loop, section drafting, and bibliography work.
Every edit lands in the project's git history as a commit by "Claude" that you
review or revert from the editor.

## Install

From the marketplace in the Aldine repository:

```
/plugin marketplace add trahloff/Aldine
/plugin install aldine@aldine
```

Or, from a checkout, for one session:

```bash
claude --plugin-dir ./claude-plugin/aldine
```

## Setup

Requires an Aldine that serves the Agent API (`/mcp`, started with
`ALDINE_MCP=1`) — 0.10.0 or later, or a build from `main`; 0.9.0 and
earlier have no `/mcp` route.

The plugin reads two environment variables when Claude Code starts:

| Variable | Required | Value |
|---|---|---|
| `ALDINE_URL` | yes | The instance origin, no trailing slash: `https://aldine.example.org`, or `http://localhost:8080` for a local one. The server must run with `ALDINE_MCP=1`. |
| `ALDINE_TOKEN` | optional | A credential sent as `X-Aldine-Token`: the instance's `ALDINE_MCP_TOKEN` when auth is off (the demo box, a single-user compose stack), or a personal access token (`aldn_…`, Settings → Agent access) when auth is on and you cannot run the browser Connect flow (headless, `claude -p`, CI). Leave it unset to sign in through `/mcp`. |

With `ALDINE_TOKEN` unset the plugin sends no credential, the server answers
with an OAuth challenge, and Claude Code runs the Connect flow: type `/mcp`
in a session, pick **aldine**, sign in to your Aldine in the browser and
approve. The consent page warns that the client redirects only to your own
computer; that is expected for Claude Code. Revoke the session any time
under Settings → Agent access in Aldine.

Everything else — the REST alternatives, stdio for an instance whose server
is not running, tunnels, IP allowlisting — is in
[docs/AGENT_API.md](https://github.com/trahloff/Aldine/blob/main/docs/AGENT_API.md).

## Permissions

The MCP server, not the plugin, decides what a credential can do, and the
rules are the same as for the REST API.

Can: read, edit and create files in the projects the credential reaches;
typeset (one of the account's two concurrent slots at most, counted against
the monthly quota); commit; look up and append references; create projects
when the token is not scoped to specific ones.

Cannot: purge anything (`trash_project` moves only projects the agent itself
created to the workspace trash, restorable for 30 days by default, and is
refused for a person's project); change sharing; push to GitHub or GitLab;
create, list or revoke tokens; touch protected (showcase) projects; read
hidden folders such as `.git`.

Every write is one commit under the author "Claude" with the stated intent as
its message; the editor shows a "Claude edited N files" toast with a diff and
a one-click revert.

## Skills

**latex-fix-build** — compile, take the first error (`file`, `line`,
`message`, the source line as `context`), fix it with a quote-anchored
`edit_file`, recompile, at most three attempts, then report. Knows which
errors are not the document's fault (a package missing on the compiler, a
character pdflatex cannot typeset, a biber row on the `.bib`, a rootless
project) and relays those instead of editing.

> Fix the build of my thesis project on the `revision` branch and send me the PDF.

**latex-draft-section** — reads the paper (`project_structure`, `read_file`,
`list_labels`, `list_citations`) before writing, puts the new section into its
own file wired in with `\input` as one `batch_write` commit, compiles once,
reports the commit and the deep link. Keeps the author's macros, adds no
packages silently, never invents a label or a citation key.

> Draft a related-work section for the "Sparse attention" paper, about 600 words, citing only what is already in the .bib.

**latex-bibliography** — `references_add` for a DOI, arXiv or OpenAlex id,
`list_citations` first so nothing is duplicated, the `\cite` inserted with
`edit_file`, and biber told apart from bibtex by reading the preamble.
Explains the difference between "not found" (check the id) and a lookup
failure (the upstream refused the request — relay the status).

> Add 10.48550/arXiv.1706.03762 to my references and cite it where the paper first mentions attention.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `401 A valid access token is required` and no Connect prompt | The instance runs with auth off: set `ALDINE_TOKEN` to its `ALDINE_MCP_TOKEN` and restart Claude Code. With auth on, the token in `ALDINE_TOKEN` is wrong or revoked — unset it and connect through `/mcp` instead, or mint a new one under Settings → Agent access. |
| Connect prompt appears again after signing in | The Connect session was revoked in Aldine, or expired. Run the flow again from `/mcp`. |
| The server shows as failed, HTML or `404 {"error":"not found"}` in the log | `ALDINE_URL` is not exactly the instance origin: a trailing slash, a path prefix the URL lacks, or a proxy that does not forward `/mcp`. Copy the address the Agent access card in Aldine shows, minus `/mcp`. An instance on 0.9.0 or earlier has no `/mcp` at all — upgrade it. |
| `Failed to connect — Missing environment variables: ALDINE_URL` in `/mcp` or `claude mcp list` | The plugin's server URL is `${ALDINE_URL}/mcp` and Claude Code refuses a server whose variables are unset. Export `ALDINE_URL` in the shell that starts Claude Code, then restart. |
| Private or `localhost` instance | Works: Claude Code calls the server from your machine. Only the inline PDF viewer needs a public origin; the tools still return the PDF link. See "Reachability" in docs/AGENT_API.md for tunnels if you also want claude.ai to reach it. |
| `compile` says the compiler cannot see the project, or a `hint` names a missing package | Server-side setup: the compiler's `DATA_DIR` differs from the server's, or its TeX Live lacks the package. Claude relays these; the operator fixes them. |

## License

AGPL-3.0-only, the same as Aldine. See [LICENSE](LICENSE).
