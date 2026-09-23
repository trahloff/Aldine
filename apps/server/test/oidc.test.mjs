/**
 * Generic OIDC sign-in against the in-process mock IdP (e2e/auth-tests/
 * mock-oidc.mjs): discovery for an issuer with a path, the PKCE + nonce
 * authorization request, every ID-token rejection the provider promises,
 * the email_verified policy, OIDC_ALLOWED_GROUPS, client authentication, and
 * the find-or-create rules for OIDC subjects.
 *
 * Env must be set before any src import — AUTH_ENABLED and the data/meta
 * roots are read at module load; the OIDC_* variables are read per call.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq, throws } from './assert.mjs';
import { createMockOidc } from '../../../e2e/auth-tests/mock-oidc.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-oidc-'));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
for (const k of Object.keys(process.env)) if (k.startsWith('OIDC_')) delete process.env[k];

const { initDb, db } = await import('../src/db/index.ts');
await initDb();
const oauth = await import('../src/oauth.ts');
const oidcMod = await import('../src/oidc.ts');
const auth = await import('../src/auth.ts');

// ---- configuration ----
check(!oauth.getProvider('oidc'), 'oidc is off without OIDC_ISSUER / OIDC_CLIENT_ID');
eq(oidcMod.oidcConfig({ OIDC_ISSUER: 'https://i', OIDC_CLIENT_ID: 'c' }), {
  issuer: 'https://i', clientId: 'c', clientSecret: null, label: 'Single sign-on', scopes: 'openid email profile',
  allowedGroups: [], groupsClaim: 'groups', trustEmail: false,
}, 'defaults');
eq(oidcMod.oidcConfig({ OIDC_ISSUER: 'https://i', OIDC_CLIENT_ID: 'c', OIDC_SCOPES: 'email groups', OIDC_ALLOWED_GROUPS: ' a, b ,', OIDC_EMAIL_VERIFIED: 'trust', OIDC_LABEL: 'Keycloak' }).scopes, 'openid email groups', 'openid is always requested, first');
eq(oidcMod.oidcConfig({ OIDC_ISSUER: 'https://i', OIDC_CLIENT_ID: 'c', OIDC_ALLOWED_GROUPS: ' a, b ,' }).allowedGroups, ['a', 'b'], 'group list is trimmed');
check(oidcMod.oidcConfig({ OIDC_ISSUER: 'https://i', OIDC_CLIENT_ID: 'c', OIDC_EMAIL_VERIFIED: 'trust' }).trustEmail, 'trust mode');
eq(oidcMod.groupsOf('staff'), ['staff'], 'a bare string is one group');
eq(oidcMod.groupsOf(['a', 1, 'b']), ['a', 'b'], 'non-strings dropped');
eq(oidcMod.groupsOf(undefined), null, 'absent claim');
check(oidcMod.oidcSubject('https://a/', 'x') !== oidcMod.oidcSubject('https://b/', 'x'), 'same sub at another issuer is another subject');
check(oidcMod.oidcSubject('https://a/', 'x').startsWith('oidc:'), 'subject is oidc-prefixed');

// ---- boot warnings for a configuration that would otherwise do nothing ----
eq(oidcMod.oidcConfigWarnings({}), [], 'no OIDC_* variables, no warning');
eq(oidcMod.oidcConfigWarnings({ OIDC_ISSUER: 'https://i', OIDC_CLIENT_ID: 'c' }), [], 'complete configuration, no warning');
{
  const w = oidcMod.oidcConfigWarnings({ OIDC_ISSUER: 'https://i', OIDC_CLIENTID: 'c', OIDC_CLIENT_SECRET: 'hunter2' });
  eq(w.length, 1, 'a misspelled client id warns');
  check(w[0].includes('OIDC_CLIENT_ID is not set') && w[0].includes('OIDC_CLIENTID'), `names the missing and the found variables (${w[0]})`);
  check(!w[0].includes('hunter2'), 'never prints a value');
}
check(oidcMod.oidcConfigWarnings({ OIDC_CLIENT_SECRET: 's' })[0].includes('OIDC_ISSUER and OIDC_CLIENT_ID are not set'), 'a lone secret warns about both');
check(oidcMod.oidcConfigWarnings({ OIDC_ISSUER: 'https://i', OIDC_CLIENT_ID: 'c', OIDC_EMAIL_VERIFIED: 'false' })[0].includes('neither "require" nor "trust"'), 'an unknown OIDC_EMAIL_VERIFIED warns');
eq(oidcMod.oidcConfigWarnings({ OIDC_ISSUER: 'https://i', OIDC_CLIENT_ID: 'c', OIDC_EMAIL_VERIFIED: 'Trust' }), [], 'known values in any case do not warn');

// ---- boot line: issuer, client and client type, never the secret ----
eq(oidcMod.oidcBootLine({}), null, 'no boot line without OIDC');
{
  const sentinel = 'boot-line-secret-sentinel-7f3a';
  const line = oidcMod.oidcBootLine({ OIDC_ISSUER: 'https://idp.example/realms/x', OIDC_CLIENT_ID: 'aldine-boot', OIDC_CLIENT_SECRET: sentinel });
  check(line.includes('https://idp.example/realms/x') && line.includes('aldine-boot') && line.includes('confidential'), `boot line names issuer, client and type (${line})`);
  check(!line.includes(sentinel), 'boot line never prints the client secret');
  check(oidcMod.oidcBootLine({ OIDC_ISSUER: 'https://idp.example/', OIDC_CLIENT_ID: 'c' }).includes('public, PKCE only'), 'boot line marks a public client');
}

// ---- fetch failures say what went wrong ----
const fetchFail = (code, message = 'x') => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(message), { code }) });
check(oidcMod.describeFetchError(fetchFail('DEPTH_ZERO_SELF_SIGNED_CERT'), 5000).includes('TLS certificate that is not trusted (DEPTH_ZERO_SELF_SIGNED_CERT)'), 'self-signed certificate');
check(oidcMod.describeFetchError(fetchFail('UNABLE_TO_GET_ISSUER_CERT_LOCALLY'), 5000).includes('NODE_EXTRA_CA_CERTS'), 'private CA points at NODE_EXTRA_CA_CERTS');
check(oidcMod.describeFetchError(fetchFail('ERR_TLS_CERT_ALTNAME_INVALID'), 5000).includes('not trusted'), 'wrong host name on the certificate');
check(oidcMod.describeFetchError(fetchFail('ENOTFOUND'), 5000).includes('does not resolve'), 'DNS failure');
check(oidcMod.describeFetchError(fetchFail(undefined, 'unexpected redirect'), 5000).includes('redirect'), 'redirect');
check(oidcMod.describeFetchError(Object.assign(new Error('t'), { name: 'TimeoutError' }), 5000).includes('within 5 seconds'), 'timeout');
check(oidcMod.describeFetchError({ cause: Object.assign(new AggregateError([Object.assign(new Error('r'), { code: 'ECONNREFUSED' })])) }, 5000).includes('(ECONNREFUSED)'), 'the code inside an AggregateError');

// ---- IdP down / unreachable: configured, listed, failing with a sentence ----
const closedPort = await (async () => {
  const net = await import('node:net');
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  await new Promise((r) => srv.close(r));
  return port;
})();
process.env.OIDC_ISSUER = `http://127.0.0.1:${closedPort}/application/o/aldine/`;
process.env.OIDC_CLIENT_ID = 'aldine-e2e';
oidcMod.resetOidcCache();
check(oauth.configuredProviders().some((p) => p.id === 'oidc' && p.label === 'Single sign-on'), 'button shows even when the IdP is unreachable');
await throws(() => oauth.getProvider('oidc').authorizeUrl('s', 'https://app/cb', oauth.attemptFrom(oauth.newAttemptSecret())), 'could not be reached (ECONNREFUSED)', 'unreachable IdP fails with a clear message and the cause');
{
  const http = await import('node:http');
  const redirector = http.createServer((_req, res) => { res.writeHead(302, { location: 'http://localhost:9/' }); res.end(); });
  await new Promise((r) => redirector.listen(0, r));
  process.env.OIDC_ISSUER = `http://localhost:${redirector.address().port}/realms/x`;
  oidcMod.resetOidcCache();
  await throws(() => oauth.getProvider('oidc').authorizeUrl('s', 'https://app/cb', oauth.attemptFrom(oauth.newAttemptSecret())), 'answered with a redirect', 'a redirecting discovery endpoint says so');
  await new Promise((r) => redirector.close(r));
}
process.env.OIDC_ISSUER = 'http://idp.example.test/realms/x';
oidcMod.resetOidcCache();
await throws(() => oauth.getProvider('oidc').authorizeUrl('s', 'https://app/cb', oauth.attemptFrom(oauth.newAttemptSecret())), 'must use https', 'plain http to a non-loopback issuer is refused');

// ---- the mock IdP ----
const mock = await createMockOidc().listen();
const provider = () => oauth.getProvider('oidc');
function configure(over = {}) {
  for (const k of Object.keys(process.env)) if (k.startsWith('OIDC_')) delete process.env[k];
  Object.assign(process.env, { OIDC_ISSUER: mock.issuer, OIDC_CLIENT_ID: 'aldine-e2e', OIDC_CLIENT_SECRET: 'aldine-e2e-secret', ...over });
  for (const [k, v] of Object.entries(over)) if (v === undefined) delete process.env[k];
  oidcMod.resetOidcCache();
}
let n = 0;
function persona(claims = {}, extra = {}) {
  const code = `p${++n}`;
  return mock.addPersona({ code, sub: `sub-${n}`, claims: { name: `Person ${n}`, email: `person${n}@example.org`, email_verified: true, ...claims }, ...extra });
}
/** Drives the whole browser leg: authorize URL → IdP redirect → exchange. */
async function signIn(p, { redirect = 'https://app.test/api/auth/oauth/oidc/callback', attempt = oauth.attemptFrom(oauth.newAttemptSecret()), exchangeAttempt } = {}) {
  const url = new URL(await provider().authorizeUrl('st4te', redirect, attempt));
  url.searchParams.set('persona', p.code);
  const r = await fetch(url, { redirect: 'manual' });
  check(r.status === 302, `IdP redirected (got ${r.status}: ${r.status === 400 ? await r.text() : ''})`);
  const back = new URL(r.headers.get('location'));
  eq(back.searchParams.get('state'), 'st4te', 'state round-trips');
  return provider().exchange(back.searchParams.get('code'), redirect, exchangeAttempt ?? attempt, back.searchParams);
}

