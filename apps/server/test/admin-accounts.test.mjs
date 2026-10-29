/**
 * Account actions on the admin page: disable and enable, confirm an address
 * by hand, a password reset link, and delete with the projects given to
 * another account or moved to the trash.
 *  - every route shares the admin guard; access tokens and non-JSON bodies
 *    are refused
 *  - a disabled account is refused on every path: session, password and
 *    provider sign-in, access token, MCP, OAuth code and refresh, collab
 *    socket (an open one is closed); enabling restores its tokens unless
 *    the administrator revoked them
 *  - an administrator cannot disable or delete themselves or another
 *    account on ALDINE_ADMIN_EMAILS, nor confirm an address on that list
 *  - every action leaves a log line naming who did what to whom
 *
 * Accounts on, a throwaway JSON datastore, the real route table (Fastify
 * inject) and a real collab socket. No email transport: the reset link comes
 * back to the administrator (admin-reset-mail.test.mjs covers the mail).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import * as Y from 'yjs';
import WS, { WebSocketServer } from 'ws';
import { check, eq, throws } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-admin-accounts-')));
process.env.AUTH_ENABLED = '1';
process.env.ALDINE_ADMIN_EMAILS = 'root@example.org,second@example.org,third@example.org';
process.env.RL_REGISTER_BURST = '200';
process.env.RL_LOGIN_BURST = '200';
process.env.RL_ADMIN_BURST = '200';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
for (const k of ['DATABASE_URL', 'REDIS_URL', 'SMTP_HOST', 'SES_FROM', 'ALDINE_PUBLIC_URL', 'ALDINE_SSO_ONLY', 'ALDINE_RESET_ECHO', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_BASE_PATH']) delete process.env[k];

const logs = [];
const realLog = console.log;
console.log = (...a) => { logs.push(a.join(' ')); realLog(...a); };
const audited = (needle) => logs.some((l) => l.startsWith('[aldine] admin ') && l.includes(needle));

const { initDb, closeDb, db } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const remotes = await import('../src/remotes.ts');
const collab = await import('../src/collab.ts');
const { authenticateMcp } = await import('../src/mcp/guards.ts');
const { issueCode } = await import('../src/oauth/codes.ts');
const { exchangeCode, refreshTokens } = await import('../src/oauth/token.ts');
const { registerRoutes } = await import('../src/routes.ts');
const { HocuspocusProvider, HocuspocusProviderWebsocket } = await import('@hocuspocus/provider');
const Fastify = (await import('fastify')).default;

const app = Fastify({ logger: false });
await registerRoutes(app);
await app.ready();

const wsServer = http.createServer();
const wss = new WebSocketServer({ noServer: true });
wsServer.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => collab.hocuspocus.handleConnection(ws, req)));
await new Promise((r) => wsServer.listen(0, '127.0.0.1', r));
const wsUrl = `ws://127.0.0.1:${wsServer.address().port}/collab`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}
const cookieOf = (res) => [].concat(res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).find((c) => c.startsWith(`${auth.COOKIE}=`));
const call = (method, url, cookie, payload, headers = {}) => app.inject({ method, url, headers: { ...(cookie ? { cookie } : {}), ...headers }, ...(payload !== undefined ? { payload } : {}) });
const act = (cookie, id, action, body = {}) => call('POST', `/api/admin/users/${id}/${action}`, cookie, body);
const login = (email, password = 'password123') => call('POST', '/api/auth/login', null, { email, password });
async function signUp(email, name, confirm = true) {
  const res = await call('POST', '/api/auth/register', null, { email, password: 'password123', name });
  eq(res.statusCode, 200, `register ${email}`);
  if (confirm) await db().setEmailPending(res.json().user.id, null);
  return { cookie: cookieOf(res), id: res.json().user.id, email };
}
async function project(cookie, name) {
  const res = await call('POST', '/api/projects', cookie, { name });
  eq(res.statusCode, 200, `create ${name}`);
  return res.json().id;
}
const listed = async (cookie) => (await call('GET', '/api/projects', cookie)).json().map((p) => p.id);
/** Entries on a project's share list, as an accepted invitation leaves them. */
async function shareWith(id, collaborators, mode = 'private') {
  await db().writeMeta({ ...(await db().readMeta(id)), share: { mode, collaborators } });
}
const invite = async (cookie, id, to) => {
  const res = await call('POST', `/api/projects/${id}/invitations`, cookie, { to });
  eq(res.statusCode, 200, `invite ${to}`);
  return res.json().invitations.find((i) => i.to === to).id;
};
const invitationState = async (id) => (await db().getInvitation(id))?.status;
const bearer = (token) => ({ authorization: `Bearer ${token}` });
const row = async (id) => (await call('GET', '/api/admin/users', root.cookie)).json().find((u) => u.id === id);

