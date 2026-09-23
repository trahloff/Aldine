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
  capabilities, CPU/memory/PID limits, restricted shell-escape), but LaTeX is a
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
  scrypt-hashed. Set `COOKIE_SECURE=1` behind HTTPS.
- Single sign-on never signs into an existing account that merely shares an
  email address: not a password account, not another provider's, not another
  OIDC identity. With OpenID Connect the address is used only when the IdP
  marks it verified; `OIDC_EMAIL_VERIFIED=trust` drops that check and is safe
  only where users cannot edit their address at the IdP (docs/OIDC.md).
- Single-sign-on accounts have no password and cannot be given one, so a
  person the IdP disables (or `OIDC_ALLOWED_GROUPS` stops admitting) cannot
  sign in again. Existing sessions end at their expiry (30 days) unless an
  operator removes them; docs/OIDC.md shows how.

## Hall of fame

Reporters of validated vulnerabilities are listed here. Nothing yet — be the
first.