configure();
check(mock.issuer.endsWith('/application/o/aldine/'), 'mock issuer has a path and a trailing slash');
const attempt = oauth.attemptFrom(oauth.newAttemptSecret());
const authUrl = new URL(await provider().authorizeUrl('st4te', 'https://app.test/cb', attempt));
eq(authUrl.origin + authUrl.pathname, `${mock.origin}/application/o/authorize/`, 'authorize endpoint comes from discovery under the issuer path');
eq(authUrl.searchParams.get('response_type'), 'code', 'code flow');
eq(authUrl.searchParams.get('scope'), 'openid email profile', 'default scopes');
eq(authUrl.searchParams.get('code_challenge_method'), 'S256', 'PKCE S256');
eq(authUrl.searchParams.get('code_challenge'), attempt.challenge, 'challenge from the attempt');
eq(authUrl.searchParams.get('nonce'), attempt.nonce, 'nonce from the attempt');
check(!authUrl.searchParams.has('code_verifier') && !authUrl.href.includes(attempt.verifier), 'the verifier never leaves the server');
check(attempt.nonce !== attempt.verifier && attempt.challenge !== attempt.verifier, 'nonce and challenge are not the verifier');
eq(oauth.attemptFrom('abc'), oauth.attemptFrom('abc'), 'attempt is a pure function of its secret');

