# Agent API — threat model and required mitigations

Applies to every phase. Reviewers gate on this document.

## Ranked risks

### 1. Prompt-injected destructive writes (likelihood high, impact high)
LaTeX projects contain pasted web content, reviewer comments, .bib entries from the
internet — all of it reaches the model. Never trust the model to decline.

Mitigations (all server-side):
- Destructive tools DO NOT EXIST: no delete/purge, no share management, no GitHub
  push, no token management in any tool surface (00-overview non-goals).
- MCP handlers call the SAME guard functions as REST (canAccess, protected
  projects, trash, hidden paths) — shared functions, never copies.
- Every mutation is a named or auto commit → any injected edit is one `git revert`
  away. Session-review UI (UX.md) makes agent diffs one-glance auditable.
- Connector tool-approval default: Manual for write tools; read-only tools carry
  `readOnlyHint` for auto-approval.
- Residual: subtle content sabotage → git history is the answer; v2 candidate
  `diff_since` tool for session audits.

### 2. PAT leakage (config stores, clipboards)
- Project scope default in docs/UI examples → blast radius one paper.
- SHA-256 at rest → datastore leak yields no tokens.
- `lastUsedAt` in UI → anomaly = revoke; revocation effective next request.
- `aldn_` prefix in repo secret-scanning config.

### 3. /mcp as new public surface
- Env-gated off by default; bearer check BEFORE any JSON-RPC parsing.
- No-credential config unrepresentable: AUTH_ENABLED → PAT required; else
  `ALDINE_MCP_TOKEN` required; neither configured → unconditional 401 + boot hint.
- `mcpLimiter` per token + IP; ~2 MB body cap on the route.
- The MCP SDK sits on the auth boundary: pin the version; review releases before
  bumping.
- Optional hardening documented: firewall `/mcp` inbound to Anthropic's published
  egress range.

### 4. Compile-quota abuse / cost DoS via agent loops
- Monthly quota applies (token → user). Agent concurrency gate = 1 per user; human
  always keeps a shared-gate slot. `ALDINE_COMPILE_PER_MIN` on in prod. Compiler's
  own global 2-slot gate + 120 s kill bounds worst case.

### 5. Signed-URL scope creep (Phase 3)
- HMAC verification exists for `/output` ONLY, `.aldine-out` path regex still
  enforced, 15-min TTL, no-store. The signer must never generalize to arbitrary
  files — that would bypass authz one convenience at a time. Signing secret lives
  in META_DIR/env, never DATA_DIR (compiler must not read it).

### 6. OAuth 2.1 surface (Phase 2.5, 06-oauth.md)
Aldine is its own authorization server; every endpoint is anonymous-reachable.

- **CIMD fetch = SSRF vector.** A `client_id` that is an https URL makes the
  server GET it. Mitigations: https only, default port, no userinfo/fragment/dot
  segments; the host is resolved FIRST and every returned address is checked
  against loopback, private, link-local, CGNAT, multicast and cloud-metadata
  ranges (v4, v6, v4-mapped v6, NAT64), then the connection goes to the checked
  address with TLS `servername` — no second resolution for rebinding to win. No
  redirects followed, 5 s budget as one deadline over lookup + connect + body
  (the socket idle timer alone would let a trickling host pin a socket for
  hours), 64 KB cap, JSON content type required, 5-min positive cache capped
  at 256 documents (expired first, then oldest evicted), errors never cached.
  A socket dropped mid-body is `invalid_client`, never a 500. The loopback allowance exists only under
  `ALDINE_TEST_ALLOW_LOOPBACK_CIMD=1` (unit test) and must never be set in a
  deployment. Covered by `test/oauth.test.mjs` ("SSRF policy WITHOUT the flag").
- **DCR flooding.** `/oauth/register` is anonymous. Mitigations: 8 KB body cap,
  `oauthRegisterLimiter` (10 burst, 1/min per IP), at most 10 redirect URIs per
  client, hard cap of 500 stored clients with least-recently-used eviction (an
  evicted connector simply re-registers on its next Connect). Registration
  never issues a secret, so a flood yields nothing to steal.
- **Refresh-token reuse / theft.** Refresh tokens are `aldr_` secrets stored
  by SHA-256 digest, bound to the client_id and rotated on every use; the
  previous access token is revoked by the rotation. Marking a token used is a
  compare-and-set (`markRefreshUsed` reports whether it won), so two
  concurrent rotations of one token cannot both succeed — the loser is
  reuse. A rotated-out token presented again is treated as leaked: the whole family (every access and
  refresh token the consent ever produced) is revoked and the client gets
  `invalid_grant`. A code presented twice revokes its family the same way
  (RFC 6749 §4.1.2). Revoking a Connect token on the Agent access card revokes
  the family too, so a connector cannot mint a replacement after the user
  said no. Access tokens live 24 h, refresh tokens 30 d.
- **Consent CSRF / token-minting via a stolen bearer.** `/api/oauth/consent`
  is the one route that turns a session into a token. It is cookie-session
  only (a bearer gets 403 — tokens cannot mint tokens) and the bearer
  allowlist in routes.ts is unchanged. Cross-site protection is what every
  state-changing `/api` route relies on: the session cookie is SameSite=Lax
  and the body must be `application/json` — the form-urlencoded parser exists
  only inside the encapsulated `/oauth/*` plugin, so a cross-site `<form>`
  post gets 415 and a cross-site `fetch` with a JSON content type is stopped
  by the browser's preflight (no CORS). Nothing is redirected to an
  unvalidated URL: an unknown client or unregistered redirect_uri is a typed
  400, never a `redirectTo`.
- **Code guessing / token-endpoint brute force.** Codes are 32 random bytes,
  kept 10 minutes, keyed by digest, single use, and bound to client_id,
  redirect_uri, PKCE challenge (S256 only, verifier 43–128 chars), resource
  and user; one wrong binding burns the code. `oauthTokenLimiter` (30 burst,
  1/s per IP) covers `/oauth/token` and `/oauth/revoke`; `oauthClientLimiter`
  covers `/api/oauth/*`. Unknown and used codes share one error string;
  `/oauth/revoke` always answers 200; token responses are `no-store`.
- **Discovery behind a proxy.** The issuer in the discovery documents and the
  `iss` parameter come from `publicBase(req)` — with `ALDINE_PUBLIC_URL` set
  (staging/prod) the Host header cannot steer clients elsewhere.
- **Auth off = surface off.** Every OAuth route and discovery document is 404
  while `AUTH_ENABLED` is unset, and `/mcp` sends no `WWW-Authenticate`
  challenge — there is no authorization server to point at.

## Standing invariants (inherited, re-affirmed)
- Compiler service stays unauthenticated-but-unreachable (no host port, no egress);
  MCP talks to it only via the existing compilerUrl seam. No new volume mounts;
  META_DIR/DATA_DIR isolation survives all deploy changes.
- Never reseed open Yjs docs from plain text. `refreshBranchDocsFromDisk` is the
  only disk→doc path. Flush before external reads/writes.
- git tokens passed inline per operation, never written to .git/config — applies
  to any future agent-adjacent git features too.
- AGPL: `/mcp` is the same AGPL program speaking another protocol; §13 already
  covers the whole server. No new obligations; spend zero engineering time here.