const ISSUER = 'https://aldine.test';
const pkce = () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
};
/** An OAuth grant for `userId`, the way the consent page issues it. */
function code(userId) {
  const { verifier, challenge } = pkce();
  const c = issueCode({ clientId: 'aldc_test', clientName: 'Claude', redirectUri: 'https://claude.test/cb', codeChallenge: challenge, resource: null, scope: 'projects', userId, projectIds: null });
  return { code: c, client_id: 'aldc_test', redirect_uri: 'https://claude.test/cb', code_verifier: verifier };
}

const sockets = [];
async function connect(cookie, name) {
  const Polyfill = class extends WS { constructor(url) { super(url, { headers: { cookie } }); } };
  const websocketProvider = new HocuspocusProviderWebsocket({ url: wsUrl, WebSocketPolyfill: Polyfill });
  const provider = new HocuspocusProvider({ websocketProvider, name, document: new Y.Doc(), token: 'aldine-session' });
  sockets.push(provider, websocketProvider);
  await until('the socket to sync', () => provider.synced);
  return provider;
}

const root = await signUp('root@example.org', 'Root');
const bob = await signUp('bob@example.org', 'Bob');
const carol = await signUp('carol@example.org', 'Carol');

try {
  // ---- the guard ----
  for (const action of ['disable', 'enable', 'confirm-email', 'reset-link', 'delete']) {
    eq((await act(null, bob.id, action)).statusCode, 401, `${action}: signed out → 401`);
    eq((await act(bob.cookie, carol.id, action)).statusCode, 403, `${action}: a regular account → 403`);
  }
  const rootPat = await auth.createAccessToken(root.id, 'cli', null, null);
  const viaToken = await call('GET', '/api/admin/users', null, undefined, bearer(rootPat.token));
  eq(viaToken.statusCode, 403, 'an administrator\'s access token cannot read the admin pages');
  check(/Access tokens/.test(viaToken.json().error), 'and the refusal says why');
  eq((await call('POST', `/api/admin/users/${bob.id}/disable`, null, {}, bearer(rootPat.token))).statusCode, 403, 'nor act on accounts');
  const asText = await call('POST', `/api/admin/users/${bob.id}/disable`, root.cookie, '{}', { 'content-type': 'text/plain' });
  eq(asText.statusCode, 415, 'a body that is not JSON is refused (a cross-site form can send text/plain)');
  eq((await call('POST', `/api/admin/users/${bob.id}/disable`, root.cookie)).statusCode, 415, 'so is a POST with no body');
  eq((await row(bob.id)).disabledAt, undefined, 'none of the refused requests disabled anyone');
  eq((await act(root.cookie, 'nobody', 'disable')).statusCode, 404, 'an unknown account → 404');

  // ---- disable: every way in is refused ----
  const bobProject = await project(bob.cookie, 'Bob paper');
  const bobPat = await auth.createAccessToken(bob.id, 'cli', null, null);
  eq((await call('GET', '/api/projects', null, undefined, bearer(bobPat.token))).statusCode, 200, 'before: Bob\'s access token works');
  const pair = await exchangeCode(ISSUER, code(bob.id));
  // Bob's outside credentials, lent to the members of his project.
  await shareWith(bobProject, ['carol@example.org']);
  await db().writeMeta({ ...(await db().readMeta(bobProject)), zotero: { apiKey: 'bobs-key', userId: 7, libraryPrefix: 'users/7', bibFile: 'zotero.bib' } });
  await db().setConnection(bob.id, 'github', { token: 'bobs-github-token', login: 'bob' });
  const link = { provider: 'github', fullName: 'bob/paper', owner: 'bob', repo: 'paper', remoteBranch: 'main', cloneUrl: 'https://github.com/bob/paper.git', connectedBy: bob.id };
  eq((await remotes.resolveConnection(link, carol.id, { allowService: false }))?.token, 'bobs-github-token', 'before: Carol pushes with the connection Bob linked');
  const unexchanged = code(bob.id);
  const socket = await connect(bob.cookie, collab.docName(bobProject, 'main', 'main.tex'));
  check(collab.onlineUserIds().has(bob.id), 'before: Bob has a collab socket open');
  const bobSid = bob.cookie.split('=')[1];

  const off = await act(root.cookie, bob.id, 'disable');
  eq(off.statusCode, 200, 'the administrator disables Bob');
  check(typeof off.json().disabledAt === 'string', 'the row says since when');
  check(audited(`root@example.org [${root.id}] disabled bob@example.org [${bob.id}]`), 'the log names who disabled whom');

  eq((await call('GET', '/api/auth/me', bob.cookie)).json().user, null, 'Bob\'s session ends at once');
  eq((await call('GET', '/api/projects', bob.cookie)).statusCode, 401, 'his next request is signed out');
  eq(await db().getSession(bobSid), null, 'the session row is gone');
  const refused = await login('bob@example.org');
  eq([refused.statusCode, refused.json().error], [401, auth.ACCOUNT_DISABLED], 'the right password hears the account is disabled');
  eq((await login('bob@example.org', 'wrong-password')).json().error, 'Incorrect email or password', 'a wrong one learns nothing');
  eq((await call('GET', '/api/projects', null, undefined, bearer(bobPat.token))).statusCode, 401, 'his access token is refused');
  eq(await auth.userFromToken(`Bearer ${pair.access_token}`), null, 'so is an OAuth access token');
  eq(await authenticateMcp(`Bearer ${bobPat.token}`, undefined), null, 'MCP refuses the token');
  await throws(() => refreshTokens(ISSUER, { refresh_token: pair.refresh_token, client_id: 'aldc_test' }), 'invalid', 'the connector cannot refresh');
  const rf = await db().getRefreshByHash(auth.secretDigest(pair.refresh_token));
  eq([rf.usedAt, rf.revokedAt], [null, null], 'the refusal neither rotates nor revokes the refresh token');
  await throws(() => exchangeCode(ISSUER, unexchanged), 'invalid', 'a code issued before the disable is not exchanged');
  eq(await remotes.resolveConnection(link, carol.id, { allowService: false }), null, 'the GitHub connection Bob linked serves nobody');
  eq(await remotes.resolveConnection(link, bob.id, { allowService: false }), null, 'not even autopush in his name');
  const zsearch = await call('GET', `/api/projects/${bobProject}/zotero/search?q=x`, carol.cookie);
  eq(zsearch.statusCode, 403, 'Carol cannot search Bob\'s Zotero library');
  check(/owner's account is disabled/.test(zsearch.json().error), 'and is told why');
  eq((await call('POST', `/api/projects/${bobProject}/zotero/sync`, carol.cookie, {})).statusCode, 403, 'nor sync it');
  check((await listed(carol.cookie)).includes(bobProject), 'she keeps the project itself');
  await until('Bob\'s socket to close', () => !collab.onlineUserIds().has(bob.id));
  await sleep(300);
  check(!collab.onlineUserIds().has(bob.id), 'and his reconnect is refused');
  socket.destroy();
  await throws(() => collab.hocuspocus.configuration.onAuthenticate({ documentName: collab.docName(bobProject, 'main', 'main.tex'), requestHeaders: { authorization: `Bearer ${bobPat.token}` } }), 'Not authenticated', 'a socket with his token is refused');
  const again = await act(root.cookie, bob.id, 'disable');
  eq(again.json().disabledAt, off.json().disabledAt, 'disabling again changes nothing');
  eq(logs.filter((l) => l.includes(`disabled bob@example.org [${bob.id}]`)).length, 1, 'and logs nothing');

  // Provider sign-in: by subject (ORCID) and by address (a provider without subjects).
  const orla = await auth.findOrCreateOAuth({ subject: 'orcid:0000-0002-1825-0097', email: null, name: 'Orla' }, 'orcid');
  const ollie = await auth.findOrCreateOAuth({ email: 'ollie@example.org', name: 'Ollie' }, 'google');
  eq((await act(root.cookie, orla.id, 'disable')).statusCode, 200, 'disable an ORCID account');
  eq((await act(root.cookie, ollie.id, 'disable')).statusCode, 200, 'disable a Google account');
  await throws(() => auth.findOrCreateOAuth({ subject: 'orcid:0000-0002-1825-0097', email: null, name: 'Orla' }, 'orcid'), auth.ACCOUNT_DISABLED, 'ORCID sign-in is refused');
  await throws(() => auth.findOrCreateOAuth({ email: 'ollie@example.org', name: 'Ollie' }, 'google'), auth.ACCOUNT_DISABLED, 'sign-in by a provider\'s address is refused');
  const rows = (await call('GET', '/api/admin/users', root.cookie)).json();
  eq(rows.find((u) => u.id === orla.id).signIn, 'ORCID', 'the table names the sign-in method');
  eq([rows.find((u) => u.id === bob.id).signIn, rows.find((u) => u.id === bob.id).password], ['Password', true], 'a password account');
  eq(rows.find((u) => u.id === ollie.id).password, false, 'a provider account has no password');

  // A sign-in whose password check, and a token request, were under way when the account was disabled.
  const racing = await auth.createSession(bob.id);
  eq(await auth.verifyToken(racing), null, 'a session created while disabled is refused');
  const racingPat = await auth.createAccessToken(bob.id, 'late', null, null);

  // ---- enable: the tokens work again ----
  eq((await act(root.cookie, bob.id, 'enable')).json().disabledAt, undefined, 'the administrator enables Bob');
  eq(await db().getSession(racing), null, 'and does not come back with the account');
  check((await db().getToken(racingPat.record.id)).revokedAt, 'nor does a token minted while disabled');
  eq((await remotes.resolveConnection(link, carol.id, { allowService: false }))?.token, 'bobs-github-token', 'the linked connection serves the project again');
  check(audited(`enabled bob@example.org [${bob.id}]`), 'the log says so');
  const back = await login('bob@example.org');
  eq(back.statusCode, 200, 'Bob signs in again');
  bob.cookie = cookieOf(back);
  eq((await call('GET', '/api/projects', null, undefined, bearer(bobPat.token))).statusCode, 200, 'his access token works again');
  const rotated = await refreshTokens(ISSUER, { refresh_token: pair.refresh_token, client_id: 'aldc_test' });
  check(typeof rotated.refresh_token === 'string', 'and the connector refreshes');
  eq((await act(root.cookie, orla.id, 'enable')).statusCode, 200, 'enable the ORCID account');
  eq((await auth.findOrCreateOAuth({ subject: 'orcid:0000-0002-1825-0097', email: null, name: 'Orla' }, 'orcid')).id, orla.id, 'and ORCID sign-in works again');

  // ---- disable, revoking the tokens for good ----
  eq((await act(root.cookie, bob.id, 'disable', { revokeAgentAccess: true })).statusCode, 200, 'disable and revoke');
  check(audited(`disabled bob@example.org [${bob.id}] (access tokens and agent connections revoked)`), 'the log says the tokens went too');
  await act(root.cookie, bob.id, 'enable');
  eq((await call('GET', '/api/projects', null, undefined, bearer(bobPat.token))).statusCode, 401, 'after enabling, the revoked token stays refused');
  await throws(() => refreshTokens(ISSUER, { refresh_token: rotated.refresh_token, client_id: 'aldc_test' }), 'invalid', 'and so does the connector');
  eq(await auth.listAccessTokens(bob.id), [], 'Bob\'s Agent access card is empty');
  bob.cookie = cookieOf(await login('bob@example.org'));

  // ---- guard rails ----
  const self = await act(root.cookie, root.id, 'disable');
  eq([self.statusCode, self.json().error], [403, 'You cannot disable your own account.'], 'an administrator cannot disable themselves');
  eq((await act(root.cookie, root.id, 'delete', { projects: 'trash', confirm: 'root@example.org' })).json().error, 'You cannot delete your own account.', 'nor delete themselves');
  const second = await signUp('second@example.org', 'Second');
  const listedAdmin = await act(root.cookie, second.id, 'disable');
  eq(listedAdmin.statusCode, 403, 'an account on ALDINE_ADMIN_EMAILS cannot be disabled here');
  check(/ALDINE_ADMIN_EMAILS/.test(listedAdmin.json().error), 'and the refusal names the list');
  eq((await act(root.cookie, second.id, 'delete', { projects: 'trash', confirm: 'second@example.org' })).statusCode, 403, 'nor deleted');
  eq((await call('GET', '/api/auth/me', second.cookie)).json().user?.id, second.id, 'the other administrator is untouched');
  // Someone signed up with an address on the list but never confirmed it: not an administrator.
  const squatter = await signUp('third@example.org', 'Not third', false);
  eq((await row(squatter.id)).admin, false, 'an unconfirmed address on the list is no administrator');
  const confirmSquatter = await act(root.cookie, squatter.id, 'confirm-email');
  eq(confirmSquatter.statusCode, 403, 'confirming an address on the list by hand is refused');
  check(/administrator/.test(confirmSquatter.json().error), 'because it would hand out admin rights');
  eq((await row(squatter.id)).emailPending, true, 'the address stays unconfirmed');
  eq((await act(root.cookie, squatter.id, 'reset-link')).statusCode, 403, 'nor is its reset link shown: following it would confirm the address');
  eq((await act(root.cookie, squatter.id, 'disable')).statusCode, 200, 'the squatter can be disabled');

  // ---- confirm an address by hand ----
  const dan = await signUp('dan@example.org', 'Dan', false);
  const shared = await project(root.cookie, 'For Dan');
  await shareWith(shared, ['dan@example.org']);
  check(!(await listed(dan.cookie)).includes(shared), 'before: the share does not count for an unconfirmed address');
  const confirmed = await act(root.cookie, dan.id, 'confirm-email');
  eq([confirmed.statusCode, confirmed.json().emailPending], [200, false], 'the administrator confirms Dan\'s address');
  check(audited(`confirmed the address of dan@example.org [${dan.id}]`), 'the log says so');
  check((await listed(dan.cookie)).includes(shared), 'the share applies at once');
  eq((await act(root.cookie, dan.id, 'confirm-email')).statusCode, 200, 'confirming again is a no-op');

  // ---- password reset link (no email on this server) ----
  const reset = await act(root.cookie, bob.id, 'reset-link');
  eq(reset.statusCode, 200, 'the administrator asks for Bob\'s reset link');
  eq(reset.json().sent, false, 'nothing is mailed');
  eq(reset.headers['cache-control'], 'no-store', 'the answer carrying the secret is not cached');
  const token = new URL(reset.json().link, 'http://x').searchParams.get('reset_token');
  check(/^\/\?reset_token=/.test(reset.json().link) && token, `the link is the sign-in page's reset link (${reset.json().link})`);
  check(audited(`created a password reset link for bob@example.org [${bob.id}]`), 'the log says so');
  check(!logs.some((l) => l.includes(token)), 'the log never holds the secret');
  eq((await call('POST', '/api/auth/reset', null, { token, newPassword: 'another-password' })).statusCode, 200, 'the link resets the password');
  eq((await login('bob@example.org', 'another-password')).statusCode, 200, 'Bob signs in with the new one');
  bob.cookie = cookieOf(await login('bob@example.org', 'another-password'));
  const sso = await act(root.cookie, orla.id, 'reset-link');
  eq(sso.statusCode, 400, 'an ORCID account has no reset link');
  check(/ORCID/.test(sso.json().error), 'and the refusal names the provider');
  eq((await act(root.cookie, second.id, 'reset-link')).statusCode, 403, 'another administrator\'s link is never shown');
  eq((await act(root.cookie, root.id, 'reset-link')).statusCode, 200, 'the administrator\'s own is');

  // ---- delete, giving the projects to another account ----
  const erin = await signUp('erin@example.org', 'Erin');
  const frank = await signUp('frank@example.org', 'Frank');
  const live = await project(erin.cookie, 'Erin live');
  const binned = await project(erin.cookie, 'Erin binned');
  await shareWith(live, ['carol@example.org', 'dan@example.org']);
  const erinsInvite = await invite(erin.cookie, live, 'zoe@example.org');
  const meta = await db().readMeta(live);
  await db().writeMeta({ ...meta, zotero: { apiKey: 'erins-key', userId: 7, libraryPrefix: 'users/7', bibFile: 'zotero.bib' } });
  eq((await call('DELETE', `/api/projects/${binned}`, erin.cookie)).statusCode, 200, 'Erin trashes one project');
  const franks = await project(frank.cookie, 'Frank paper');
  await shareWith(franks, ['Erin@Example.org', 'dan@example.org'], 'link');
  const forErin = await project(frank.cookie, 'For Erin');
  const toErin = await invite(frank.cookie, forErin, 'erin@example.org');
  const erinPat = await auth.createAccessToken(erin.id, 'cli', null, null);

  const wrong = await act(root.cookie, erin.id, 'delete', { projects: 'transfer', transferTo: carol.id, confirm: 'erin' });
  eq([wrong.statusCode, wrong.json().error], [400, 'Type erin@example.org to confirm.'], 'the typed confirmation must be the address');
  eq((await act(root.cookie, erin.id, 'delete', { confirm: 'erin@example.org' })).statusCode, 400, 'what happens to the projects must be chosen');
  eq((await act(root.cookie, erin.id, 'delete', { projects: 'transfer', transferTo: 'nobody', confirm: 'erin@example.org' })).statusCode, 400, 'to an account that exists');
  eq((await act(root.cookie, erin.id, 'delete', { projects: 'transfer', transferTo: erin.id, confirm: 'erin@example.org' })).statusCode, 400, 'other than the one deleted');
  const toDisabled = await act(root.cookie, erin.id, 'delete', { projects: 'transfer', transferTo: squatter.id, confirm: 'erin@example.org' });
  eq(toDisabled.statusCode, 400, 'and not disabled');
  check(/disabled/.test(toDisabled.json().error), 'the refusal says it is disabled');
  check(await db().getUser(erin.id), 'none of the refused deletes removed anything');

  const gone = await act(root.cookie, erin.id, 'delete', { projects: 'transfer', transferTo: carol.id, confirm: ' ERIN@example.org ' });
  eq(gone.statusCode, 200, `the administrator deletes Erin (${gone.body})`);
  eq([gone.json().transferred, gone.json().trashed, gone.json().sharesRemoved], [2, 0, 1], 'two projects to Carol, one share removed');
  check(audited(`deleted erin@example.org [${erin.id}] (2 projects to carol@example.org [${carol.id}], taken off 1 share list)`), 'the log says what went where');
  const given = await db().readMeta(live);
  eq(given.ownerId, carol.id, 'Carol owns the live project');
  eq(given.share.collaborators, ['dan@example.org'], 'and is no longer listed as its collaborator');
  eq(given.zotero, undefined, 'Erin\'s Zotero key does not go with it');
  const carolsList = (await call('GET', '/api/projects', carol.cookie)).json();
  eq(carolsList.find((p) => p.id === live)?.access, 'owner', 'the project is on Carol\'s list as hers');
  check((await call('GET', '/api/projects/trash', carol.cookie)).json().some((p) => p.id === binned), 'the trashed one is in Carol\'s trash');
  check((await listed(dan.cookie)).includes(live), 'Dan keeps his access');
  eq((await db().readMeta(franks)).share.collaborators, ['dan@example.org'], 'Erin is off Frank\'s share list');
  eq(await invitationState(toErin), 'withdrawn', 'an open invitation to her address is withdrawn');
  eq(await invitationState(erinsInvite), 'withdrawn', 'and so are the ones she made on a project that changed hands');
  eq(await db().getUser(erin.id), null, 'the account is gone');
  eq((await call('GET', '/api/auth/me', erin.cookie)).json().user, null, 'and its session');
  eq((await call('GET', '/api/projects', null, undefined, bearer(erinPat.token))).statusCode, 401, 'and its access token');
  eq((await login('erin@example.org')).json().error, 'Incorrect email or password', 'nobody can sign in to it');
  const reborn = await signUp('erin@example.org', 'Erin again');
  check(!(await listed(reborn.cookie)).includes(franks) && !(await listed(reborn.cookie)).includes(live), 'a new account with the address inherits nothing');

  // ---- delete, moving the projects to the trash ----
  const gus = await signUp('gus@example.org', 'Gus');
  const gusProject = await project(gus.cookie, 'Gus paper');
  await shareWith(gusProject, ['dan@example.org']);
  const binnedAll = await act(root.cookie, gus.id, 'delete', { projects: 'trash', confirm: 'gus@example.org' });
  eq([binnedAll.statusCode, binnedAll.json().trashed, binnedAll.json().transferred], [200, 1, 0], 'deleting Gus trashes his project');
  check(audited(`deleted gus@example.org [${gus.id}] (1 project to the trash, taken off 0 share lists)`), 'the log says so');
  check(typeof (await db().readMeta(gusProject)).deletedAt === 'string', 'the project is in the trash');
  check(!(await listed(dan.cookie)).includes(gusProject), 'and gone for its collaborators');
  const forThird = await project(root.cookie, 'For the real third');
  await shareWith(forThird, ['third@example.org']);
  const toThird = await invite(root.cookie, await project(root.cookie, 'Invite for the real third'), 'third@example.org');
  eq((await act(root.cookie, squatter.id, 'delete', { projects: 'trash', confirm: 'third@example.org' })).statusCode, 200, 'the squatter on an admin address can be deleted');
  eq((await db().readMeta(forThird)).share.collaborators, ['third@example.org'], 'an invite to the address it never confirmed stays, for the address\'s owner');
  eq(await invitationState(toThird), 'pending', 'an invitation to it as well');
  // An account without an address confirms with its name.
  eq((await act(root.cookie, orla.id, 'delete', { projects: 'trash', confirm: 'orcid' })).json().error, 'Type Orla to confirm.', 'an account without an address is confirmed by its name');
  eq((await act(root.cookie, orla.id, 'delete', { projects: 'trash', confirm: 'Orla' })).statusCode, 200, 'and deleted');
  check(audited(`deleted orcid:0000-0002-1825-0097 [${orla.id}]`), 'the log names an account without an address by its ORCID iD');
  const remaining = (await call('GET', '/api/admin/users', root.cookie)).json().map((u) => u.email);
  check(!remaining.includes('gus@example.org') && !remaining.includes('third@example.org'), 'the table no longer lists them');

  console.log('✓ admin accounts: guard, disable on every path, enable, revoke, guard rails, confirm, reset link, delete');
} finally {
  for (const s of sockets) s.destroy();
  await app.close();
  await closeDb();
  wss.close();
  wsServer.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