// ---- happy path, confidential client with client_secret_basic ----
const alice = persona({ name: 'Alice Liddell', email: 'Alice@Example.org', groups: ['staff'] });
const prof = await signIn(alice);
eq(prof, { email: 'Alice@Example.org', name: 'Alice Liddell', subject: oidcMod.oidcSubject(mock.issuer, alice.sub) }, 'verified email, name, issuer-bound subject');
eq(mock.state.lastTokenAuth, 'client_secret_basic', 'client_secret_basic by default');

// OIDC_ISSUER without the trailing slash still discovers; tokens are checked against the IdP's spelling.
configure({ OIDC_ISSUER: mock.issuer.replace(/\/$/, '') });
eq((await signIn(alice)).subject, oidcMod.oidcSubject(mock.issuer, alice.sub), 'issuer without trailing slash works and keeps the same subject');

// ---- client authentication ----
mock.state.authMethods = ['client_secret_post'];
configure();
await signIn(alice);
eq(mock.state.lastTokenAuth, 'client_secret_post', 'client_secret_post when discovery offers only that');
mock.state.authMethods = ['client_secret_basic', 'client_secret_post'];
mock.state.clientSecret = null;
configure({ OIDC_CLIENT_SECRET: undefined });
await signIn(alice);
eq(mock.state.lastTokenAuth, 'none', 'public client: no secret, PKCE only');
mock.state.clientSecret = 'aldine-e2e-secret';
configure();
await throws(() => signIn(alice, { exchangeAttempt: oauth.attemptFrom(oauth.newAttemptSecret()) }), 'PKCE verification failed', 'a different verifier is refused by the IdP');

