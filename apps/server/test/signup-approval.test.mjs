/**
 * ALDINE_SIGNUP=approval: every account created from then on waits until an
 * administrator approves it on /admin.
 *  - password sign-up: no session; the welcome mail and the reply say the
 *    account waits; sign-in is refused with its own message (403, code
 *    awaiting-approval), and only after the right password
 *  - the confirmation link used on the sign-in form confirms the address and
 *    mails every administrator once; an unconfirmed address mails nobody
 *  - single sign-on: the first sign-in creates a waiting account, mails the
 *    administrators and ends on a "Waiting for approval" page
 *  - an address on ALDINE_ADMIN_EMAILS: a provider's never waits; a typed
 *    one waits until its link confirms it, then the account approves itself
 *  - an invitation does not skip approval; a reset link confirms the
 *    address and mails the administrators like the confirmation link
 *  - Enable on /admin approves (logged as "approved", mailed to the person);
 *    enabling an account an administrator disabled mails nobody
 *  - accounts from before, and accounts an administrator disabled, are not
 *    touched by the mode
 *  - stats count and rows mark the waiting accounts; boot warnings
 *
 * Real routes (Fastify inject), the real SMTP backend against a local SMTP
 * listener, and mock-oidc for single sign-on; env is set before any src
 * import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { check, eq } from './assert.mjs';
import { startSmtp, decoded } from './smtp-mock.mjs';
import { createMockOidc } from '../../../e2e/auth-tests/mock-oidc.mjs';

const smtp = await startSmtp();
const mock = await createMockOidc().listen();

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-signup-approval-')));
for (const k of Object.keys(process.env)) if (/^(OIDC_|GOOGLE_OAUTH_|GITHUB_LOGIN_|ORCID_)/.test(k)) delete process.env[k];
for (const k of ['DATABASE_URL', 'REDIS_URL', 'SES_FROM', 'SMTP_USER', 'SMTP_SECURE', 'ALDINE_SSO_ONLY', 'ALDINE_RESET_ECHO', 'ALDINE_BASE_PATH', 'ALDINE_PROTECTED_PROJECTS', 'SENTRY_DSN']) delete process.env[k];
Object.assign(process.env, {
  AUTH_ENABLED: '1',
  ALDINE_SIGNUP: 'approval',
  ALDINE_ADMIN_EMAILS: 'root@example.org,second@example.org',
  ALDINE_PUBLIC_URL: 'https://aldine.test',
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: String(smtp.port),
  RL_REGISTER_BURST: '200',
  RL_LOGIN_BURST: '200',
  RL_ADMIN_BURST: '200',
  DATA_DIR: path.join(tmp, 'data'),
  META_DIR: path.join(tmp, 'meta'),
  CACHE_DIR: path.join(tmp, 'cache'),
  OIDC_ISSUER: mock.issuer,
  OIDC_CLIENT_ID: 'aldine-e2e',
  OIDC_CLIENT_SECRET: 'aldine-e2e-secret',
});

const logs = [];
const realLog = console.log;
console.log = (...a) => { logs.push(a.join(' ')); realLog(...a); };
const logged = (needle) => logs.some((l) => l.includes(needle));

const { initDb, db } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;
const app = Fastify({ logger: false });
await registerRoutes(app);
await app.ready();

const cookieOf = (res) => [].concat(res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).find((c) => c.startsWith(`${auth.COOKIE}=`));
const call = (method, url, cookie, payload, headers = {}) => app.inject({ method, url, headers: { ...(cookie ? { cookie } : {}), ...headers }, ...(payload !== undefined ? { payload } : {}) });
const register = (email, name = 'New person') => call('POST', '/api/auth/register', null, { email, password: 'password123', name });
const login = (email, password = 'password123', confirmToken) => call('POST', '/api/auth/login', null, { email, password, ...(confirmToken ? { confirmToken } : {}) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Mails so far, decoded (a quoted-printable link is not the link), with the recipient from the To header. */
const mails = () => smtp.mails.map((raw) => ({ to: /^To: (.+)$/mi.exec(raw)?.[1]?.trim() ?? '', text: decoded(raw) }));
async function mailTo(to, needle, ms = 10_000) {
  const end = Date.now() + ms;
  for (;;) {
    const m = mails().find((x) => x.to === to && x.text.includes(needle));
    if (m) return m;
    if (Date.now() > end) throw new Error(`no mail to ${to} containing ${JSON.stringify(needle)}; got ${JSON.stringify(mails().map((x) => x.to))}`);
    await sleep(25);
  }
}
const countTo = (to, needle) => mails().filter((x) => x.to === to && x.text.includes(needle)).length;
/** Give a mail that should not be sent the time to arrive anyway. */
const settle = () => sleep(400);
const linkToken = (text, param) => new RegExp(`https://aldine\\.test/\\?${param}=([A-Za-z0-9_-]{20,})`).exec(text)?.[1];

