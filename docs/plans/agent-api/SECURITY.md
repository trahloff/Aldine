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
