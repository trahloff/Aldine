/**
 * Sharing a project mails each newly invited address once: not ORCID iDs, not
 * addresses already on the list or invited, not on a re-save. Owner and project names
 * are the owner's own text, escaped in the HTML part. A per-owner budget
 * caps the mails; over it, and when a send fails or the server sends no
 * email, the invitation is still made and the response names who was not
 * mailed.
 *
 * Real route table (Fastify inject), real SMTP backend against a local
 * listener; env is set before any src import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';
import { startSmtp, decoded } from './smtp-mock.mjs';

const smtp = await startSmtp({ reject: /bounce@/ });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-invite-'));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.ALDINE_PUBLIC_URL = 'https://aldine.test/write';
process.env.RL_REGISTER_BURST = '200';
process.env.RL_INVITE_BURST = '6';
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = String(smtp.port);
for (const k of ['DATABASE_URL', 'REDIS_URL', 'SES_FROM', 'SMTP_USER', 'SMTP_SECURE', 'ALDINE_SSO_ONLY', 'ALDINE_RESET_ECHO', 'ALDINE_TEST_HOOKS', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_BASE_PATH']) delete process.env[k];

const { initDb } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;
const app = Fastify();
await registerRoutes(app);
await app.ready();

const sessionOf = (res) => [].concat(res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).find((c) => c.startsWith(`${auth.COOKIE}=`));
const call = (method, url, cookie, payload) => app.inject({ method, url, headers: cookie ? { cookie } : {}, ...(payload ? { payload } : {}) });
/** One body part of a multipart mail, transfer encoding undone. */
const part = (raw, type) => {
  const p = raw.split(/\r\n--[^\r\n]+\r\n/).find((x) => new RegExp(`^Content-Type: ${type}`, 'im').test(x));
  if (!p) throw new Error(`no ${type} part`);
  const body = p.slice(p.indexOf('\r\n\r\n') + 4);
  return /Content-Transfer-Encoding: base64/i.test(p) ? Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8') : Buffer.from(decoded(body), 'latin1').toString('utf8');
};
const settle = () => new Promise((r) => setTimeout(r, 300));

/** A confirmed account: sign up, follow the mailed link. */
async function signUp(email, name, confirm = true) {
  const before = smtp.mails.length;
  const res = await call('POST', '/api/auth/register', null, { email, password: 'password123', name });
  eq(res.statusCode, 200, `register ${email}`);
  const cookie = sessionOf(res);
  const token = /confirm_email=([A-Za-z0-9_-]+)/.exec(decoded(await smtp.waitFor(before + 1)))[1];
  if (confirm) eq((await call('POST', '/api/auth/confirm-email', cookie, { token })).statusCode, 200, `confirm ${email}`);
  return cookie;
}
const share = async (cookie, id, collaborators) => {
  const res = await call('POST', `/api/projects/${id}/share`, cookie, { mode: 'private', collaborators });
  eq(res.statusCode, 200, `share ${collaborators.join(', ')}`);
  return res.json();
};

const ownerName = 'Ada <b>Lovelace</b> & "co"';
const owner = await signUp('owner@example.com', ownerName);
const projectName = 'Notes <script>alert(1)</script> & things';
const project = (await call('POST', '/api/projects', owner, { name: projectName })).json();

// ---- a new address is mailed once ----
let base = smtp.mails.length;
let r = await share(owner, project.id, ['Grace@Example.org', '0000-0002-1825-0097', 'owner@example.com']);
eq(r.invited, 1, 'one invitation for the one new address');
eq(r.notEmailed, [], 'nobody left unmailed');
eq(r.share.collaborators, [], 'nobody has access before accepting');
eq(r.invitations.map((i) => i.to).sort(), ['0000-0002-1825-0097', 'grace@example.org'], 'the address and the iD are invited, the owner is not');
const graceLink = `https://aldine.test/write/invite/${r.invitations.find((i) => i.to === 'grace@example.org').id}`;
const raw = await smtp.waitFor(base + 1);
await settle();
eq(smtp.mails.length, base + 1, 'no mail for the ORCID iD or the owner’s own address');
const html = part(raw, 'text/html');
const text = part(raw, 'text/plain');
check(raw.includes('To: grace@example.org'), 'the invitation goes to the added address');
check(decoded(raw).includes(graceLink), 'the link is the invitation on the public URL, base path included');
check(/sign in or create an account with this address/.test(decoded(raw)), 'the mail says how to accept');
check(!html.includes('<script>') && !html.includes('<b>'), 'no owner-chosen markup in the HTML part');
check(html.includes('&#60;script&#62;') && html.includes('Ada &#60;b&#62;Lovelace&#60;/b&#62; &#38; &#34;co&#34;'), 'the names are escaped in the HTML part');
eq((html.match(/<a /g) || []).length, 1, 'the HTML part has one link');
check(text.includes('Ada <b>Lovelace</b> & "co" invited you to the LaTeX project “Notes <script>alert(1)</script> & things”'), 'and plain in the text part');

