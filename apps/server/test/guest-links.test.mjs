/**
 * Guests on share links (#328): someone without an account opens a link
 * that admits guests, gives a name, and works in that one project under the
 * link's role, never typesetting and never reaching anything an account
 * has. The guest is an entry on the link and a signed cookie of their own;
 * revoking, expiring or closing the link to guests ends them at once, like
 * the accounts that came in through it. Joins are rate limited per address
 * and per link, and guests count toward a link's member places.
 *
 * Real route table (Fastify inject) on a throwaway datastore.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-guest-links-')));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.ALDINE_AUTOCOMMIT_MS = '600000';
process.env.RL_GUEST_JOIN_BURST = '3';
process.env.RL_GUEST_LINK_BURST = '6';
for (const k of ['DATABASE_URL', 'REDIS_URL', 'SES_FROM', 'SMTP_HOST', 'ALDINE_PUBLIC_URL', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_BASE_PATH', 'ALDINE_TEST_HOOKS']) delete process.env[k];

const { initDb, db } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const store = await import('../src/store.ts');
const collab = await import('../src/collab.ts');
const { linkAccessEnds } = await import('../src/sharelinks.ts');
const { GUEST_COOKIE } = await import('../src/guest.ts');
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;
const app = Fastify();
await registerRoutes(app);
await app.ready();

// Every request comes from its own address unless a test says otherwise,
// so only the rate-limit checks meet the per-address limit.
let ipN = 0;
const nextIp = () => `10.0.${Math.floor(++ipN / 250)}.${ipN % 250 + 1}`;
const call = (method, url, who, payload, ip = nextIp()) => app.inject({ method, url, remoteAddress: ip, headers: who?.cookie ? { cookie: who.cookie } : {}, ...(payload ? { payload } : {}) });
const json = async (method, url, who, payload, code = 200) => {
  const res = await call(method, url, who, payload);
  eq(res.statusCode, code, `${method} ${url} as ${who?.name ?? 'nobody'}: ${res.body.slice(0, 200)}`);
  return res.json();
};
async function person(email, name) {
  const user = await auth.register(email, 'password123', name);
  await db().setEmailPending(user.id, null);
  return { id: user.id, name, email, cookie: `${auth.COOKIE}=${await auth.createSession(user.id)}` };
}
/** The guest cookie a response set, as a browser would send it back. */
const guestCookieOf = (res) => {
  const set = [res.headers['set-cookie']].flat().find((c) => c?.startsWith(`${GUEST_COOKIE}=`));
  return set ? set.split(';')[0] : null;
};
const guestJoin = async (token, name, { project = P, cookie, ip } = {}) => {
  const res = await call('POST', '/api/share-links/guest', cookie ? { cookie } : null, { project, token, name }, ip);
  const got = guestCookieOf(res);
  return { res, who: got ? { name, cookie: got } : null };
};
const socket = async (who, project = P) => {
  const connection = { readOnly: false };
  try {
    const ctx = await collab.hocuspocus.configuration.onAuthenticate({ documentName: collab.docName(project, 'main', 'main.tex'), requestHeaders: who?.cookie ? { cookie: who.cookie } : {}, connection });
    return { mode: connection.readOnly ? 'read-only' : 'read-write', ctx };
  } catch (err) { return { mode: err.message }; }
};

const owner = await person('owner@example.com', 'Olive');
const sam = await person('sam@example.org', 'Sam');
const P = (await json('POST', '/api/projects', owner, { name: 'Paper' })).id;
const Q = (await json('POST', '/api/projects', owner, { name: 'Other' })).id;
const links = `/api/projects/${P}/links`;

// ---- a link admits guests only when the owner says so ----
eq((await call('POST', links, owner, { role: 'edit', guests: 'yes' })).statusCode, 400, 'guests is true or false');
const plain = (await json('POST', links, owner, { role: 'edit' })).link;
eq(plain.guests, false, 'a new link admits accounts only unless asked');
const edit = (await json('POST', links, owner, { role: 'edit', guests: true })).link;
const review = (await json('POST', links, owner, { role: 'review', guests: true, label: 'Dr. Reviewer' })).link;
const view = (await json('POST', links, owner, { role: 'view', guests: true })).link;
eq([edit.guests, edit.joinedGuests], [true, 0], 'the owner sees which links admit guests');

const peek = (token, project = P) => call('POST', '/api/share-links/peek', null, { project, token });
eq((await peek(plain.token)).json(), { project: 'Paper', role: 'edit', guests: false }, 'a visitor learns that a link needs an account');
eq((await peek(review.token)).json(), { project: 'Paper', role: 'review', guests: true, label: 'Dr. Reviewer' }, 'and, for a guest link, its role and name');
eq((await peek('A'.repeat(43))).statusCode, 404, 'a wrong token tells nothing');

