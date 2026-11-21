/**
 * Beta onboarding under ALDINE_SIGNUP=approval:
 *  - the sign-up note ("what will you use Aldine for?"): kept on a waiting
 *    password sign-up, cleaned to one line, refused over 500 characters,
 *    quoted in the administrators' mail once the address is confirmed, and
 *    on the /admin rows
 *  - single sign-on: the waiting page takes the note once, with a token
 *    that proves the account; the administrators get it by mail; a forged,
 *    reused or late token changes nothing
 *  - the welcome mail when an administrator approves: sign-in link, three
 *    first steps, the support contact; logged (not lost) without a transport
 *  - the mail builders escape the person's text in HTML
 *
 * Real routes (Fastify inject), the real SMTP backend against a local SMTP
 * listener, and mock-oidc for single sign-on; env is set before any src import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';
import { startSmtp, decoded } from './smtp-mock.mjs';
import { createMockOidc } from '../../../e2e/auth-tests/mock-oidc.mjs';

const smtp = await startSmtp();
const mock = await createMockOidc().listen();

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-signup-note-')));
for (const k of Object.keys(process.env)) if (/^(OIDC_|GOOGLE_OAUTH_|GITHUB_LOGIN_|ORCID_)/.test(k)) delete process.env[k];
for (const k of ['DATABASE_URL', 'REDIS_URL', 'SES_FROM', 'SMTP_USER', 'SMTP_SECURE', 'ALDINE_SSO_ONLY', 'ALDINE_RESET_ECHO', 'ALDINE_BASE_PATH', 'ALDINE_PROTECTED_PROJECTS', 'SENTRY_DSN', 'ALDINE_TEST_HOOKS']) delete process.env[k];
Object.assign(process.env, {
  AUTH_ENABLED: '1',
  ALDINE_SIGNUP: 'approval',
  ALDINE_ADMIN_EMAILS: 'root@example.org',
  ALDINE_PUBLIC_URL: 'https://aldine.test',
  ALDINE_SUPPORT: 'help@aldine.test',
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
const email = await import('../src/email.ts');
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;
const app = Fastify({ logger: false });
await registerRoutes(app);
await app.ready();

const cookieOf = (res) => [].concat(res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).find((c) => c.startsWith(`${auth.COOKIE}=`));
const call = (method, url, cookie, payload, headers = {}) => app.inject({ method, url, headers: { ...(cookie ? { cookie } : {}), ...headers }, ...(payload !== undefined ? { payload } : {}) });
const register = (email, note) => call('POST', '/api/auth/register', null, { email, password: 'password123', name: 'New person', ...(note !== undefined ? { note } : {}) });
const login = (email, confirmToken) => call('POST', '/api/auth/login', null, { email, password: 'password123', ...(confirmToken ? { confirmToken } : {}) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mails = () => smtp.mails.map((raw) => ({ to: /^To: (.+)$/mi.exec(raw)?.[1]?.trim() ?? '', text: decoded(raw).replace(/\r\n/g, '\n') }));
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
const settle = () => sleep(400);
const linkToken = (text) => /https:\/\/aldine\.test\/\?confirm_email=([A-Za-z0-9_-]{20,})/.exec(text)?.[1];

// ---- the administrator ----
let root;
{
  await register('root@example.org');
  const link = linkToken((await mailTo('root@example.org', 'confirm_email=')).text);
  const ok = await login('root@example.org', link);
  eq(ok.statusCode, 200, `the administrator signs in (${ok.body})`);
  root = cookieOf(ok);
}

// ---- a password sign-up with a note ----
const NOTE = 'Thesis group, Example University.\n\tWe write   papers together.';
const CLEAN = 'Thesis group, Example University. We write papers together.';
let ada;
{
  const r = await register('ada@example.org', NOTE);
  eq([r.statusCode, r.json().awaitingApproval], [200, true], `the sign-up waits (${r.body})`);
  ada = await db().findUserByEmail('ada@example.org');
  eq(ada.signupNote, CLEAN, 'the note is kept on one line, without control characters');
  check(!JSON.stringify(r.json()).includes('Thesis group'), 'and is not echoed back');

  const long = await register('long@example.org', 'x'.repeat(auth.NOTE_MAX + 1));
  eq([long.statusCode, long.json().error], [400, 'Keep the note to 500 characters or fewer.'], 'a note over 500 characters is refused');
  eq(await db().findUserByEmail('long@example.org'), null, 'and no account is created');
  eq((await register('exact@example.org', 'y'.repeat(auth.NOTE_MAX))).statusCode, 200, 'exactly 500 characters is fine');
  eq((await register('blank@example.org', '   \n ')).statusCode, 200, 'a blank note is no note');
  eq((await db().findUserByEmail('blank@example.org')).signupNote, undefined, 'and nothing is stored');
  eq((await register('odd@example.org', { not: 'text' })).statusCode, 200, 'a note that is not text is ignored');

  await settle();
  eq(countTo('root@example.org', 'ada@example.org'), 0, 'an unconfirmed address mails no administrator, note or not');
  const link = linkToken((await mailTo('ada@example.org', 'confirm_email=')).text);
  eq((await login('ada@example.org', link)).statusCode, 403, 'confirming leaves it waiting');
  const m = await mailTo('root@example.org', 'ada@example.org (signs in with a password)');
  check(m.text.includes('They wrote what they will use Aldine for (their words, not checked):'), 'the administrators\' mail introduces the note as the person\'s own words');
  check(m.text.includes(`"${CLEAN}"`), 'and quotes it');

  const rows = (await call('GET', '/api/admin/users', root)).json();
  eq(rows.find((u) => u.email === 'ada@example.org').signupNote, CLEAN, '/admin lists the note with the account');
  eq(rows.find((u) => u.email === 'root@example.org').signupNote, undefined, 'an account without one has none');
}

// ---- single sign-on: the waiting page takes the note once ----
const REDIRECT = 'https://aldine.test/api/auth/oauth/oidc/callback';
async function sso(code, accept = 'text/html') {
  const res = await call('GET', '/api/auth/oauth/oidc');
  const state = [].concat(res.headers['set-cookie']).find((c) => c.startsWith('aldine_oauth_state=')).split(';')[0];
  const loc = new URL(res.headers.location);
  eq(loc.searchParams.get('redirect_uri'), REDIRECT, 'redirect URI');
  loc.searchParams.set('persona', code);
  const idp = await fetch(loc, { redirect: 'manual' });
  const back = new URL(idp.headers.get('location'));
  return call('GET', `/api/auth/oauth/oidc/callback${back.search}`, state, undefined, { accept });
}
const tokenOf = (html) => /name="token" value="([^"]+)"/.exec(html)?.[1];
const postNote = (token, note, accept = 'text/html') => call('POST', '/api/auth/signup-note', null,
  new URLSearchParams({ token, note }).toString(), { 'content-type': 'application/x-www-form-urlencoded', accept });
mock.addPersona({ code: 'sam', sub: 'sam-1', claims: { name: 'Sam', email: 'sam@example.org', email_verified: true } });
{
  const page = await sso('sam');
  eq(page.statusCode, 403, 'the first sign-in waits');
  check(page.body.includes('data-testid="signup-note-form"') && page.body.includes('What will you use Aldine for?'), 'the waiting page asks for the note');
  check(page.body.includes('action="/api/auth/signup-note"') && page.body.includes(`maxlength="${auth.NOTE_MAX}"`), 'its form posts here, at most 500 characters');
  check(page.headers['content-security-policy'].includes("form-action 'self'"), 'the page may post its form to this origin');
  check(!cookieOf(page), 'still without a session');
  const token = tokenOf(page.body);
  check(token, 'the form carries a token');
  const first = await mailTo('root@example.org', 'sam@example.org (signs in with single sign-on)');
  check(!first.text.includes('They wrote'), 'the first mail has no note yet');

  const forged = await postNote(`${token.split('.')[0]}.${Date.now() + 1e6}.${'A'.repeat(43)}`, 'Let me in');
  eq(forged.statusCode, 400, 'a forged token is refused');
  check(forged.body.includes('This form has expired. Sign in again to add your note.'), 'with a way forward');
  const otherAccount = await postNote(token.replace(/^[^.]+/, ada.id), 'Not mine');
  eq(otherAccount.statusCode, 400, 'a token does not move to another account');
  eq((await db().getUser(ada.id)).signupNote, CLEAN, 'whose note stays');
  const json = await call('POST', '/api/auth/signup-note', null, { token: 'nope', note: 'x' });
  eq([json.statusCode, json.json().error], [400, 'This form has expired. Sign in again to add your note.'], 'JSON clients get the error as JSON');
  const empty = await postNote(token, '  ');
  eq(empty.statusCode, 400, 'an empty note is refused');
  check(empty.body.includes('Write a note first'), 'and says so');

  const ok = await postNote(token, 'Physics <b>lab</b>, Example University');
  eq(ok.statusCode, 200, `the note is taken (${ok.body.slice(0, 200)})`);
  check(ok.body.includes('<h1>Note sent</h1>') && ok.body.includes(auth.AWAITING_APPROVAL), 'the page says it was sent and that the account still waits');
  check(!ok.body.includes('signup-note-form'), 'without another form');
  eq((await db().findUserByEmail('sam@example.org')).signupNote, 'Physics <b>lab</b>, Example University', 'the note is stored as written');
  const added = await mailTo('root@example.org', 'added a note');
  check(added.text.includes('A waiting Aldine account added a note') && added.text.includes('"Physics <b>lab</b>, Example University"'), 'the administrators get the note by mail');
  check(logged('[aldine] account waiting for approval added a note: sam@example.org'), 'and the log says so');

  const again = await postNote(token, 'A second note');
  eq(again.statusCode, 400, 'the note is taken once');
  check(again.body.includes('Your account has a note already.'), 'and the page says why');
  eq((await db().findUserByEmail('sam@example.org')).signupNote, 'Physics <b>lab</b>, Example University', 'the first note stays');

  const later = await sso('sam');
  eq(later.statusCode, 403, 'a later sign-in still waits');
  check(!later.body.includes('signup-note-form'), 'and is not asked for a note again');

  mock.addPersona({ code: 'tom', sub: 'tom-1', claims: { name: 'Tom', email: 'tom@example.org', email_verified: true } });
  const tomPage = await sso('tom');
  const tomToken = tokenOf(tomPage.body);
  const tom = await db().findUserByEmail('tom@example.org');
  eq((await call('POST', `/api/admin/users/${tom.id}/enable`, root, {})).statusCode, 200, 'an administrator approves Tom before he writes a note');
  const late = await postNote(tomToken, 'Late note');
  eq(late.statusCode, 400, 'a note for an account that no longer waits is refused');
  check(late.body.includes('no longer waits for approval'), 'with the reason');
  eq((await db().getUser(tom.id)).signupNote, undefined, 'and nothing is stored');
  const tomIn = await sso('tom', 'application/json');
  eq(tomIn.statusCode, 302, 'Tom signs in');
}

// ---- the welcome mail ----
{
  eq((await call('POST', `/api/admin/users/${ada.id}/enable`, root, {})).statusCode, 200, 'the administrator approves Ada');
  const m = await mailTo('ada@example.org', 'Your Aldine account is ready');
  check(m.text.includes('An administrator approved your account on the Aldine server at https://aldine.test, so it is ready to use. Sign in here:\nhttps://aldine.test/'), 'it says the account is ready, with the sign-in link');
  check(m.text.includes('Three first steps:'), 'three first steps');
  check(m.text.includes('1. Create a project: New project starts one blank or from a template, and Import a ZIP brings one in from Overleaf or another Aldine.'), 'create or import a project');
  check(m.text.includes('2. Share it: Share in the project invites co-authors by email address or ORCID iD, or creates a link for guests who have no account.'), 'share it, with co-authors or a guest link');
  check(m.text.includes('3. Questions, or something slow, broken or missing? Write to help@aldine.test.'), 'and where feedback goes: the support contact');
  check(m.text.includes('href="mailto:help@aldine.test"'), 'linked in the HTML part');
}

// ---- without a transport the welcome mail is logged, and kept for the test hook ----
{
  const tomRow = (await call('GET', '/api/admin/users', root)).json().find((u) => u.email === 'tom@example.org');
  check(!tomRow.awaitingApproval, 'Tom is approved already');
  const r = await register('nomail@example.org', 'Biology group');
  eq(r.statusCode, 200, 'another waiting sign-up');
  const u = await db().findUserByEmail('nomail@example.org');
  await mailTo('nomail@example.org', 'confirm_email=');
  const before = smtp.mails.length;
  delete process.env.SMTP_HOST;
  process.env.ALDINE_TEST_HOOKS = '1';
  try {
    eq((await call('POST', `/api/admin/users/${u.id}/enable`, root, {})).statusCode, 200, 'approving without a transport works');
    await settle();
    check(logged('[aldine] email (no transport configured) → nomail@example.org: Your Aldine account is ready'), 'the welcome mail is logged');
    eq(email.loggedMailsTo('nomail@example.org').map((x) => x.subject), ['Your Aldine account is ready'], 'and kept for the test hook');
  } finally {
    process.env.SMTP_HOST = '127.0.0.1';
    delete process.env.ALDINE_TEST_HOOKS;
  }
  eq(smtp.mails.length, before, 'nothing went out by SMTP');
}

// ---- the mail builders ----
{
  const evil = '<a href="https://evil.example/">Approve me</a> & more';
  const req = email.approvalRequestMail('root@example.org', { account: 'x@example.org', signIn: 'a password', instance: 'https://aldine.test', adminLink: 'https://aldine.test/admin', note: evil });
  check(!req.html.includes('<a href="https://evil.example/">') && req.html.includes('&#60;a href=&#34;https://evil.example/&#34;&#62;Approve me&#60;/a&#62; &#38; more'), 'the note is escaped in the HTML part');
  eq(req.subject, 'A new Aldine account is waiting for approval', 'the first mail\'s subject');
  const none = email.approvalRequestMail('root@example.org', { account: 'x@example.org', signIn: 'a password', instance: 'https://aldine.test', adminLink: 'https://aldine.test/admin' });
  check(!none.text.includes('They wrote') && !none.html.includes('blockquote'), 'no note, no quote');

  const plain = email.approvedMail('a@example.org', 'https://aldine.test', 'https://aldine.test/');
  check(plain.text.includes('Ask the administrator of this server, or open an issue at https://github.com/trahloff/Aldine/issues.'), 'without a support contact: the administrator, or Aldine\'s issues');
  const url = email.approvedMail('a@example.org', 'https://aldine.test', 'https://aldine.test/', { kind: 'url', value: 'https://help.example/?a=1&b="2"' });
  check(url.text.includes('Write to https://help.example/?a=1&b="2".'), 'a support page is named in the text');
  check(url.html.includes('href="https://help.example/?a=1&#38;b=&#34;2&#34;"'), 'and escaped in the HTML');
  const odd = email.approvedMail('a@example.org', 'https://x.example/<b>', 'https://x.example/<b>/');
  check(!odd.html.includes('<b>'), 'the instance address is escaped too');
}

// ---- cleanNote ----
eq(auth.cleanNote(undefined), '', 'no note');
eq(auth.cleanNote('  a\u0000b  c\r\n\r\nd  '), 'a b c d', 'control characters and runs of space become one space');
eq(auth.cleanNote('é'.repeat(auth.NOTE_MAX)), 'é'.repeat(auth.NOTE_MAX), '500 characters stay');

await app.close();
await mock.close();
smtp.close();
console.log = realLog;
fs.rmSync(tmp, { recursive: true, force: true });
console.log('signup-note: all assertions passed');
process.exit(0);
