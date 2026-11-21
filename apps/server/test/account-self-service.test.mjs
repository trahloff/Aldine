/**
 * A person's own account: "Export your data" and "Delete your account" in
 * Account settings.
 *  - both are a browser session's only: access tokens, guests, signed-out
 *    callers and (for delete) non-JSON bodies are refused
 *  - the export is one ZIP: account.json without any secret, every branch of
 *    every owned project (trashed ones too) as the per-project download's
 *    ZIP, projects shared with the person listed without their files, the
 *    person's own comments; exports are rate-limited
 *  - delete names what goes (owned projects, the people in them), asks for
 *    the address, and for the password or a sign-in again once the session
 *    is older than ten minutes; an administrator on ALDINE_ADMIN_EMAILS is
 *    refused; afterwards the account, its sessions, tokens, owned projects
 *    and share entries (roles and link memberships included) are gone, and
 *    open invitations to it are withdrawn
 *  - ZipStream writes ZIP64 records past 65 535 entries
 *
 * Accounts on, a throwaway datastore (the default backend), the real route
 * table through Fastify inject.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-account-self-')));
process.env.AUTH_ENABLED = '1';
process.env.ALDINE_ADMIN_EMAILS = 'root@example.org';
process.env.RL_REGISTER_BURST = '200';
process.env.RL_LOGIN_BURST = '200';
process.env.RL_EXPORT_BURST = '3';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
for (const k of ['DATABASE_URL', 'REDIS_URL', 'SMTP_HOST', 'SES_FROM', 'ALDINE_PUBLIC_URL', 'ALDINE_SSO_ONLY', 'ALDINE_RESET_ECHO', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_BASE_PATH']) delete process.env[k];

const logs = [];
const realLog = console.log;
console.log = (...a) => { logs.push(a.join(' ')); realLog(...a); };

const { initDb, closeDb, db } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const store = await import('../src/store.ts');
const { unzip } = await import('../src/unzip.ts');
const { ZipStream } = await import('../src/zipstream.ts');
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;

const app = Fastify({ logger: false });
await registerRoutes(app);
await app.ready();

const cookieOf = (res) => [].concat(res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).find((c) => c.startsWith(`${auth.COOKIE}=`));
const call = (method, url, cookie, payload, headers = {}) => app.inject({ method, url, headers: { ...(cookie ? { cookie } : {}), ...headers }, ...(payload !== undefined ? { payload } : {}) });
async function signUp(email, name) {
  const res = await call('POST', '/api/auth/register', null, { email, password: 'password123', name });
  eq(res.statusCode, 200, `register ${email}`);
  await db().setEmailPending(res.json().user.id, null);
  return { cookie: cookieOf(res), id: res.json().user.id, email };
}
async function project(cookie, name) {
  const res = await call('POST', '/api/projects', cookie, { name });
  eq(res.statusCode, 200, `create ${name}`);
  return res.json().id;
}
const listed = async (cookie) => (await call('GET', '/api/projects', cookie)).json().map((p) => p.id);
/** A session that began `minutes` ago, past the ten-minute window. */
async function staleSession(userId, minutes = 11) {
  const sid = `stale-${userId}-${Math.random().toString(36).slice(2)}`;
  await db().createSession(sid, userId, Date.now() + 30 * 864e5, Date.now() - minutes * 60_000);
  return `${auth.COOKIE}=${sid}`;
}
const exportOf = async (cookie) => {
  const res = await call('GET', '/api/account/export', cookie);
  eq(res.statusCode, 200, `export (${res.statusCode === 200 ? '' : res.body})`);
  return { res, files: unzip(res.rawPayload) };
};