const refusedPlain = await guestJoin(plain.token, 'Gus');
eq([refusedPlain.res.statusCode, refusedPlain.res.json().code, refusedPlain.who], [403, 'account-only', null], 'an accounts-only link lets no guest in');
eq((await guestJoin(edit.token, '   ')).res.json().code, 'name', 'a guest gives a name');
eq((await guestJoin(edit.token, 'x'.repeat(61))).res.statusCode, 400, 'of up to 60 characters');
eq((await guestJoin(edit.token, '<>')).res.statusCode, 400, 'and not only brackets, which a commit author line would read as an address');
eq((await guestJoin(edit.token, 'Gus', { project: Q })).res.statusCode, 404, 'a token works for its own project only');
eq((await call('POST', '/api/share-links/guest', sam, { project: P, token: edit.token, name: 'Sam' })).json().code, 'signed-in', 'someone signed in joins with their account instead');

// ---- an edit guest ----
const { res: joined, who: gus } = await guestJoin(edit.token, '  Gus‮  Tester ');
eq(joined.statusCode, 200, `the guest joins: ${joined.body}`);
eq([joined.json().role, joined.json().guest.name], ['edit', 'Gus Tester (guest)'], 'with the link\'s role, under the name they gave, marked as a guest');
const setCookie = [joined.headers['set-cookie']].flat().find((c) => c.startsWith(`${GUEST_COOKIE}=`));
check(/HttpOnly/.test(setCookie) && /SameSite=Lax/.test(setCookie) && /Path=\//.test(setCookie), 'the guest cookie is httpOnly and SameSite like the session');
const gusView = await json('GET', `/api/projects/${P}`, gus);
eq([gusView.role, gusView.guest, gusView.isMember, gusView.isOwner, gusView.canEdit], ['edit', true, false, false, true], 'the project tells the guest their role');
eq(gusView.share, { mode: 'link', collaborators: [] }, 'a guest sees no links and no tokens');
eq((await json('GET', '/api/auth/me', gus)).user, null, '/me names no account');
const me = await json('GET', `/api/auth/guest?project=${P}`, gus);
eq([me.guest?.name, me.guest?.projectId], ['Gus Tester (guest)', P], 'the guest on their project page');
eq((await json('GET', `/api/auth/guest?project=${Q}`, gus)).guest, null, 'and on no other project');
eq((await json('GET', `/api/auth/guest?project=${P}`, sam)).guest, null, 'and nobody signed in is a guest');
eq((await json('GET', `/api/projects/${P}`, owner)).share.links.find((l) => l.id === edit.id).joinedGuests, 1, 'the owner sees one guest came in');

eq((await call('PUT', `/api/projects/${P}/file`, gus, { path: 'guest.tex', content: 'Hello from a guest' })).statusCode, 200, 'an edit guest changes files');
const c = await json('POST', `/api/projects/${P}/comments`, gus, { file: 'main.tex', anchor: { from: 0, to: 4, quote: '\\doc' }, body: 'Nice', author: 'Olive' });
eq(c.author, 'Gus Tester (guest)', 'a comment carries the guest\'s name, whatever the client claims');
const committed = await json('POST', `/api/projects/${P}/commit`, gus, { branch: 'main', message: 'Guest work', author: 'Olive' });
check(committed.committed, 'an edit guest commits');
const log = await json('GET', `/api/projects/${P}/log?branch=main&limit=1`, gus);
eq(log.commits?.[0]?.author ?? log[0]?.author, 'Gus Tester (guest)', 'the commit is the guest\'s, marked as a guest');
const gusSocket = await socket(gus);
eq([gusSocket.mode, gusSocket.ctx?.userName], ['read-write', 'Gus Tester (guest)'], 'an edit guest types live, under their name');

// Never a typeset, never an account's things.
const typeset = await call('POST', `/api/projects/${P}/compile`, gus, { branch: 'main' });
eq([typeset.statusCode, typeset.json().code], [403, 'guest'], 'a guest never typesets, whatever the role');
check(/see the PDF/.test(typeset.json().error), 'and is told the PDF comes from the others');
eq((await call('GET', `/api/projects/${P}/compile-status?branch=main`, gus)).statusCode, 200, 'a guest sees the latest typeset');
for (const [method, route, body] of [
  ['POST', '/compile/stop', { branch: 'main' }], ['POST', '/copy', {}], ['POST', '/opened', { branch: 'main' }], ['PUT', '/listing', {}],
  ['PATCH', '', { name: 'Mine' }], ['POST', '/branches', { name: 'fork', from: 'main' }], ['DELETE', '/branches?branch=main', null], ['POST', '/merge', {}],
  ['POST', '/links', { role: 'edit' }], ['POST', '/share', { collaborators: [] }], ['POST', '/invitations', { to: 'x@example.org' }],
  ['GET', '/invitations', null], ['GET', '/remote/access', null], ['GET', '/zotero/search?q=x', null], ['POST', '/format', {}],
  ['POST', '/ai/fix', {}], ['GET', '/agent-activity?branch=main', null], ['POST', '/agent-activity/seen', {}], ['POST', '/claim', {}], ['DELETE', '', null],
]) {
  eq((await call(method, `/api/projects/${P}${route}`, gus, body)).statusCode, 403, `a guest cannot ${method} ${route || 'the project'}`);
}
for (const [method, url] of [['GET', '/api/projects'], ['POST', '/api/projects'], ['GET', '/api/tokens'], ['POST', '/api/tokens'], ['GET', '/api/invitations'], ['GET', '/api/zotero/key'], ['GET', '/api/projects/trash']]) {
  eq((await call(method, url, gus, method === 'POST' ? { name: 'x' } : undefined)).statusCode, 401, `a guest is nobody at ${method} ${url}`);
}
eq((await call('GET', `/api/projects/${Q}`, gus)).statusCode, 401, 'a guest is nobody on another project');
check(/not authenticated/i.test((await socket(gus, Q)).mode), 'and cannot open its documents');

// The cookie is no session, and cannot be bent into one.
const value = gus.cookie.slice(GUEST_COOKIE.length + 1);
eq((await call('GET', `/api/projects/${P}`, { cookie: `${auth.COOKIE}=${value}` })).statusCode, 401, 'the guest cookie is not a session cookie');
const forged = value.replace(P, Q);
eq((await call('GET', `/api/projects/${Q}`, { cookie: `${GUEST_COOKIE}=${forged}` })).statusCode, 401, 'an entry moved to another project does not verify');
const [pid, lid, gid, sig] = value.split('.');
eq((await call('GET', `/api/projects/${P}`, { cookie: `${GUEST_COOKIE}=${pid}.${review.id}.${gid}.${sig}` })).statusCode, 401, 'nor one moved to another link');
eq((await call('GET', `/api/projects/${P}`, { cookie: `${GUEST_COOKIE}=${pid}.${lid}.${'A'.repeat(16)}.${sig}` })).statusCode, 401, 'nor one for another guest');

// Joining again from the same browser keeps the guest.
const again = await guestJoin(edit.token, 'Gus T.', { cookie: gus.cookie });
eq([again.res.statusCode, again.res.json().guest.id], [200, joined.json().guest.id], 'the same browser stays the same guest');
eq((await json('GET', `/api/projects/${P}`, owner)).share.links.find((l) => l.id === edit.id).joined, 1, 'and takes one place on the link');
gus.cookie = again.who.cookie;
eq((await json('GET', `/api/auth/guest?project=${P}`, gus)).guest.name, 'Gus T. (guest)', 'under the new name');

// ---- review and view guests ----
const { who: rae } = await guestJoin(review.token, 'Rae');
const { who: vin } = await guestJoin(view.token, 'Vin');
const write = (who) => call('PUT', `/api/projects/${P}/file`, who, { path: `by-${who.name.toLowerCase()}.tex`, content: 'x' }).then((r) => r.statusCode);
const comment = (who) => call('POST', `/api/projects/${P}/comments`, who, { file: 'main.tex', anchor: { from: 0, to: 4, quote: '\\doc' }, body: `${who.name} says`, suggestion: 'better' }).then((r) => r.statusCode);
eq([await write(rae), await comment(rae), (await socket(rae)).mode], [403, 200, 'read-only'], 'a review guest comments and suggests, and cannot change text');
eq([await write(vin), await comment(vin), (await socket(vin)).mode], [403, 403, 'read-only'], 'a view guest reads only');
eq((await call('POST', `/api/projects/${P}/compile`, vin, { branch: 'main' })).statusCode, 403, 'and cannot typeset');
eq((await call('GET', `/api/projects/${P}/file?path=main.tex`, vin)).statusCode, 200, 'a view guest reads a file');

// ---- a browser can be a guest in several projects ----
const qLink = (await json('POST', `/api/projects/${Q}/links`, owner, { role: 'view', guests: true })).link;
const both = await guestJoin(qLink.token, 'Gus', { project: Q, cookie: gus.cookie });
const bothWho = { name: 'Gus', cookie: both.who.cookie };
eq([(await call('GET', `/api/projects/${P}`, bothWho)).json().role, (await call('GET', `/api/projects/${Q}`, bothWho)).json().role], ['edit', 'view'], 'one cookie holds a guest per project, each with its own link\'s role');

// ---- revoking ends guest sessions at once ----
const doc = await collab.hocuspocus.openDirectConnection(collab.docName(P, 'main', 'main.tex'), {});
let drops = 0;
const close = collab.hocuspocus.closeConnections.bind(collab.hocuspocus);
collab.hocuspocus.closeConnections = (name) => { if (name?.startsWith(`${P}::`)) drops++; return close(name); };
await json('DELETE', `${links}/${review.id}`, owner);
check(drops > 0, 'revoking drops the open sockets, guests\' too');
const ended = await call('GET', `/api/projects/${P}`, rae);
eq([ended.statusCode, ended.json().code], [403, 'guest-ended'], 'the guest is out at once, and told why');
check(/not authenticated/i.test((await socket(rae)).mode), 'and their socket is refused when it reconnects');
eq((await json('GET', `/api/auth/guest?project=${P}`, rae)).guest, null, 'they are no guest there any more');
eq((await guestJoin(review.token, 'Rae')).res.json().code, 'revoked', 'and the link says it was turned off');
eq((await call('GET', `/api/projects/${P}`, gus)).json().role, 'edit', 'guests of the other links stay');

// ---- closing a link to guests ends them, and opening it again brings none back ----
drops = 0;
await json('PATCH', `${links}/${edit.id}`, owner, { guests: false });
check(drops > 0, 'closing a link to guests drops the sockets');
eq((await call('GET', `/api/projects/${P}`, gus)).json().code, 'guest-ended', 'the edit guest is out');
await json('PATCH', `${links}/${edit.id}`, owner, { guests: true });
eq((await call('GET', `/api/projects/${P}`, gus)).statusCode, 403, 'and stays out when the link admits guests again');
eq((await json('GET', `/api/projects/${P}`, owner)).share.links.find((l) => l.id === edit.id).joinedGuests, 0, 'the link forgot its guests');
eq((await call('PATCH', `${links}/address`, owner, { guests: true })).statusCode, 404, 'there is no address link here to open to guests');
const L = (await json('POST', '/api/projects', owner, { name: 'Legacy' })).id;
await db().writeMeta({ ...(await db().readMeta(L)), share: { mode: 'link', collaborators: [] } });
eq((await call('PATCH', `/api/projects/${L}/links/address`, owner, { guests: true })).statusCode, 400, 'the project\'s address never admits guests');

// ---- expiry ----
const week = (await json('POST', links, owner, { role: 'edit', guests: true, expiresAt: new Date(Date.now() + 864e5).toISOString() })).link;
const { who: eve, res: eveRes } = await guestJoin(week.token, 'Eve');
check(Math.abs(linkAccessEnds(await store.readMeta(P), eveRes.json().guest.id) - Date.parse(week.expiresAt)) < 1000, 'a guest\'s socket learns when the link expires');
await store.updateMeta(P, (m) => ({ ...m, share: { ...m.share, links: m.share.links.map((l) => (l.id === week.id ? { ...l, expiresAt: new Date(Date.now() - 1000).toISOString() } : l)) } }));
eq((await call('GET', `/api/projects/${P}`, eve)).json().code, 'guest-ended', 'a guest is out once the link expires');

// ---- rate limits ----
const burst = (await json('POST', links, owner, { role: 'view', guests: true })).link;
const sameIp = [];
for (let i = 0; i < 4; i++) sameIp.push((await guestJoin(burst.token, `N${i}`, { ip: '192.0.2.7' })).res.statusCode);
eq(sameIp, [200, 200, 200, 429], 'one address gets a few guest joins in a row, then waits');
const perLink = [];
for (let i = 0; i < 4; i++) perLink.push((await guestJoin(burst.token, `M${i}`)).res.statusCode);
eq(perLink, [200, 200, 200, 429], 'one link gets a few new guests in a row from anywhere, then waits');

// ---- guests take the link's member places ----
const cap = (await json('POST', links, owner, { role: 'view', guests: true })).link;
await store.updateMeta(P, (m) => ({ ...m, share: { ...m.share, links: m.share.links.map((l) => (l.id === cap.id ? { ...l, members: Array.from({ length: 499 }, (_, i) => ({ id: `guest:${String(i).padStart(16, 'x')}`, at: l.createdAt, name: 'g' })) } : l)) } }));
eq((await guestJoin(cap.token, 'Last')).res.statusCode, 200, 'the 500th person on a link may be a guest');
eq((await guestJoin(cap.token, 'One more')).res.json().code, 'full', 'and then the link is full for guests');
eq((await call('POST', '/api/share-links/join', sam, { project: P, token: cap.token })).json().code, 'full', 'and for accounts');

await doc.disconnect();
await app.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('guest links: ok');
process.exit(0);