// ---- ID token validation ----
const rejects = [
  ['bad-sig', 'signature could not be verified', 'signature by another key'],
  ['alg-none', 'signature could not be verified', 'alg none'],
  ['hs256', 'signature could not be verified', 'HS256 keyed with the public key'],
  ['wrong-iss', 'iss claim', 'another issuer'],
  ['wrong-aud', 'aud claim', 'another audience'],
  ['multi-aud', 'azp claim', 'several audiences without azp'],
  ['wrong-azp', 'azp claim', 'azp names another client'],
  ['expired', 'has expired', 'expired token'],
  ['future-iat', 'dated in the future (iat claim) — check that the clocks', 'iat in the future points at the clocks'],
  ['wrong-nonce', 'nonce claim', 'nonce from another attempt'],
  ['no-nonce', 'nonce claim', 'missing nonce'],
  ['iss-param', 'different identity provider', 'RFC 9207 iss response parameter from another IdP'],
  ['iss-param-missing', 'iss parameter missing', 'RFC 9207 iss response parameter missing although advertised'],
];
for (const [tamper, msg, what] of rejects) {
  await throws(() => signIn(persona({}, { tamper })), msg, `rejected: ${what}`);
}
// An ID token replayed into another attempt carries that attempt's nonce, not ours.
{
  const p = persona();
  const a1 = oauth.attemptFrom(oauth.newAttemptSecret());
  const url = new URL(await provider().authorizeUrl('s', 'https://app.test/cb', a1));
  url.searchParams.set('persona', p.code);
  const back = new URL((await fetch(url, { redirect: 'manual' })).headers.get('location'));
  const a2 = oauth.attemptFrom(oauth.newAttemptSecret());
  await throws(() => provider().exchange(back.searchParams.get('code'), 'https://app.test/cb', { ...a1, nonce: a2.nonce }, back.searchParams), 'nonce claim', 'a code redeemed under another attempt\'s nonce');
}

mock.state.issParam = false;
configure();
eq((await signIn(persona({ name: 'No iss' }, { tamper: 'iss-param-missing' }))).name, 'No iss', 'no iss parameter is fine from an IdP that does not advertise it');
mock.state.issParam = true;
configure();

// ---- JWKS unreachable after discovery worked: not a signature problem ----
mock.state.jwksDown = true;
configure();
await throws(() => signIn(alice), "signing keys could not be fetched", 'a JWKS outage is reported as such');
mock.state.jwksDown = false;
configure();

// ---- signing algorithms ----
mock.state.algs = undefined;
configure();
eq((await signIn(alice)).name, 'Alice Liddell', 'no advertised algs → RS256 default');
mock.state.algs = ['HS256'];
configure();
await throws(() => signIn(alice), 'algorithms Aldine does not accept', 'an IdP offering only HMAC is refused');
mock.state.algs = ['ES256'];
configure();
await throws(() => signIn(alice), 'signature could not be verified', 'an RS256 token when only ES256 is advertised');
mock.state.algs = ['RS256'];

