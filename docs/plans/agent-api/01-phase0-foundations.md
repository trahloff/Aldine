# Phase 0 — Foundations (prerequisites for any agent write)

No MCP code lands until everything here is merged and green. Three work items.

## 0.1 Fix the open-doc flush races (data-loss bug, ships regardless of Agent API)

Current behavior (verified):
- `PUT /api/projects/:id/file` (routes.ts, ~line 520) writes disk then calls
  `refreshBranchDocsFromDisk` WITHOUT `flushBranchDocs` first. Hocuspocus debounces
  stores 1500 ms / max 8000 ms (collab.ts), so up to ~8 s of a live collaborator's
  typing exists only in memory; the PUT lands on stale disk content and the refresh
  whole-text-replaces the doc — silently discarding those keystrokes.
- `GET /api/projects/:id/file` (routes.ts, ~line 497) reads disk without flushing —
  up to ~8 s stale relative to the editor. Read-modify-write via REST is racy on
  both ends.
- Contrast: `/bib`, `/labels`, `/wordcount`, `/commit`, `/merge`, all GitHub write
  paths, and `compile.ts` all flush first. The two file routes are the outliers.

Change:
1. `GET /file`: `await flushBranchDocs(id, branch)` before reading disk.
2. `PUT /file`: `await flushBranchDocs(id, branch)` before writing disk (keep the
   existing refresh + scheduleCommit after).
3. Leave `refreshBranchDocsFromDisk` semantics untouched (CRDT delete+insert on the
   existing doc — the never-reseed invariant, collab.ts ~42-49, stays law).

Acceptance:
- New e2e: open a collab session in Playwright, type into a file, immediately
  `PUT /file` (modified full content based on a pre-typing read) from the test —
  assert the user's keystrokes survive in both the doc and on disk. Crib the
  Yjs-provider-driving pattern from the byte-stability cursor-tour test.
- Existing e2e suites stay green.

## 0.2 Expose contentVersion (optimistic-concurrency primitive)

`contentVersion` per project::branch already exists internally (collab.ts ~96-103,
bumped by every disk-changing path) but is never serialized.

Change:
1. `GET /file`: add response header `x-aldine-content-version`.
2. `GET /files` (tree listing): add `contentVersion` field to the JSON response.
3. `PUT /file`: accept optional `baseVersion` in the body; if present and ≠ current
   contentVersion for that branch → `409 {error:'version_conflict',
   currentVersion}` without writing. (Branch-granular is deliberate — that is what
   contentVersion is; per-file versions are a later refinement if conflicts prove
   noisy.)

Acceptance: unit/integration coverage in `apps/server/test/` for the 409 path and
the header; e2e untouched (no UI change).

## 0.3 Personal access tokens (PAT layer)

The only credential today is the `aldine_session` cookie (auth.ts; `sidFromRequest`
parses the Cookie header exclusively). Agents need a headless, revocable, scoped
credential.

### Token design
- Format: `aldn_` + 32 random bytes base64url (~43 chars total). Prefix enables
  secret-scanning and log identification.
- At rest: SHA-256 digest only (NOT scrypt — a 256-bit random token needs no slow
  hashing; scrypt-per-request is self-inflicted latency). Look up by digest;
  compare with `timingSafeEqual` on the digest.
- Record shape (datastore seam, both JsonStore and PgStore):
  `{ id, userId, name, hash, projectIds: string[] | null, createdAt, lastUsedAt,
  expiresAt: string | null, revokedAt: string | null }`
  `projectIds: null` = all of the user's projects. No verb scopes (v1 decision).
- `lastUsedAt` updated at most once per minute per token (avoid write amplification
  in JsonStore).

### Server integration
1. `auth.ts`: new `userFromToken(authorizationHeader)` — parse `Bearer aldn_…`,
   digest, look up, reject revoked/expired, return `{user, tokenScope}`.
2. The `onRequest` hook (routes.ts ~280): if an `authorization: Bearer aldn_` header
   is present, resolve via `userFromToken` and set `req` user + token scope; else
   fall through to the cookie path unchanged. The global preHandler guard then
   applies `canAccess`/protected/trash rules to token traffic for free.
3. Scope check in the preHandler: if tokenScope.projectIds is non-null and the
   route's `:id` ∉ projectIds → 403.
4. `collab.ts` `onAuthenticate`: also accept the bearer header from
   `requestHeaders.authorization` (two lines; not needed by Phase 1's in-process
   design but correct to have).
5. Token CRUD routes (session-cookie auth ONLY — a token must not manage tokens):
   - `GET /api/tokens` → `[{id,name,projectIds,createdAt,lastUsedAt,expiresAt}]`
   - `POST /api/tokens {name, projectIds?, expiresAt?}` → full token value,
     returned exactly once.
   - `DELETE /api/tokens/:tokenId` → revoke (set revokedAt; effective next request).
6. When `AUTH_ENABLED` is off: token routes return 404 (no users exist); the
   `ALDINE_MCP_TOKEN` static-credential path arrives in Phase 1 and is the auth-off
   story.

### Settings UI — "Agent access" card
In the existing account/settings surface (apps/web):
- Heading "Agent access". Button "Create access token" → name field (+ optional
  project scope picker, optional expiry) → token shown once in a copy field with
  "You won't see this again", plus the connector URL (`https://<host>/mcp`) and the
  one-liner "In Claude: Settings → Connectors → Add custom connector".
- Token list: name, created, **last used** ("is it connected?" debugger), revoke
  button per row.
- `data-testid`: `agent-token-create`, `agent-token-value`, `agent-token-revoke`.
- Strings sentence-case, concrete, name the action (repo convention).

### Acceptance
- e2e (auth config): create token via UI → REST call with `Authorization: Bearer`
  succeeds → project-scoped token 403s on an out-of-scope project → revoke → 401.
- Unit: digest lookup, expiry, revocation, scope check, lastUsedAt throttle.
- Datastore conformance suite (apps/server/test/datastore.conformance.mjs) extended
  with the token methods so JsonStore and PgStore stay in lockstep.
- CHANGELOG entry (with the feature, not after). No new runtime deps expected; if
  any, commit the lockfile.

## Out of scope for Phase 0
- Any MCP code, the `/mcp` route, MCP SDK dependency.
- OAuth anything.
- UI beyond the settings card.