// ---- accounts from before the mode, written as an older server left them ----
const hashOf = (password, salt) => crypto.scryptSync(password, salt, 64).toString('hex');
const before = '2026-01-05T09:00:00.000Z';
await db().createUser({ id: 'old-one', email: 'old@example.org', name: 'Old', salt: 'aa', hash: hashOf('password123', 'aa'), createdAt: before });
await db().createUser({ id: 'off-one', email: 'off@example.org', name: 'Off', salt: 'bb', hash: hashOf('password123', 'bb'), createdAt: before, disabledAt: '2026-02-01T10:00:00.000Z' });
{
  const old = await login('old@example.org');
  eq(old.statusCode, 200, `an account from before signs in (${old.body})`);
  check(cookieOf(old), 'and gets a session');
  const off = await login('off@example.org');
  eq(off.statusCode, 401, 'an account an administrator disabled stays disabled');
  eq(off.json().error, auth.ACCOUNT_DISABLED, 'with the disabled message, not the approval one');
}

eq((await call('GET', '/api/auth/me')).json().signup, 'approval', '/api/auth/me tells the sign-up form');

// ---- password sign-up waits ----
const evilName = 'Mallory <a href="https://evil.example/">Approve me</a>';
const reg = await register('newbie@example.org', evilName);
eq(reg.statusCode, 200, `sign-up succeeds (${reg.body})`);
eq(reg.json().awaitingApproval, true, 'the reply says the account waits');
check(!cookieOf(reg), 'a waiting account gets no session');
eq(reg.json().message, `Your account is created. Confirm your email address with the link we sent to newbie@example.org. ${auth.AWAITING_APPROVAL}`, 'the reply says what happens next');
const newbie = await db().findUserByEmail('newbie@example.org');
check(auth.awaitingApproval(newbie) && newbie.disabledAt === newbie.createdAt, 'the account is marked as waiting');
const welcome = await mailTo('newbie@example.org', 'confirm_email=');
check(welcome.text.includes('then an administrator of this server approves the account'), 'the welcome mail says an administrator approves it');
const newbieLink = linkToken(welcome.text, 'confirm_email');
check(newbieLink, 'the welcome mail carries the link');
await settle();
eq(countTo('root@example.org', 'newbie@example.org'), 0, 'an address nobody confirmed mails no administrator');
check(!logged('waiting for approval: newbie@example.org'), 'nor is it announced in the log');

{
  const wrong = await login('newbie@example.org', 'not-the-password');
  eq([wrong.statusCode, wrong.json().error], [401, 'Incorrect email or password'], 'a wrong password learns nothing about the account');
  const right = await login('newbie@example.org');
  eq(right.statusCode, 403, 'the right password: refused with 403');
  eq(right.json(), { error: auth.AWAITING_APPROVAL, code: 'awaiting-approval' }, 'with the approval message and its code');
  check(!cookieOf(right), 'and no session');
  const wrongWithLink = await login('newbie@example.org', 'not-the-password', newbieLink);
  eq(wrongWithLink.statusCode, 401, 'the link without the password does nothing');
  const badLink = await login('newbie@example.org', 'password123', 'not-a-link');
  eq(badLink.statusCode, 403, 'a bad link: still waiting');
  check(badLink.json().error.startsWith('This confirmation link has expired') && badLink.json().error.endsWith(auth.AWAITING_APPROVAL), `says both (${badLink.body})`);
  check((await db().getUser(newbie.id)).emailPending, 'the address is still not confirmed');
}