// ---- discovery ----
mock.state.discoveryIssuer = 'https://evil.example/';
configure();
await throws(() => signIn(alice), 'check OIDC_ISSUER', 'discovery naming another issuer');
mock.state.discoveryIssuer = null;
mock.state.down = true;
configure();
await throws(() => signIn(alice), 'answered 503', 'IdP down: a clear message');
mock.state.down = false;
await throws(() => signIn(alice), 'answered 503', 'a failed discovery is not retried on every click');
oidcMod.resetOidcCache();
eq((await signIn(alice)).name, 'Alice Liddell', 'recovers once the retry window passes');
{
  // After the hourly TTL a failed refresh keeps serving the last good document.
  // Only discover() runs under the shifted clock: jose and the mock keep real time.
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    const good = await oidcMod.discover(mock.issuer);
    offset = 2 * 60 * 60 * 1000;
    mock.state.down = true;
    eq(await oidcMod.discover(mock.issuer), good, 'stale document served while the refresh runs');
    await new Promise((r) => setTimeout(r, 100));
    eq(await oidcMod.discover(mock.issuer), good, 'stale document served after the refresh failed');
    offset += 20_000;
    eq(await oidcMod.discover(mock.issuer), good, 'and after the retry window, while the IdP is still down');
    await new Promise((r) => setTimeout(r, 100));
    mock.state.down = false;
    offset += 20_000;
    await oidcMod.discover(mock.issuer);
    await new Promise((r) => setTimeout(r, 100));
    const hits = mock.state.discoveryHits;
    offset += 20_000;
    eq(await oidcMod.discover(mock.issuer), good, 'a successful refresh is served');
    eq(mock.state.discoveryHits, hits, 'and cached for the next hour');
  } finally {
    Date.now = realNow;
    mock.state.down = false;
  }
  configure();
}

// ---- email_verified policy ----
eq((await signIn(persona({ email_verified: false }))).email, null, 'unverified email is ignored');
eq((await signIn(persona({ email_verified: 'true' }))).email, null, 'only boolean true counts as verified');
eq((await signIn(persona({ email_verified: undefined }))).email, null, 'absent email_verified is not verified');
const unverified = persona({ email_verified: false, name: undefined, preferred_username: 'uv' });
eq((await signIn(unverified)).name, 'uv', 'name falls back to preferred_username');
eq((await signIn(persona({ name: undefined, preferred_username: undefined, email: 'local.part@example.org' }))).name, 'local.part', 'then to the verified email local part');
configure({ OIDC_EMAIL_VERIFIED: 'trust' });
eq((await signIn(unverified)).email, unverified.claims.email, 'OIDC_EMAIL_VERIFIED=trust uses it anyway');
configure();
// Email and its verdict are one pair: the userinfo address never borrows the ID token's.
eq(oidcMod.profileFrom({ iss: 'https://i/', sub: 's', email_verified: true }, { sub: 's', email: 'x@example.org', email_verified: false }, oidcMod.oidcConfig()).email, null, 'userinfo email with its own unverified flag');
eq(oidcMod.profileFrom({ iss: 'https://i/', sub: 's' }, { sub: 's', email: 'x@example.org', email_verified: true }, oidcMod.oidcConfig()).email, 'x@example.org', 'userinfo supplies a verified email the ID token lacks');

// ---- OIDC_ALLOWED_GROUPS ----
configure({ OIDC_ALLOWED_GROUPS: 'aldine-users, staff' });
eq((await signIn(alice)).name, 'Alice Liddell', 'member via array claim');
eq((await signIn(persona({ groups: 'aldine-users' }))).email !== undefined, true, 'member via string claim');
await throws(() => signIn(persona({ groups: ['other'] })), 'not in a group', 'non-member denied');
await throws(() => signIn(persona({ groups: undefined })), 'not in a group', 'no groups claim anywhere denied');
eq((await signIn(persona({ groups: ['staff'] }, { groupsInUserinfo: true }))).name.startsWith('Person'), true, 'groups from userinfo when the ID token has none');
await throws(() => signIn(persona({ groups: ['staff'] }, { groupsInUserinfo: true, tamper: 'userinfo-other-sub' })), 'not in a group', 'userinfo for another sub is ignored');
configure({ OIDC_ALLOWED_GROUPS: 'aldine', OIDC_GROUPS_CLAIM: 'roles' });
eq((await signIn(persona({ roles: ['aldine'] }))).email !== null, true, 'OIDC_GROUPS_CLAIM names the claim');
await throws(() => signIn(persona({ groups: ['aldine'] })), 'not in a group', 'the default claim is not consulted when another is named');
configure();

