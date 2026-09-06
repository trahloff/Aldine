# Phase 2.5 — OAuth 2.1: "add the connector, click Connect, it works"

Pulled forward from Phase 4.3 on 2026-09-02 after the first staging dogfood:
claude.ai auto-detects OAuth from the `/mcp` 401, and its header-based
workaround is hidden behind "Authentication: None". For a public feature the
Connect button IS the onboarding. This spec is law for the implementing
workflow; SECURITY.md and UX.md still apply.

Branch: `agent-api`. Deployed to staging (`staging.aldine.tobiasrahloff.com`)
for the live test against claude.ai. Nothing here touches prod.

## Goal

A user adds `https://<host>/mcp` as a custom connector in claude.ai (or runs
`claude mcp add --transport http aldine https://<host>/mcp` in Claude Code),
clicks Connect, signs in to Aldine (or is already signed in), picks which
projects Claude may touch, clicks Allow — and the connector works. No tokens
copied by hand. Personal access tokens keep working unchanged for scripts.

## Protocol surface (all server-side, `apps/server/src/oauth/`)

Aldine is both the MCP resource server and its own authorization server.
Issuer = `publicBase(req)` (the existing helper; honours ALDINE_PUBLIC_URL).

1. `GET /.well-known/oauth-protected-resource` and
   `GET /.well-known/oauth-protected-resource/mcp` (RFC 9728, both paths):
   `{ resource: "<issuer>/mcp", authorization_servers: ["<issuer>"],
   bearer_methods_supported: ["header"], scopes_supported: ["projects"] }`.
2. `GET /.well-known/oauth-authorization-server` (RFC 8414):
   issuer, `authorization_endpoint: <issuer>/oauth/authorize`,
   `token_endpoint: <issuer>/oauth/token`,
   `registration_endpoint: <issuer>/oauth/register`,
   `revocation_endpoint: <issuer>/oauth/revoke`,
   `response_types_supported: ["code"]`,
   `grant_types_supported: ["authorization_code","refresh_token"]`,
   `code_challenge_methods_supported: ["S256"]`,
   `token_endpoint_auth_methods_supported: ["none"]`,
   `client_id_metadata_document_supported: true`,
   `scopes_supported: ["projects"]`.
3. `/mcp` 401 responses carry
   `WWW-Authenticate: Bearer resource_metadata="<issuer>/.well-known/oauth-protected-resource"`
   (plus `error="invalid_token"` when a credential was presented and rejected).
   The body stays the existing JSON.
4. `GET /oauth/authorize` is served by the SPA (route below). The server
   validates on `GET /api/oauth/client?client_id=&redirect_uri=` (returns the
   client's display name + host, or a typed error) and on
   `POST /api/oauth/consent` (session-only; body = the authorize params +
   `projectIds: string[] | null` + `decision: "allow" | "deny"`; returns
   `{ redirectTo }`). Both are cookie-session routes and MUST NOT be added to
   the bearer allowlist in routes.ts (tokens cannot mint tokens).
5. `POST /oauth/token` (form-encoded, public client, no client auth):
   - `grant_type=authorization_code`: verify code (single use, 10-minute TTL,
     bound to client_id, redirect_uri, code_challenge, resource, userId,
     projectIds), verify PKCE S256 (`code_verifier` required, 43–128 chars),
     then mint an access token = a normal `aldn_` TokenRecord (name = client
     name, `projectIds` from consent, `expiresAt` = now + 24 h) and a refresh
     token (opaque `aldr_…`, stored hashed, 30-day TTL, one family per
     consent). Response `{ access_token, token_type: "Bearer", expires_in,
     refresh_token, scope: "projects" }`, `Cache-Control: no-store`.
   - `grant_type=refresh_token`: rotate — mint a new access token + refresh
     token, revoke the previous access token, mark the old refresh token used.
     Presenting a used refresh token again = reuse → revoke the whole family
     (every token it ever produced) and return `invalid_grant`.
   - Errors in RFC 6749 shape (`{ error, error_description }`, 400; 401 for
     invalid_client). Never say whether a code existed.
6. `POST /oauth/register` (RFC 7591, DCR): accepts `redirect_uris` (required,
   each `https://…` or loopback `http://127.0.0.1[:port]/…` /
   `http://localhost[:port]/…`), `client_name`, `token_endpoint_auth_method`
   (must be `none`), `grant_types` / `response_types` (validated subsets).
   Returns `client_id: "aldc_<random>"`, no secret. Body ≤ 8 KB. Rate-limited
   (IP). Hard cap of 500 stored clients: past it, evict the least recently used.
7. `POST /oauth/revoke` (RFC 7009): body `token` (+ optional
   `token_type_hint`); revokes an access token or a refresh token family.
   Always 200.
8. Client ID Metadata Documents (CIMD, what claude.ai uses by default): when
   `client_id` is an `https://` URL, fetch it (GET, `Accept: application/json`,
   5 s timeout, ≤ 64 KB, no redirects followed, cached 5 min in memory) and
   require `client_id` in the document to equal the URL and `redirect_uris` to
   contain the presented `redirect_uri` exactly. SSRF rules: https only, the
   hostname must not resolve to loopback, link-local, private, or metadata
   ranges, no userinfo, no non-default port games. The implementer verifies
   the exact CIMD field names and Claude's callback URL against the live
   docs before coding — do not guess:
   https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
   and https://docs.claude.com/en/docs/agents-and-tools/mcp-connector (and the
   custom-connector help pages linked from it).
9. `resource` parameter (RFC 8707): if present on authorize or token requests
   it must equal `<issuer>/mcp` (trailing slash tolerated); otherwise
   `invalid_target`.
