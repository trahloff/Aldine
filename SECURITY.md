# Security Policy

## Supported versions

Aldine is pre-1.0. Only the latest release (and `main`) receives security fixes.

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Use [GitHub private vulnerability reporting](../../security/advisories/new)
("Report a vulnerability" on the repo's Security tab). You'll get an initial
response within 72 hours. Coordinated disclosure is appreciated; we'll credit
you in the fix's release notes unless you prefer otherwise.

## Scope notes for self-hosters

- Aldine's compiler container is sandboxed (no network egress, dropped
  capabilities, memory and PID limits, restricted shell-escape), but LaTeX is a
  Turing-complete language processing untrusted input. Treat the compiler
  container as semi-trusted and keep the isolation that ships in both
  `docker-compose.yml` and `docker-compose.full.yml`: the `internal: true`
  backend network, `cap_drop: [ALL]`, `no-new-privileges`, and the memory/PID
  bounds (the full file adds a CPU cap). If you write your own compose file,
  carry them over.
- Auth is **off by default** (single-tenant). Before exposing an instance to
  the internet, set `AUTH_ENABLED=1` and serve over HTTPS (the `tls` profile in
  `docker-compose.full.yml` ships a Caddy config that gets certificates for you).
- Session cookies are HTTP-only and revocable server-side; passwords are
  scrypt-hashed. They carry the Secure flag when `ALDINE_PUBLIC_URL` starts
  with `https`; behind HTTPS without it, set `COOKIE_SECURE=1` (the prod
  overlay does).
- Password sign-up is open to anyone who can reach the instance (unless
  `ALDINE_SIGNUP=approval` keeps every new account, password or single
  sign-on, out until an administrator approves it: deploy/README.md,
  "Approving new accounts"), and the typed address starts unconfirmed:
  projects shared with that address and
  `ALDINE_ADMIN_EMAILS` ignore the account until it follows the one-time link
  sent to the address (logged for the operator when no email transport is
  set) or completes a password reset. Accounts from before this check and
  single sign-on accounts count as confirmed (deploy/README.md, "Sign-up and
  invites").
- Password sign-in is limited per client address and, with exponential
  backoff, per account across all addresses (unknown addresses alike). A
  browser that signed in to the account before carries a signed device
  cookie that exempts it from the per-account wait, so knowing an address is
  not enough to lock its owner out. The cookie is bound to the account's
  current password, so a password change or reset ends every exemption
  issued before it, and signing up issues none.
- Single sign-on never signs into an existing account that merely shares an
  email address: not a password account, not another provider's, not another
  OIDC identity. With OpenID Connect the address is used only when the IdP
  marks it verified; `OIDC_EMAIL_VERIFIED=trust` drops that check and is safe
  only where users cannot edit their address at the IdP (docs/OIDC.md).
- Single-sign-on accounts have no password and cannot be given one, so a
  person the IdP disables (or `OIDC_ALLOWED_GROUPS` stops admitting) cannot
  sign in again. Existing sessions end at their expiry (30 days) unless an
  administrator disables the account on `/admin` or an operator removes
  them; docs/OIDC.md shows how.
- An administrator (`ALDINE_ADMIN_EMAILS`) can disable or delete an account
  on `/admin`. A disabled account is refused on every path: its sessions end
  at once, password and single sign-on are refused, its access tokens,
  OAuth refresh tokens and MCP calls are rejected, and its collab sockets are
  closed on every app node. The page cannot disable or delete its own
  account or another one on `ALDINE_ADMIN_EMAILS`, nor confirm an address on
  that list by hand or show its reset link. Every account action is logged
  with who did what to whom (deploy/README.md, "Managing accounts").
  An administrator is trusted with the accounts: on a server without email
  the reset link they are shown lets them set any other password account's
  password, and deleting an account can give its projects to them.

## Hall of fame

Reporters of validated vulnerabilities are listed here. Nothing yet — be the
first.
