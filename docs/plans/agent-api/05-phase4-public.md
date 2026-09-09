# Phase 4 — Public feature (docs, plugin, OAuth, directory)

Requires Phases 1–3 done and the dogfood exit criterion met. 3–5 days core;
+1 focused week for OAuth, which is demand-gated.

## 4.1 Self-hoster documentation (docs/AGENT_API.md + site)

- Setup guide: enable `ALDINE_MCP=1`; auth-on → create PAT in "Agent access";
  auth-off → `ALDINE_MCP_TOKEN`; add connector in Claude (static_headers header
  name/value, connector URL `https://<host>/mcp`).
- Reachability, honestly: claude.ai/Desktop/mobile/Cowork connect FROM Anthropic's
  cloud (published egress range) — the instance must be publicly reachable. Private
  instances: (a) Claude Code / stdio path (same server, local transport), (b)
  Cloudflare Tunnel / `tailscale funnel` recipe (one page, in deploy/), (c) IP
  allowlist hardening for `/mcp` (Anthropic egress range) for those who expose it.
- "Why there is no authless mode" paragraph (SECURITY.md rationale).
- Trial section: demo.aldine.dev connector with published token, nightly reset.
- Landing page: feature section + the Phase 3 GIF; llms.txt updated.

## 4.2 Claude Code plugin

- Repo `aldine-claude-plugin` (or in-repo `plugins/claude/`): `.claude-plugin/`
  with `.mcp.json` pointing at the user's instance (env-var interpolated), plus
  skills: `latex-fix-build` (the canonical repair-loop prompt), `latex-draft-section`,
  `latex-bibliography`. Marketplace-installable (git repo marketplace.json).
- Matches Anthropic partner guidance: remote MCP server + plugin wrapping it with
  skills. Works in Claude Code AND Cowork (plugins beta).
- Submit to claude-plugins-community once stable (SHA-pinned submission).

## 4.3 OAuth 2.1 + Connectors Directory (build ONLY if the trial connector shows pull)

- Aldine as its own authorization server: authorization-code + PKCE (S256),
  discovery via 401 + `WWW-Authenticate` → `/.well-known/oauth-protected-resource`,
  authorize page reusing the cookie session for consent (project-scope picker =
  consent screen), token endpoint minting PATs, CIMD preferred over DCR (less
  state). Redirect URI: the published claude.ai callback; Claude Code uses loopback.
- Latency budgets from Claude docs: 10 s discovery/token, 30 s refresh.
- Directory submission: public HTTPS + OAuth discovery required. NOTE: the
  directory model fits a hosted/managed instance (every user connects to ONE
  well-known URL); for self-hosters it is a credibility badge, not acquisition.
  Decide at submission time whether the listed connector points at the future
  managed cloud or stays unlisted until that exists.

## 4.4 Announcement (HN post #2)

- The story is the demo, not the tech: "Claude is a collaborator in my self-hosted
  Overleaf alternative — it writes, compiles, and shows me the PDF in the chat."
  GIF first. Trial connector link above the fold.
- Per standing rule: every public post gets Toby's explicit go; commit timing rules
  apply to all public-repo pushes.

## 4.5 Acceptance

- A stranger-test: someone (or a clean-profile session) sets up a fresh instance
  from docs alone and completes the loop within 15 minutes.
- Plugin installs from marketplace in a clean Claude Code; skills invoke.
- Metrics counters (00-overview §metrics) live in prod before the announcement.
- If OAuth built: full flow e2e against claude.ai staging connector + revocation.
