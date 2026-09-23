# Sign in with your own identity provider (OIDC)

Aldine can use any OpenID Connect provider for sign-in: Keycloak, Authentik,
Authelia, Pocket ID, Dex, or a hosted one. It shows up on the sign-in page as one
more button next to Google, GitHub and ORCID. One OIDC provider per instance.

It needs multi-user mode (`AUTH_ENABLED=1`) and `ALDINE_PUBLIC_URL`. With
`ALDINE_SSO_ONLY=1` the OIDC button is the only way in.

## The redirect URI

Register exactly this redirect (callback) URI at your identity provider:

```
<ALDINE_PUBLIC_URL>/api/auth/oauth/oidc/callback
```

For example `https://aldine.example.com/api/auth/oauth/oidc/callback`, or
`https://server.example.com/internal/aldine/api/auth/oauth/oidc/callback` when
Aldine is served under a path prefix (`ALDINE_PUBLIC_URL` then carries the
prefix). Without `ALDINE_PUBLIC_URL` Aldine derives the URI from the request's
host, which behind a proxy is often not what the IdP has on file. Set it.

## Settings

All configuration is environment variables. `OIDC_ISSUER` and
`OIDC_CLIENT_ID` turn the feature on.

| Variable | Default | Meaning |
|---|---|---|
| `OIDC_ISSUER` | — | The issuer URL, as the IdP publishes it. Aldine reads `<issuer>/.well-known/openid-configuration`. An issuer with a path works (`https://auth.example.com/application/o/aldine/`); keep the trailing slash if your IdP shows one. Must be `https`, except for `localhost`. |
| `OIDC_CLIENT_ID` | — | The client ID you registered. |
| `OIDC_CLIENT_SECRET` | unset | Set it for a confidential client: Aldine then authenticates with `client_secret_basic`, or with `client_secret_post` when the IdP's discovery document offers only that. Leave it unset for a public client: PKCE only, no client authentication. PKCE (S256) is used either way. |
| `OIDC_LABEL` | `Single sign-on` | The button text (`Continue with <label>`) and the provider's name on the account page, e.g. `Keycloak` or `University login`. |
| `OIDC_SCOPES` | `openid email profile` | Scopes to request, space- or comma-separated. `openid` is always added. Add `groups` for IdPs that only send groups when asked (Authelia, Pocket ID). |
| `OIDC_ALLOWED_GROUPS` | unset | Comma-separated group names. When set, only members of at least one may sign in with OIDC; everyone else sees "your account is not in a group that may use this Aldine instance". Unset: everyone the IdP authenticates gets in. It gates OIDC sign-in only, not password accounts; see [Access control](#access-control). |
| `OIDC_GROUPS_CLAIM` | `groups` | The claim that lists the groups. Read from the ID token, or from the userinfo endpoint when the ID token has none. A single string counts as one group. |
| `OIDC_EMAIL_VERIFIED` | `require` | `require`: Aldine uses the address only when the IdP says `email_verified: true`. `trust`: it uses whatever address the IdP sends. See below before choosing `trust`. |

The boot log names the issuer, the client ID and whether the client is public
or confidential (`[aldine] OIDC sign-in: issuer=… client=… (confidential)`);
the secret is never printed. When some `OIDC_*` variables are set but
`OIDC_ISSUER` or `OIDC_CLIENT_ID` is missing (a typo such as `OIDC_CLIENTID`),
the boot log says which one and the feature stays off. An
`OIDC_EMAIL_VERIFIED` value other than `require` or `trust` is also logged, and
treated as `require`.

Discovery is fetched when Aldine starts and cached for an hour. When the hourly
refresh fails, Aldine keeps using the last good document and retries every 15
seconds. An IdP that is down does not stop Aldine or the other sign-in
providers, and the button still shows:

- If the IdP is unreachable when discovery is fetched and no earlier document
  is cached (the first use after a start), the attempt ends on an Aldine page
  saying "Single sign-on is unavailable: the identity provider at … could not
  be reached (ECONNREFUSED) — try again later". The reason in brackets is the
  network error, and an untrusted certificate or unknown host name is named
  as such (see [Troubleshooting](#troubleshooting)).
- While a discovery document is cached, the button sends the browser straight
  to the IdP, and the browser shows its own connection error. A person who
  comes back from the IdP while it is down sees "the identity provider did
  not answer the token request".

Every sign-in failure ends on a short Aldine page with the reason and a *Back
to sign-in* link.

### A private CA or a self-signed certificate

Aldine checks the IdP's TLS certificate against Node's built-in CA list. If
your IdP uses an internal CA, mount the CA certificate into the container and
point `NODE_EXTRA_CA_CERTS` at it:

```yaml
services:
  aldine:
    environment:
      NODE_EXTRA_CA_CERTS: /etc/aldine/ca.pem
    volumes:
      - ./ca.pem:/etc/aldine/ca.pem:ro
```

Without it, sign-in says the identity provider "presented a TLS certificate
that is not trusted (UNABLE_TO_GET_ISSUER_CERT_LOCALLY …)".

## What Aldine checks

- Authorization code flow with PKCE (S256), `state` and `nonce`. The PKCE
  verifier and nonce are derived from a random value kept in the same
  short-lived (10 minutes), HttpOnly state cookie as the state, so they are
  bound to that one attempt and never sent to the IdP in the clear.
- The ID token's signature against the issuer's JWKS, using only the
  asymmetric algorithms the discovery document lists (RS256 when it lists
  none). Unsigned tokens (`alg: none`) and HMAC-signed tokens (`HS256` and
  friends) are refused, so an IdP must sign with a key pair.
- `iss` exactly as the IdP spells it, `aud` containing the client ID, `azp`
  when there are several audiences, `exp`, `iat` (at most 10 minutes old,
  60 seconds of clock skew tolerated) and the `nonce`.
- The `iss` parameter on the callback, when the IdP sends one (RFC 9207). An
  IdP that advertises `authorization_response_iss_parameter_supported` must
  send it; a callback without it is refused.
- Userinfo is consulted only for claims the ID token lacks (Authelia 4.39+
  puts email and groups only there), and only when its `sub` matches.

Verification uses [jose](https://github.com/panva/jose); Aldine does not parse
or verify JWTs itself.

## Accounts and email addresses

An OIDC account is keyed by the issuer and the IdP's `sub`, not by the email
address. Signing in again finds the same account even after the address
changes at the IdP.

- With a verified address (or `OIDC_EMAIL_VERIFIED=trust`), the account gets
  that address, and collaborators can invite it by email.
- Without one, the account has no email address at all, like an ORCID account
  with a private email. It cannot be matched to an existing account by address
  and cannot be invited by email. The first later sign-in that brings a
  verified address gives the account that address, unless another account
  already has it.
- After that, the address stays as it is. Aldine does not follow a change of
  address at the IdP, because project invites and shares are matched by the
  address on the account.
- A single-sign-on login never takes over an account that already exists with
  the same address: not a password account ("sign in with your password
  instead"), not an account from another provider, and not another OIDC
  identity that happens to share the address.

Choose `OIDC_EMAIL_VERIFIED=trust` only when users cannot set or change their
own email address at the IdP (addresses come from a directory you control).
Otherwise anyone who can edit their IdP profile can pick any address.

The same goes for an IdP that reports `email_verified: true` for every
address, including ones users typed in themselves: that is `trust` under
another name. A verified address decides who receives project invites sent to
it, and whether the account is an instance administrator
(`ALDINE_ADMIN_EMAILS`). So before relying on either:

- Make sure users cannot change their own address at the IdP, or that a
  change goes through verification. For Authentik and Pocket ID this is a
  setting; see their recipes below.
- Create the administrator accounts (sign in once as each address in
  `ALDINE_ADMIN_EMAILS`) before you open OIDC sign-in to everyone.

### Changing `OIDC_ISSUER`

The account is keyed by the issuer URL exactly as the IdP spells it, so any
change of that URL gives everyone new identities, even when the IdP itself is
the same: a new host name, an Authentik application slug that was renamed, or
a Keycloak upgrade that dropped the `/auth` prefix (`/auth/realms/x` became
`/realms/x`). A person whose old account has a verified address is then
refused with "An account with this email already belongs to a different
single sign-on identity — ask the administrator for help."; a person without
an address gets a new, empty account.

If you can, keep the old issuer URL (Keycloak can still serve `/auth` with
`--http-relative-path=/auth`). Otherwise move each account onto its new
identity. The subject is `oidc:<16 characters>:<sub>`; compute it for the new
issuer with

```sh
node -e "const [i,s]=process.argv.slice(1);console.log('oidc:'+require('crypto').createHash('sha256').update(i).digest('base64url').slice(0,16)+':'+s)" 'https://new-issuer.example.com/realms/x' '<sub>'
```

using the issuer exactly as the new discovery document reports it. Then:

- **Postgres** (`DATABASE_URL`):
  `UPDATE users SET subject = '<new subject>' WHERE subject = '<old subject>';`
- **JSON files** (the default): stop Aldine, change the `subject` of the
  account in `users.json` in `META_DIR`, and start Aldine again. Aldine keeps
  that file in memory while running, so an edit made while it runs is lost.

For an account that has a verified address, removing its `subject` (set it to
`NULL`, or delete the field) is enough: the next sign-in with that address
binds the new identity.

## Access control

- Accounts created by single sign-on never have a password. Aldine refuses to
  set one, sends no reset link for them, and refuses password sign-in, so
  every sign-in goes through the IdP and `OIDC_ALLOWED_GROUPS`.
- `OIDC_ALLOWED_GROUPS` gates OIDC sign-in only. Anyone can still register a
  password account unless `ALDINE_SSO_ONLY=1` is set. If the group is meant to
  decide who uses the instance, set `ALDINE_SSO_ONLY=1` as well.
- Group membership and the IdP account are checked at sign-in. Removing
  someone from the group, or disabling them at the IdP, takes effect at their
  next sign-in. Until then their Aldine session (up to 30 days) and any access
  tokens they created keep working. To cut access at once, remove the
  person's sessions and tokens:
  - **Postgres**:
    `DELETE FROM sessions WHERE user_id = '<id>'; UPDATE tokens SET revoked_at = now()::text WHERE user_id = '<id>' AND revoked_at IS NULL; UPDATE refresh_tokens SET revoked_at = now()::text WHERE user_id = '<id>' AND revoked_at IS NULL;`
  - **JSON files**: stop Aldine, remove that user's entries from
    `sessions.json`, `tokens.json` and `refresh_tokens.json` in `META_DIR`,
    and start Aldine again.

  The user id is in `users.json` or the `users` table, and in the
  `/api/admin/users` response for an instance administrator.

## Setup recipes

Replace `aldine.example.com` with your `ALDINE_PUBLIC_URL`. A recipe that
was checked against a running copy of that IdP says so; the others follow the
IdP's documentation.

### Keycloak

Verified against Keycloak 26.0 on 2026-09-23 (confidential client, groups in
the ID token and in userinfo only).

1. In your realm: **Clients → Create client**. Client type *OpenID Connect*,
   Client ID `aldine`.
2. **Capability config**: *Client authentication* on (confidential) and
   *Standard flow* on; everything else off.
3. **Login settings**: *Valid redirect URIs*
   `https://aldine.example.com/api/auth/oauth/oidc/callback`, *Web origins*
   `https://aldine.example.com`.
4. **Credentials** tab: copy the client secret.
5. Optional, for `OIDC_ALLOWED_GROUPS`: **Clients → aldine → Client scopes
   tab → aldine-dedicated → Add mapper → By configuration → Group
   Membership**. Token claim name `groups`, *Full group path* off (otherwise
   the claim holds `/aldine-users` and nobody matches), *Add to ID token* on.
   With *Add to ID token* off and *Add to userinfo* on, Aldine reads the
   groups from userinfo instead.

```
OIDC_ISSUER=https://keycloak.example.com/realms/<realm>
OIDC_CLIENT_ID=aldine
OIDC_CLIENT_SECRET=<client secret>
OIDC_LABEL=Keycloak
```

Keycloak sends `email_verified` from the user's *Email verified* switch; users
created by an admin start unverified. Turn the switch on before they first
sign in to Aldine, or give them the *Verify Email* required action so Keycloak
verifies the address during that first sign-in. An account created without a
verified address gets it at the first later sign-in that brings one.

### Authentik

1. **Applications → Providers → Create → OAuth2/OpenID Provider**. Client type
   *Confidential*, redirect URI (strict)
   `https://aldine.example.com/api/auth/oauth/oidc/callback`.
2. **Signing Key**: pick a certificate (for example *authentik Self-signed
   Certificate*). Without one, Authentik signs ID tokens with HS256 and the
   client secret, which Aldine refuses.
3. **Applications → Create**: name *Aldine*, slug `aldine`, provider from
   step 1.
4. Copy the client ID and secret from the provider.

```
OIDC_ISSUER=https://auth.example.com/application/o/aldine/
OIDC_CLIENT_ID=<client id>
OIDC_CLIENT_SECRET=<client secret>
OIDC_LABEL=Authentik
```

The issuer ends in the application slug and a slash; the provider page shows
it as *OpenID Configuration Issuer*. The default *profile* scope mapping
includes a `groups` claim. Renaming the application slug changes the issuer
(see [Changing `OIDC_ISSUER`](#changing-oidc_issuer)).

Check which `email_verified` value your Authentik version sends (the
provider's *Preview* tab shows the claims). Authentik does not verify
addresses itself, and depending on the version its email mapping reports
either `false` for everyone or `true` for everyone. `true` for everyone is
the same as `OIDC_EMAIL_VERIFIED=trust`, and so is changing the mapping to
send `true`. Both are safe only when users cannot change their own address:
remove the email field from the user settings flow's prompt stage (or turn
off *Allow users to change email* under **System → Settings**, where your
version has it). If users can change it, keep `email_verified` false: people
then sign in without an address on their Aldine account.

### Authelia

Verified against Authelia 4.39.28 on 2026-09-23 (confidential client; email,
name and groups came from userinfo).

In `configuration.yml` (Authelia 4.38 or later), with the secret stored as a
digest (`authelia crypto hash generate pbkdf2 --variant sha512`):

```yaml
identity_providers:
  oidc:
    clients:
      - client_id: 'aldine'
        client_name: 'Aldine'
        client_secret: '$pbkdf2-sha512$310000$...'
        public: false
        authorization_policy: 'two_factor'
        require_pkce: true
        pkce_challenge_method: 'S256'
        redirect_uris:
          - 'https://aldine.example.com/api/auth/oauth/oidc/callback'
        scopes: ['openid', 'email', 'profile', 'groups']
        response_types: ['code']
        grant_types: ['authorization_code']
        token_endpoint_auth_method: 'client_secret_basic'
```

```
OIDC_ISSUER=https://auth.example.com
OIDC_CLIENT_ID=aldine
OIDC_CLIENT_SECRET=<the secret, not the digest>
OIDC_SCOPES=openid email profile groups
OIDC_LABEL=Authelia
```

Authelia 4.39 and later keep email, name and groups out of the ID token and
serve them from the userinfo endpoint; Aldine reads them from there.

`two_factor` stops everyone who has not registered a second factor at
Authelia; use `one_factor` to try the setup first. Authelia only serves
https, so an Authelia with a self-signed or internal certificate also needs
[`NODE_EXTRA_CA_CERTS`](#a-private-ca-or-a-self-signed-certificate) on
Aldine.

### Pocket ID

1. **Administration → OIDC Clients → Add OIDC client**. Name *Aldine*,
   callback URL `https://aldine.example.com/api/auth/oauth/oidc/callback`.
   Turn on *PKCE*. Turn on *Public client* only if you will not use a secret.
2. Copy the client ID and, for a confidential client, the secret (shown once).
3. Optional: restrict the client to user groups in Pocket ID itself, or list
   them in `OIDC_ALLOWED_GROUPS`.

```
OIDC_ISSUER=https://id.example.com
OIDC_CLIENT_ID=<client id>
OIDC_CLIENT_SECRET=<client secret>   # omit for a public client
OIDC_SCOPES=openid email profile groups
OIDC_LABEL=Pocket ID
```

The issuer is Pocket ID's public URL (`APP_URL`) with no path.

Pocket ID reports addresses as verified, including ones users set on their
own account page. Before relying on the address for invites or
`ALDINE_ADMIN_EMAILS`, turn off self-service account editing in Pocket ID's
**Application Configuration**, so only an administrator can change an
address.

### Dex

Verified against Dex v2.41.1 on 2026-09-23 (public and confidential client,
static password connector).

In Dex's `config.yaml`:

```yaml
staticClients:
  - id: aldine
    name: Aldine
    secret: <client secret>          # leave out and set `public: true` for a public client
    redirectURIs:
      - 'https://aldine.example.com/api/auth/oauth/oidc/callback'
```

```
OIDC_ISSUER=https://dex.example.com/dex
OIDC_CLIENT_ID=aldine
OIDC_CLIENT_SECRET=<client secret>   # omit for a public client
OIDC_LABEL=Dex
```

The issuer is Dex's `issuer` setting, usually with no trailing slash. Groups
come only from connectors that provide them (LDAP, GitHub, …) and only with
the `groups` scope (`OIDC_SCOPES=openid email profile groups`). The static
password connector sends none, so `OIDC_ALLOWED_GROUPS` turns everyone away
with it.

## Troubleshooting

| Message | Cause |
|---|---|
| `… is unavailable: the identity provider at … could not be reached (…)` | Aldine cannot fetch `<issuer>/.well-known/openid-configuration`: a firewall between Aldine and the IdP, a wrong port, or the IdP is down. The bracket holds the network error (`ECONNREFUSED`, `ETIMEDOUT`, …). Failed lookups are retried after 15 seconds. |
| `… presented a TLS certificate that is not trusted (…)` | The IdP's certificate is self-signed or from an internal CA. Set [`NODE_EXTRA_CA_CERTS`](#a-private-ca-or-a-self-signed-certificate). `ERR_TLS_CERT_ALTNAME_INVALID` means the certificate is for another host name. |
| `… could not be found (ENOTFOUND): its host name does not resolve` | The host in `OIDC_ISSUER` does not resolve from the Aldine server or container (an internal name, or a typo). |
| `… answered with a redirect — use the final URL` | `OIDC_ISSUER` redirects (often `http` to `https`, or a missing path). Use the URL it redirects to. |
| `… the discovery document names issuer "…", not … — check OIDC_ISSUER` | `OIDC_ISSUER` differs from the issuer the IdP publishes (often `http` vs `https`, or a missing path). Copy it from the IdP. |
| `… must use https` | The issuer or an endpoint in the discovery document is plain `http` on a host other than `localhost`. |
| `… signs ID tokens only with algorithms Aldine does not accept` | The IdP signs with HS256 (Authentik without a signing key). Give it an RSA or EC key. |
| `… the ID token signature could not be verified` | The token is signed with a key or algorithm not in the IdP's JWKS or discovery document. |
| `… the identity provider's signing keys could not be fetched from … (…)` | Discovery worked, but the JWKS URL did not answer, answered with an error or a redirect, or timed out. Check that Aldine can reach that URL. |
| `… the ID token is dated in the future (iat claim) — check that the clocks …` | The IdP's clock is more than a minute ahead of Aldine's. Sync both with NTP. |
| `… the ID token has expired (… claim) — check that the clocks …` | The token is past its `exp`, or more than 10 minutes old by Aldine's clock: Aldine's clock runs ahead of the IdP's, or the sign-in took very long. |
| `… the response did not name its identity provider (iss parameter missing)` | The IdP advertises RFC 9207 `iss` but the callback had none; something between the IdP and Aldine rewrote the redirect. |
| `… the ID token was rejected (aud claim)` | `OIDC_CLIENT_ID` is not the client the token was issued to. |
| `… the identity provider refused the sign-in (invalid_client …)` | Wrong `OIDC_CLIENT_SECRET`, or a secret set for a public client (or the other way round). Some IdPs say it in their own words, for example Dex's "Invalid client credentials." |
| `… your account is not in a group that may use this Aldine instance` | `OIDC_ALLOWED_GROUPS` is set and the person's groups claim (checked in the ID token, then userinfo) names none of them. Check `OIDC_GROUPS_CLAIM`, and that the IdP sends groups (Keycloak needs a mapper; Authelia and Pocket ID need the `groups` scope). |
| `OAuth state mismatch — please try again` | The sign-in took more than 10 minutes, cookies are blocked, or the callback was opened in another browser. |
| `An account with this email already exists — sign in with your password instead.` | The address belongs to a password account; single sign-on never takes it over. |
| `An account with this email already belongs to a different single sign-on identity — ask the administrator for help.` | Usually `OIDC_ISSUER` changed. See [Changing `OIDC_ISSUER`](#changing-oidc_issuer) for how to move the account. |
| `This account signs in with single sign-on, which manages its password.` | Someone tried to set a password on an OIDC account through the API. Single sign-on accounts have no password. |
| `[aldine] OIDC sign-in is off: OIDC_CLIENT_ID is not set` in the boot log | Some `OIDC_*` variables are set but not both required ones. Check the spelling. |
| The IdP reports `redirect_uri` mismatch | The redirect URI at the IdP differs from `<ALDINE_PUBLIC_URL>/api/auth/oauth/oidc/callback` (check the path prefix and trailing slashes). |

Not supported yet: several OIDC providers at once, making someone an
administrator through a group, and signing out of the IdP when signing out of
Aldine.