// The link opened on the sign-in form: the password proves the account.
{
  const r = await login('newbie@example.org', 'password123', newbieLink);
  eq(r.statusCode, 403, 'confirming does not sign in a waiting account');
  eq(r.json().error, `Your email address is confirmed. ${auth.AWAITING_APPROVAL}`, 'it says the address is confirmed and the account waits');
  check(!cookieOf(r), 'no session');
  const u = await db().getUser(newbie.id);
  check(!u.emailPending && auth.awaitingApproval(u), 'the address is confirmed, the account still waits');
  for (const admin of ['root@example.org', 'second@example.org']) {
    const m = await mailTo(admin, 'newbie@example.org (signs in with a password)');
    check(m.text.includes('https://aldine.test/admin'), `the mail to ${admin} links to the admin page`);
    for (const part of ['evil.example', 'Approve me', 'Mallory']) check(!m.text.includes(part), `the mail to ${admin} carries nothing of the name (found ${part})`);
  }
  check(logged('[aldine] new account waiting for approval: newbie@example.org'), 'the log says an account waits');
  const again = await login('newbie@example.org', 'password123', newbieLink);
  eq(again.json().error, auth.AWAITING_APPROVAL, 'the spent link: just the approval message');
  await settle();
  eq(countTo('root@example.org', 'newbie@example.org'), 1, 'and no second mail to the administrators');
}

// ---- an administrator's typed address waits until its link confirms it ----
let root;
{
  const r = await register('root@example.org', 'Root');
  eq(r.json().awaitingApproval, true, 'a typed admin address waits too: anyone could have typed it');
  eq(r.json().message, `Your account is created. Confirm your email address with the link we sent to root@example.org. ${auth.AWAITING_APPROVAL}`, 'with the same reply as anyone else');
  eq((await login('root@example.org')).statusCode, 403, 'without the link it is refused');
  const link = linkToken((await mailTo('root@example.org', 'confirm_email=')).text, 'confirm_email');
  const ok = await login('root@example.org', 'password123', link);
  eq(ok.statusCode, 200, `the link confirms the address and the administrator is in (${ok.body})`);
  eq(ok.json().emailConfirmed, true, 'the reply says the link was used');
  root = cookieOf(ok);
  check(root, 'with a session');
  const u = await db().findUserByEmail('root@example.org');
  check(!u.disabledAt && !u.emailPending, 'approved and confirmed');
  check(!logged('waiting for approval: root@example.org'), 'an administrator is never announced');
  eq((await call('GET', '/api/auth/me', root)).json().admin, true, 'and is an administrator');
}