// ---- find-or-create ----
const first = await auth.findOrCreateOAuth(await signIn(alice), 'oidc');
eq(first.email, 'alice@example.org', 'account created with the verified address');
eq(first.provider, 'oidc', 'provider oidc');
eq((await auth.findOrCreateOAuth(await signIn(alice), 'oidc')).id, first.id, 'second sign-in lands in the same account');

await auth.register('victim@example.org', 'password123', 'Victim');
const sneaky = persona({ email: 'victim@example.org', email_verified: false });
const sneakyUser = await auth.findOrCreateOAuth(await signIn(sneaky), 'oidc');
eq(sneakyUser.email, null, 'an unverified address does not link to the password account');
check((await db().findUserByEmail('victim@example.org')).hash, 'the password account is untouched');
eq((await auth.findOrCreateOAuth(await signIn(sneaky), 'oidc')).id, sneakyUser.id, 'the email-less account is found again by subject');
await throws(async () => auth.findOrCreateOAuth(await signIn(persona({ email: 'victim@example.org' })), 'oidc'), 'sign in with your password', 'a verified address never takes over a password account');
await throws(async () => auth.findOrCreateOAuth(await signIn(persona({ email: 'alice@example.org' })), 'oidc'), 'a different single sign-on identity', 'another OIDC identity with the same address is not merged (label lowercased mid-sentence)');
configure({ OIDC_EMAIL_VERIFIED: 'trust' });
await throws(async () => auth.findOrCreateOAuth(await signIn(persona({ email: 'alice@example.org', email_verified: false })), 'oidc'), 'different single sign-on identity', 'trust mode cannot claim someone else\'s account by typing their address');
configure();

// ---- the address arrives after the first sign-in ----
{
  const late = persona({ email: 'late@example.org', email_verified: false });
  const before = await auth.findOrCreateOAuth(await signIn(late), 'oidc');
  eq(before.email, null, 'created without the unverified address');
  const verifiedLater = mock.addPersona({ ...late, code: `${late.code}-v`, claims: { ...late.claims, email_verified: true } });
  const after = await auth.findOrCreateOAuth(await signIn(verifiedLater), 'oidc');
  eq([after.id, after.email], [before.id, 'late@example.org'], 'the same account takes the address once it is verified');
  const changed = mock.addPersona({ ...late, code: `${late.code}-c`, claims: { ...late.claims, email: 'changed@example.org', email_verified: true } });
  eq((await auth.findOrCreateOAuth(await signIn(changed), 'oidc')).email, 'late@example.org', 'an address already on the account is kept');
  const taken = mock.addPersona({ ...sneaky, code: `${sneaky.code}-v`, claims: { ...sneaky.claims, email_verified: true } });
  eq((await auth.findOrCreateOAuth(await signIn(taken), 'oidc')).email, null, 'an address another account holds is not copied');
}

// ---- single sign-on accounts never get a password ----
{
  const ssoUser = await db().getUser(first.id);
  await throws(() => auth.changePassword(first.id, '', 'contractor-pw'), 'This account signs in with single sign-on', 'no password for an OIDC account, even with an empty current password');
  eq((await db().getUser(first.id)).hash, ssoUser.hash, 'hash untouched');
  eq(await auth.requestReset('alice@example.org'), null, 'no reset token for an OIDC account');
  await db().createReset('sso-reset-token', first.id, Date.now() + 60_000);
  await throws(() => auth.resetPassword('sso-reset-token', 'contractor-pw'), 'signs in with', 'an outstanding reset token cannot give it one either');
  await db().updateUser({ ...ssoUser, salt: 'aa', hash: 'bb' });
  await throws(() => auth.login('alice@example.org', 'anything'), 'Incorrect email or password', 'password login refuses an OIDC account even if a hash exists');
  await db().updateUser(ssoUser);
}

configure({ OIDC_LABEL: 'Keycloak' });
eq(oauth.configuredProviders().find((p) => p.id === 'oidc').label, 'Keycloak', 'OIDC_LABEL is the provider label');
await throws(async () => auth.findOrCreateOAuth({ email: 'alice@example.org', name: 'A' }, 'github'), 'sign in with Keycloak', 'the refusal names the provider by its label');

await mock.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('OIDC sign-in: ALL PASSED');