try {
  const root = await signUp('root@example.org', 'Root');
  const ann = await signUp('ann@example.org', 'Ann');
  const ben = await signUp('ben@example.org', 'Ben');
  const cat = await signUp('cat@example.org', 'Cat');

  // ---- guard ----
  eq((await call('GET', '/api/account/export', null)).statusCode, 401, 'export needs a session');
  eq((await call('GET', '/api/account/deletion', null)).statusCode, 401, 'so does the deletion summary');
  const pat = await auth.createAccessToken(ann.id, 'cli', null, null);
  eq((await call('GET', '/api/account/export', null, undefined, { authorization: `Bearer ${pat.token}` })).statusCode, 403, 'an access token cannot export the account');
  eq((await call('POST', '/api/account/delete', null, { confirm: ann.email }, { authorization: `Bearer ${pat.token}` })).statusCode, 403, 'nor delete it');
  eq((await call('POST', '/api/account/delete', ann.cookie, 'confirm=ann@example.org', { 'content-type': 'application/x-www-form-urlencoded' })).statusCode, 415, 'a form post cannot delete it');

  // ---- what Ann has ----
  const paper = await project(ann.cookie, 'Ann’s paper: draft/1');
  eq((await call('PUT', `/api/projects/${paper}/file`, ann.cookie, { path: 'main.tex', content: '\\documentclass{article}\\begin{document}Hello\\end{document}\n' })).statusCode, 200, 'Ann writes main.tex');
  eq((await call('POST', `/api/projects/${paper}/branches`, ann.cookie, { name: 'feature/intro' })).statusCode, 200, 'Ann makes a branch');
  eq((await call('PUT', `/api/projects/${paper}/file`, ann.cookie, { branch: 'feature/intro', path: 'intro.tex', content: 'Intro\n' })).statusCode, 200, 'and writes on it');
  const binned = await project(ann.cookie, 'Old notes');
  eq((await call('DELETE', `/api/projects/${binned}`, ann.cookie)).statusCode, 200, 'Ann trashes one project');
  const solo = await project(ann.cookie, 'Solo');
  // Ben is on Ann's paper by name, with a role.
  await store.updateMeta(paper, (m) => ({ ...m, share: { ...m.share, collaborators: ['ben@example.org'], roles: { 'ben@example.org': 'review' } } }));
  const toCat = await call('POST', `/api/projects/${paper}/invitations`, ann.cookie, { to: 'cat@example.org' });
  eq(toCat.statusCode, 200, 'Ann invites Cat');
  // Ben's project: Ann by name with a role, Ann's link membership, Ann's comment.
  const bens = await project(ben.cookie, 'Ben thesis');
  eq((await call('PUT', `/api/projects/${bens}/file`, ben.cookie, { path: 'main.tex', content: 'Ben text\n' })).statusCode, 200, 'Ben writes');
  await store.updateMeta(bens, (m) => ({ ...m, share: { ...m.share, collaborators: ['ann@example.org', 'cat@example.org'], roles: { 'ann@example.org': 'view' } } }));
  const linkRes = await call('POST', `/api/projects/${bens}/links`, ben.cookie, { role: 'edit' });
  eq(linkRes.statusCode, 200, `Ben makes a share link (${linkRes.body})`);
  const link = linkRes.json().link;
  const bensLinked = await project(ben.cookie, 'Ben linked');
  const link2 = (await call('POST', `/api/projects/${bensLinked}/links`, ben.cookie, { role: 'review' })).json().link;
  eq((await call('POST', '/api/share-links/join', ann.cookie, { project: bensLinked, token: link2.token })).statusCode, 200, 'Ann joins Ben\'s other project by link');
  // Ann's own comment on Ben's thesis, and a reply on her paper.
  await store.updateMeta(bens, (m) => ({ ...m, share: { ...m.share, roles: { 'ann@example.org': 'review' } } }));
  const comment = await call('POST', `/api/projects/${bens}/comments`, ann.cookie, { file: 'main.tex', anchor: { from: 0, to: 3, quote: 'Ben' }, body: 'Ann’s remark' });
  eq(comment.statusCode, 200, `Ann comments on Ben's thesis (${comment.body})`);
  const bensInvite = await call('POST', `/api/projects/${bensLinked}/invitations`, ben.cookie, { to: 'ann@example.org' });
  eq(bensInvite.statusCode, 200, `Ben invites Ann by name to the project she came into by link (${bensInvite.body})`);

  // ---- export ----
  const { res, files } = await exportOf(ann.cookie);
  eq(res.headers['content-type'], 'application/zip', 'the export is a ZIP');
  check(/attachment; filename="aldine-export-\d{4}-\d{2}-\d{2}\.zip"/.test(res.headers['content-disposition']), 'downloaded as aldine-export-<date>.zip');
  eq(res.headers['cache-control'], 'no-store', 'never cached');
  const account = JSON.parse(files['account.json'].toString());
  eq([account.format, account.version], ['aldine-account-export', 1], 'account.json says what it is');
  eq([account.account.id, account.account.email, account.account.name, account.account.emailConfirmed], [ann.id, 'ann@example.org', 'Ann', true], 'with the profile');
  eq(account.signIn.password, true, 'and how the account signs in');
  eq(account.accessTokens.map((t) => t.name), ['cli'], 'tokens by name');
  const raw = files['account.json'].toString();
  const annRow = await db().getUser(ann.id);
  for (const secret of [pat.token, annRow.hash, annRow.salt, link.token, link2.token]) check(!raw.includes(secret), 'no secret in account.json');
  check(!raw.includes('"hash"') && !raw.includes('"salt"'), 'no hash or salt fields');
  const ownedIds = account.ownedProjects.map((p) => p.id).sort();
  eq(ownedIds, [paper, binned, solo].sort(), 'every owned project, the trashed one too');
  const paperRow = account.ownedProjects.find((p) => p.id === paper);
  eq(Object.keys(paperRow.branches).sort(), ['feature/intro', 'main'], 'every branch');
  eq(paperRow.sharedWith, [{ entry: 'ben@example.org', role: 'review' }], 'who it is shared with, and how');
  check(paperRow.invitations.some((i) => i.to === 'cat@example.org' && i.status === 'pending'), 'and who is invited');
  check(!!account.ownedProjects.find((p) => p.id === binned).trashedAt, 'the trashed one says so');
  const mainZip = unzip(files[paperRow.branches.main]);
  check(mainZip['main.tex']?.toString().includes('Hello'), 'main.zip holds the project\'s files, flat as the Share dialog downloads them');
  check(!Object.keys(mainZip).some((n) => n.startsWith('.git/')), 'without .git');
  check(unzip(files[paperRow.branches['feature/intro']])['intro.tex']?.toString() === 'Intro\n', 'the branch ZIP holds the branch');
  check(paperRow.branches.main.startsWith('projects/Ann’s paper- draft-1 ('), `the folder keeps the name, without slashes or colons (${paperRow.branches.main})`);
  const direct = await call('GET', `/api/projects/${paper}/archive?branch=main`, ann.cookie);
  eq(Object.keys(unzip(direct.rawPayload)).sort(), Object.keys(mainZip).sort(), 'the same files as the per-project download');
  eq(account.sharedWithYou.map((p) => [p.id, p.role, p.via]).sort(), [[bens, 'review', 'share list'], [bensLinked, 'review', 'share link']].sort(), 'shared projects, by role and way in');
  check(!Object.keys(files).some((n) => n.includes(bens) || n.includes(bensLinked)), 'without their files');
  check(account.comments.some((c) => c.projectId === bens && c.body === 'Ann’s remark'), 'Ann\'s own comments');
  eq(account.incomplete, [], 'nothing was left out');

  const bensExport = JSON.parse((await exportOf(ben.cookie)).files['account.json'].toString());
  check(!bensExport.comments.length, 'Ben\'s export has no comment of Ann\'s');
  check(!JSON.stringify(bensExport).includes('Ann’s remark'), 'nor her text');

  await exportOf(ann.cookie);
  await exportOf(ann.cookie);
  const limited = await call('GET', '/api/account/export', ann.cookie);
  eq(limited.statusCode, 429, 'a fourth export in a row waits');
  check(/10 minutes/.test(limited.json().error), 'and says how long');

  // ---- deletion summary ----
  const preview = (await call('GET', '/api/account/deletion', ann.cookie)).json();
  eq(preview.confirm, 'ann@example.org', 'Ann types her address');
  eq(preview.refused, null, 'Ann may delete her account');
  eq(preview.reauth, 'none', 'right after signing in, nothing else is asked');
  eq(preview.projects.map((p) => [p.id, p.others, p.trashed]).sort(), [[paper, 2, false], [binned, 0, true], [solo, 0, false]].sort(), 'her projects, and who else is in them');
  eq((await call('GET', '/api/account/deletion', await staleSession(ann.id))).json().reauth, 'password', 'later, the password');

  // ---- refusals ----
  const rootPreview = (await call('GET', '/api/account/deletion', root.cookie)).json();
  check(/ALDINE_ADMIN_EMAILS/.test(rootPreview.refused ?? ''), 'an administrator is told why not');
  const rootDelete = await call('POST', '/api/account/delete', root.cookie, { confirm: 'root@example.org' });
  eq(rootDelete.statusCode, 403, 'and refused');
  check(await db().getUser(root.id), 'and stays');
  const wrong = await call('POST', '/api/account/delete', ann.cookie, { confirm: 'ann' });
  eq([wrong.statusCode, wrong.json().error], [400, 'Type ann@example.org to confirm.'], 'the address must be typed');
  const stale = await staleSession(ann.id);
  const bare = await call('POST', '/api/account/delete', stale, { confirm: 'ann@example.org' });
  eq([bare.statusCode, bare.json().code], [403, 'reauth-required'], 'an older session must confirm it is her');
  const badPassword = await call('POST', '/api/account/delete', stale, { confirm: 'ann@example.org', password: 'wrong-password' });
  eq([badPassword.statusCode, badPassword.json().error], [403, 'That password is incorrect.'], 'with the right password');
  check(await db().getUser(ann.id), 'nothing was removed by the refusals');

  // ---- an SSO account signs in again ----
  const sso = await auth.register('sso@example.org', '', 'Sso', 'github', 'github:42');
  const ssoStale = await staleSession(sso.id);
  const ssoPreview = (await call('GET', '/api/account/deletion', ssoStale)).json();
  eq(ssoPreview.reauth, 'sign-in', 'a single sign-on account has no password to type');
  const ssoBare = await call('POST', '/api/account/delete', ssoStale, { confirm: 'sso@example.org', password: 'anything' });
  eq(ssoBare.statusCode, 403, 'an older SSO session is refused, password or not');
  check(/sign in again with GitHub/.test(ssoBare.json().error), `and told to sign in again (${ssoBare.json().error})`);
  const ssoFresh = `${auth.COOKIE}=${await auth.createSession(sso.id)}`;
  eq((await call('POST', '/api/account/delete', ssoFresh, { confirm: 'SSO@example.org ' })).statusCode, 200, 'a fresh sign-in deletes it');
  eq(await db().getUser(sso.id), null, 'the SSO account is gone');

  // ---- Ann deletes her account with her password ----
  const annCookie2 = cookieOf(await call('POST', '/api/auth/login', null, { email: 'ann@example.org', password: 'password123' }));
  const gone = await call('POST', '/api/account/delete', stale, { confirm: ' Ann@Example.org', password: 'password123' });
  eq(gone.statusCode, 200, `Ann deletes her account (${gone.body})`);
  eq([gone.json().deleted, gone.json().sharesRemoved], [3, 2], 'three projects deleted, two share lists changed');
  check(/Max-Age=0/.test([].concat(gone.headers['set-cookie']).join(';')), 'the session cookie is cleared');
  check(logs.some((l) => l.includes(`[aldine] account ann@example.org [${ann.id}] deleted itself (3 projects deleted, taken off 2 share lists)`)), 'the log says so');
  eq(await db().getUser(ann.id), null, 'the account is gone');
  eq((await call('GET', '/api/auth/me', annCookie2)).json().user, null, 'and every session');
  eq((await call('GET', '/api/projects', null, undefined, { authorization: `Bearer ${pat.token}` })).statusCode, 401, 'and its access token');
  eq((await db().listTokensForUser(ann.id)).length, 0, 'whose row is gone');
  for (const id of [paper, binned, solo]) {
    eq(await db().readMeta(id), null, `owned project ${id} is deleted`);
    check(!fs.existsSync(store.repoDir(id)), 'with its repository');
  }
  eq(await db().getInvitation(toCat.json().invitations.find((i) => i.to === 'cat@example.org').id), null, 'Ann\'s invitations went with her project');
  check(!(await listed(ben.cookie)).includes(paper), 'Ben no longer sees Ann\'s paper');
  const bensMeta = await db().readMeta(bens);
  eq(bensMeta.share.collaborators, ['cat@example.org'], 'Ann is off Ben\'s share list');
  eq(bensMeta.share.roles ?? {}, {}, 'and so is her role');
  const linkedMeta = await store.readMeta(bensLinked);
  check(!linkedMeta.share.links.some((l) => l.members?.some((m) => m.id === ann.id)), 'and her link membership');
  const toAnn = bensInvite.json().invitations.find((i) => i.to === 'ann@example.org');
  eq((await db().getInvitation(toAnn.id)).status, 'withdrawn', 'an open invitation to her is withdrawn');
  eq((await db().loadComments(bens)).length, 1, 'her comment stays in Ben\'s project, under her name');
  eq((await call('POST', '/api/auth/login', null, { email: 'ann@example.org', password: 'password123' })).json().error, 'Incorrect email or password', 'nobody can sign in to it');

  // ---- a disabled account has no session to do either with ----
  await auth.disableAccount(cat.id, false);
  eq((await call('GET', '/api/account/export', cat.cookie)).statusCode, 401, 'a disabled account cannot export');
  eq((await call('POST', '/api/account/delete', cat.cookie, { confirm: 'cat@example.org' })).statusCode, 401, 'nor delete itself');

  // ---- ZIP64 past 65 535 entries ----
  const big = new ZipStream();
  const chunks = [];
  big.stream.on('data', (c) => chunks.push(c));
  const done = new Promise((r) => big.stream.on('end', r));
  for (let i = 0; i < 65_540; i++) await big.add(`f/${i}.txt`, Buffer.from(String(i)));
  await big.finish();
  await done;
  const bigBuf = Buffer.concat(chunks);
  check(bigBuf.indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06])) > 0, 'a ZIP64 end record is written');
  eq(bigBuf.readUInt16LE(bigBuf.length - 22 + 10), 0xffff, 'and the classic count says to read it');

  console.log('✓ account self-service: guard, export, deletion summary, refusals, re-auth, SSO, delete, ZIP64');
} finally {
  await app.close();
  await closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