// ---- single sign-on ----
const REDIRECT = 'https://aldine.test/api/auth/oauth/oidc/callback';
/** Through mock-oidc as `code`; the callback's reply. */
async function sso(code, accept = 'application/json') {
  const res = await call('GET', '/api/auth/oauth/oidc');
  eq(res.statusCode, 302, 'start redirects to the IdP');
  const state = [].concat(res.headers['set-cookie']).find((c) => c.startsWith('aldine_oauth_state=')).split(';')[0];
  const loc = new URL(res.headers.location);
  eq(loc.searchParams.get('redirect_uri'), REDIRECT, 'redirect URI');
  loc.searchParams.set('persona', code);
  const idp = await fetch(loc, { redirect: 'manual' });
  const back = new URL(idp.headers.get('location'));
  return call('GET', `/api/auth/oauth/oidc/callback${back.search}`, state, undefined, { accept });
}
mock.addPersona({ code: 'sam', sub: 'sam-1', claims: { name: 'Sam <b>Spam</b>', email: 'sam@example.org', email_verified: true } });
mock.addPersona({ code: 'second', sub: 'second-1', claims: { name: 'Second', email: 'second@example.org', email_verified: true } });
{
  const first = await sso('sam', 'text/html');
  eq(first.statusCode, 403, `the first sign-in creates a waiting account (${first.body.slice(0, 200)})`);
  check(!cookieOf(first), 'no session');
  check(first.body.includes('<h1>Waiting for approval</h1>') && first.body.includes('<title>Waiting for approval · Aldine</title>'), 'the page is titled for it');
  check(first.body.includes(`data-testid="sign-in-error">Your account is created. ${auth.AWAITING_APPROVAL}`), 'and says what happens next');
  const sam = await db().findUserByEmail('sam@example.org');
  check(sam && auth.awaitingApproval(sam) && !sam.emailPending, 'a waiting account with the provider\'s address');
  for (const admin of ['root@example.org', 'second@example.org']) {
    const m = await mailTo(admin, 'sam@example.org (signs in with single sign-on)');
    check(!m.text.includes('Spam'), `no display name in the mail to ${admin}`);
  }
  const later = await sso('sam');
  eq([later.statusCode, later.json().error], [403, auth.AWAITING_APPROVAL], 'a later sign-in gets the approval message');
  await settle();
  eq(countTo('root@example.org', 'sam@example.org'), 1, 'and mails nobody again');

  const second = await sso('second');
  eq(second.statusCode, 302, 'a provider\'s address on the admin list never waits');
  check(cookieOf(second), 'and signs in');
  check(!logged('waiting for approval: second@example.org'), 'without an announcement');
}

// ---- an invitation does not skip approval ----
{
  const project = (await call('POST', '/api/projects', root, { name: 'Shared' })).json();
  eq((await call('POST', `/api/projects/${project.id}/invitations`, root, { to: 'invitee@example.org' })).statusCode, 200, 'invite an address');
  eq((await register('invitee@example.org', 'Invitee')).json().awaitingApproval, true, 'the invited person waits like anyone else');
}

// ---- a reset link confirms the address, and announces the account ----
{
  eq((await register('resetter@example.org', 'Resetter')).json().awaitingApproval, true, 'another waiting sign-up');
  eq((await call('POST', '/api/auth/reset-request', null, { email: 'resetter@example.org' })).statusCode, 200, 'asks for a reset link');
  const token = linkToken((await mailTo('resetter@example.org', 'reset_token=')).text, 'reset_token');
  eq((await call('POST', '/api/auth/reset', null, { token, newPassword: 'another-pass-1' })).statusCode, 200, 'resets the password');
  await mailTo('root@example.org', 'resetter@example.org (signs in with a password)');
  const r = await login('resetter@example.org', 'another-pass-1');
  eq([r.statusCode, r.json().error], [403, auth.AWAITING_APPROVAL], 'the new password still waits for approval');
}