// ---- re-saving the same list mails nobody ----
base = smtp.mails.length;
r = await share(owner, project.id, ['grace@example.org', '0000-0002-1825-0097', 'owner@example.com']);
eq(r.invited, 0, 'a re-save invites nobody');
eq(r.notEmailed, [], 'and reports nobody');
await settle();
eq(smtp.mails.length, base, 'a re-save sends no mail');

// ---- a long name is clipped in the subject ----
const long = (await call('POST', '/api/projects', owner, { name: `${'x'.repeat(300)}\r\nBcc: victim@example.net` })).json();
base = smtp.mails.length;
r = await share(owner, long.id, ['lin@example.org']);
const longRaw = await smtp.waitFor(base + 1);
check(!/^Bcc:/m.test(longRaw), 'a newline in the project name never becomes a header');
check(!decoded(longRaw).includes('x'.repeat(101)), 'the project name is capped');

// ---- a failed send still saves the share and is reported ----
base = smtp.mails.length;
r = await share(owner, project.id, ['grace@example.org', 'bounce@example.org']);
eq(r.invitations.some((i) => i.to === 'bounce@example.org' && i.state === 'pending' && !i.emailedAt), true, 'the invitation is made despite the failure');
eq(r.invited, 0, 'the failed mail is not counted');
eq(r.notEmailed, ['bounce@example.org'], 'the failed address is reported');
eq(r.reason, 'failed', 'with the reason');

// ---- the per-owner budget (6 here: 2 used) ----
base = smtp.mails.length;
const many = ['a', 'b', 'c', 'd', 'e', 'f'].map((c) => `${c}@example.org`);
r = await share(owner, project.id, ['grace@example.org', 'bounce@example.org', ...many]);
eq(r.invited, 3, 'mails go out while the budget lasts (bounce used one)');
eq(r.notEmailed, ['d@example.org', 'e@example.org', 'f@example.org'], 'the rest are reported');
eq(r.reason, 'limit', 'as over the limit');
eq(r.invitations.length, 9, 'and still invited');
await smtp.waitFor(base + 3);
await settle();
eq(smtp.mails.length, base + 3, 'no mail past the limit');

// ---- an unconfirmed owner mails nobody ----
const fresh = await signUp('fresh@example.com', 'Fresh', false);
const fp = (await call('POST', '/api/projects', fresh, { name: 'Draft' })).json();
base = smtp.mails.length;
r = await share(fresh, fp.id, ['target@example.org']);
eq([r.invited, r.reason], [0, 'unconfirmed'], 'an owner with an unconfirmed address sends no invitation');
eq(r.notEmailed, ['target@example.org'], 'and is told who was not mailed');

// ---- no transport: nothing is sent ----
delete process.env.SMTP_HOST;
const p2 = (await call('POST', '/api/projects', owner, { name: 'Quiet' })).json();
base = smtp.mails.length;
r = await share(owner, p2.id, ['quiet@example.org']);
eq([r.invited, r.reason], [0, 'no-mail'], 'without a transport nothing is mailed');
eq(r.notEmailed, ['quiet@example.org'], 'and the address is reported');
await settle();
eq(smtp.mails.length, base, 'no mail reached the listener');

await app.close();
smtp.close();
console.log('invite-mails: all assertions passed');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