10. Existing MCP auth (`Authorization: Bearer aldn_…`, `X-Aldine-Token`,
    `ALDINE_MCP_TOKEN`) is untouched: OAuth access tokens ARE `aldn_` tokens.
    With auth off (`AUTH_ENABLED` unset) the OAuth endpoints return 404 and
    the discovery documents are not served — nothing to authorize against.

## Storage (datastore seam: `src/db/types.ts`, `json.ts`, `pg.ts`, conformance test)

- `TokenRecord` gains `clientName: string | null` and `family: string | null`
  (null for hand-made tokens). The Agent access card shows OAuth tokens with
  the client name and a "via Connect" label; revoke works the same.
- New: `OAuthClient { id, name, redirectUris: string[], createdAt, lastUsedAt }`
  with `createOAuthClient`, `getOAuthClient`, `touchOAuthClient`,
  `countOAuthClients`, `evictOldestOAuthClients(n)`.
- New: `RefreshTokenRecord { id, hash, tokenId, userId, family, projectIds,
  clientName, expiresAt, usedAt, revokedAt }` with `createRefresh`,
  `getRefreshByHash`, `markRefreshUsed`, `revokeRefreshFamily(family)`,
  `revokeTokensInFamily(family)` (or equivalent that reaches the access
  tokens). Postgres gets the columns/tables via the existing migration
  pattern; the conformance suite covers every new method on both backends.
- Authorization codes live in memory (Map with TTL sweep). Single-node is the
  documented deployment shape; note the limitation in a comment.

## Web (`apps/web`)

- New route `/oauth/authorize` → `OAuthConsent` page (`src/pages/OAuthConsent.tsx`).
  Reads the query string, calls `GET /api/oauth/client`, and:
  - invalid client / redirect_uri → an error card, no redirect (never send
    the user to an unvalidated URL);
  - not signed in → the existing sign-in UI inline (reuse what Home shows),
    staying on the page afterwards;
  - signed in → consent card: "<client name> wants to work in your Aldine
    projects", the host it was registered from, a scope picker (all projects
    now and later / only these projects, multi-select of the user's
    projects), buttons "Allow" and "Deny". Allow/Deny POST
    `/api/oauth/consent` and navigate to `redirectTo`.
  - `data-testid`: `oauth-consent`, `oauth-client-name`, `oauth-scope-all`,
    `oauth-scope-pick`, `oauth-project-<id>`, `oauth-allow`, `oauth-deny`,
    `oauth-error`.
- Strings sentence-case and concrete (UX.md). Works in both themes.
- Agent access card copy: replace the header instructions with "In Claude:
  Settings → Connectors → Add custom connector → Connect." and keep the token
  section for scripts.

## Security review focus (Stage C2, two lenses)

Protocol lens: PKCE mandatory and verified (S256 only), code single use and
bound to every request parameter, exact redirect_uri match, `state` echoed
untouched, no open redirect on any error path, refresh rotation with reuse
detection, `resource` validated, discovery documents correct for the issuer
(behind the ALB: ALDINE_PUBLIC_URL, not Host), correct RFC error codes,
`no-store` on token responses.

Application lens: SSRF on CIMD fetch (DNS rebinding included: resolve, check,
then connect to the checked address), CSRF on `/api/oauth/consent` (same
protection every state-changing `/api` route already has — verify what that
is rather than assuming), rate limits on `/oauth/token`, `/oauth/register`,
CIMD fetches and `/api/oauth/*`, body caps, timing-safe compares, nothing
secret in logs or error strings, DCR storage cap enforced, the bearer
allowlist untouched, OAuth endpoints 404 when auth is off.

## Tests

- Unit `apps/server/test/oauth.test.mjs` (add to `test:unit`): discovery
  documents; full code+PKCE flow via `app.inject`; wrong verifier; code reuse
  revokes; wrong redirect_uri; refresh rotation and reuse detection; `resource`
  mismatch; DCR register + validation failures + cap; CIMD happy path and
  rejections against a local stub HTTP server (loopback is allowed ONLY under
  an explicit test flag, never by default); revoke; auth-off → 404.
- Conformance: new datastore methods on JSON and Postgres.
- e2e `e2e/auth-tests/oauth.spec.ts`: a tiny loopback HTTP server registered
  via DCR as the client; browser opens `/oauth/authorize?…`, signs in, picks
  one project, Allows; the test captures the code on the loopback server,
  exchanges it at `/oauth/token`, and calls `/mcp` with the access token
  (ping + list_projects shows only the picked project). Also Deny →
  `error=access_denied` at the redirect. Run with the auth Playwright config
  (`npm run test:e2e:auth`), one spec file at a time.
- Existing suites stay green: `npm run test:unit -w apps/server`,
  `npm run test:db -w apps/server` (JSON only if no Postgres), web typecheck +
  vitest, `auth-tests/tokens.spec.ts` and `auth-tests/mcp.spec.ts`.

## Docs and changelog

CHANGELOG "Added" entry under Unreleased with the feature (written with it).
`02-phase1-connector.md` auth section points here. SECURITY.md gets the new
threat rows (CIMD SSRF, DCR flooding, refresh reuse, consent CSRF).
`docs/plans/agent-api/dogfood-notes.md` gets a "Connect flow" checklist.

## Acceptance

- Unit + conformance + e2e above green; existing suites green.
- Reviews per WORKFLOW.md (C1, C2 ×2 lenses, C3) with fixes reviewed (D').
- Live: from claude.ai with the default connector settings ("Always
  required", "Use Anthropic's hosted client metadata") against staging, the
  Connect button completes and `list_projects` works. From Claude Code,
  `claude mcp add --transport http aldine <staging>/mcp` then `/mcp` login
  completes. Both are Toby's manual checks; the workflow summary lists the
  exact steps.