// ---- /admin: counted, marked, approved ----
{
  const stats = (await call('GET', '/api/admin/stats', root)).json();
  eq(stats.users.awaitingApproval, 4, 'stats count the waiting accounts (newbie, sam, invitee, resetter)');
  const rows = (await call('GET', '/api/admin/users', root)).json();
  const row = (email) => rows.find((u) => u.email === email);
  eq(rows.filter((u) => u.awaitingApproval).map((u) => u.email).sort(), ['invitee@example.org', 'newbie@example.org', 'resetter@example.org', 'sam@example.org'], 'rows mark exactly those');
  eq([row('off@example.org').awaitingApproval, !!row('off@example.org').disabledAt], [false, true], 'an account an administrator disabled is disabled, not waiting');
  eq(row('old@example.org').awaitingApproval, false, 'an account from before does not wait');

  const approved = await call('POST', `/api/admin/users/${newbie.id}/enable`, root, {});
  eq(approved.statusCode, 200, 'Enable approves');
  eq([approved.json().awaitingApproval, approved.json().disabledAt], [false, undefined], 'the row is an ordinary account now');
  check(logs.some((l) => l.startsWith('[aldine] admin root@example.org') && l.includes(`approved newbie@example.org [${newbie.id}]`)), 'the log says approved');
  const m = await mailTo('newbie@example.org', 'Your Aldine account is approved');
  check(m.text.includes('An administrator approved your account on the Aldine server at https://aldine.test') && m.text.includes('https://aldine.test/'), 'the person is told, with a link to sign in');
  const r = await login('newbie@example.org');
  eq(r.statusCode, 200, 'the approved account signs in');
  check(cookieOf(r), 'with a session');

  const samRow = row('sam@example.org');
  eq((await call('POST', `/api/admin/users/${samRow.id}/enable`, root, {})).statusCode, 200, 'approve the single sign-on account');
  await mailTo('sam@example.org', 'Your Aldine account is approved');
  eq((await sso('sam')).statusCode, 302, 'and it signs in through the provider');

  // Disable and enable an ordinary account: as before the mode.
  const old = row('old@example.org');
  eq((await call('POST', `/api/admin/users/${old.id}/disable`, root, {})).json().awaitingApproval, false, 'a disabled account does not wait');
  eq((await login('old@example.org')).json().error, auth.ACCOUNT_DISABLED, 'it gets the disabled message');
  const before = smtp.mails.length;
  eq((await call('POST', `/api/admin/users/${old.id}/enable`, root, {})).statusCode, 200, 'enable it again');
  check(logs.some((l) => l.includes(`enabled old@example.org [${old.id}]`)), 'logged as enabled, not approved');
  await settle();
  eq(smtp.mails.length, before, 'enabling a disabled account mails nobody');
  eq((await login('old@example.org')).statusCode, 200, 'and it signs in');
  eq((await call('GET', '/api/admin/stats', root)).json().users.awaitingApproval, 2, 'two accounts still wait');
}

// ---- configuration ----
eq(auth.signupMode({}), 'open', 'unset means open');
eq(auth.signupMode({ ALDINE_SIGNUP: ' Open ' }), 'open', 'open, any case');
eq(auth.signupMode({ ALDINE_SIGNUP: 'APPROVAL' }), 'approval', 'approval, any case');
eq(auth.signupMode({ ALDINE_SIGNUP: 'closed' }), 'approval', 'an unknown value means approval');
eq(auth.signupConfigWarnings({}), [], 'no warning by default');
eq(auth.signupConfigWarnings({ ALDINE_SIGNUP: 'open', AUTH_ENABLED: '1' }), [], 'none for open');
eq(auth.signupConfigWarnings({ ALDINE_SIGNUP: 'approval', AUTH_ENABLED: '1', ALDINE_ADMIN_EMAILS: 'a@b.cd' }), [], 'none for a working approval setup');
eq(auth.signupConfigWarnings({ ALDINE_SIGNUP: 'aproval', AUTH_ENABLED: '1', ALDINE_ADMIN_EMAILS: 'a@b.cd' }), ['[aldine] ALDINE_SIGNUP="aproval" is neither "open" nor "approval"; using "approval"'], 'an unknown value is named');
const empty = auth.signupConfigWarnings({ ALDINE_SIGNUP: 'approval', AUTH_ENABLED: '1', ALDINE_ADMIN_EMAILS: ' , ' });
check(empty.length === 1 && empty[0].includes('ALDINE_ADMIN_EMAILS is empty'), `approval without administrators is warned about (${empty})`);
const noAuth = auth.signupConfigWarnings({ ALDINE_SIGNUP: 'approval', ALDINE_ADMIN_EMAILS: 'a@b.cd' });
check(noAuth.length === 1 && noAuth[0].includes('AUTH_ENABLED is off'), `approval without accounts is warned about (${noAuth})`);

await app.close();
await mock.close();
smtp.close();
console.log = realLog;
fs.rmSync(tmp, { recursive: true, force: true });
console.log('signup-approval: all assertions passed');
process.exit(0);
