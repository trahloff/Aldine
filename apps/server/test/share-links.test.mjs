/**
 * Share links (#328): several per project, each with its own token, role,
 * name and optional expiry. Someone signed in comes in through a link's
 * token and gets its role; the address of the project alone lets nobody in.
 * Revoking or expiring a link ends the access of everyone who came in
 * through it at once (REST, the collab socket, their project list), and of
 * no one else. Link sharing written before 1.17 reads as one link without a
 * token, so the project's address keeps working, and "Can view" then (which
 * could comment) reads as "Can review".
 *
 * Real route table (Fastify inject) on a throwaway datastore.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-share-links-')));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.ALDINE_AUTOCOMMIT_MS = '600000';
for (const k of ['DATABASE_URL', 'REDIS_URL', 'SES_FROM', 'SMTP_HOST', 'ALDINE_PUBLIC_URL', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_BASE_PATH', 'ALDINE_TEST_HOOKS']) delete process.env[k];

const { initDb, db } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const store = await import('../src/store.ts');
const collab = await import('../src/collab.ts');
const { roleOf } = await import('../src/authz.ts');
const { normalizeShare, linkAccessEnds } = await import('../src/sharelinks.ts');
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;
const app = Fastify();
await registerRoutes(app);
await app.ready();

const call = (method, url, who, payload) => app.inject({ method, url, headers: who ? { cookie: who.cookie } : {}, ...(payload ? { payload } : {}) });
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
const owner = await person('owner@example.com', 'Olive');
const ed = await person('ed@example.org', 'Ed');
const rita = await person('rita@example.org', 'Rita');
const vic = await person('vic@example.org', 'Vic');
const ivy = await person('ivy@example.org', 'Ivy');
const stan = await person('stan@example.org', 'Stan');

// ---- link sharing before 1.17 reads as links and roles ----
const legacy = { mode: 'link', linkRole: 'view', collaborators: ['a@example.org', 'b@example.org'], viewers: ['A@example.org'] };
const read = normalizeShare(legacy, '2026-01-01T00:00:00.000Z');
eq(read, { collaborators: ['a@example.org', 'b@example.org'], roles: { 'a@example.org': 'review' }, links: [{ id: 'address', role: 'review', createdAt: '2026-01-01T00:00:00.000Z' }] }, 'the link becomes the address link, "view" with comments becomes "review"');
eq(normalizeShare(legacy, '2026-01-01T00:00:00.000Z'), read, 'reading it again gives the same link');
eq(normalizeShare({ mode: 'private', collaborators: [] }, 'x'), { collaborators: [], links: [] }, 'a private share has no links');
eq(normalizeShare({ mode: 'link', collaborators: [] }, 'x').links[0].role, 'edit', 'a link without a role could edit');
eq(normalizeShare(read, 'x'), read, 'a share in the new shape stays as it is');

const L = (await json('POST', '/api/projects', owner, { name: 'Legacy' })).id;
await db().writeMeta({ ...(await db().readMeta(L)), share: { mode: 'link', collaborators: [] } });
eq((await json('GET', `/api/projects/${L}`, stan)).role, 'edit', "an old link-shared project still opens at its address, with the old link's role");
eq((await json('GET', `/api/projects/${L}`, owner)).share, { mode: 'link', collaborators: [], links: [{ id: 'address', role: 'edit', createdAt: (await db().readMeta(L)).createdAt, joined: 0 }] }, 'the owner sees it as a link without a token');
await json('DELETE', `/api/projects/${L}/links/address`, owner);
eq((await call('GET', `/api/projects/${L}`, stan)).statusCode, 403, 'revoking the address link closes the address');
eq((await json('GET', `/api/projects/${L}`, owner)).share, { mode: 'private', collaborators: [] }, 'a revoked link is not shown, and the share reads as private');
eq((await db().readMeta(L)).share.mode, undefined, 'the share is stored in the new shape from the first write');

// ---- creating links: the owner's alone ----
const P = (await json('POST', '/api/projects', owner, { name: 'Draft' })).id;
const links = `/api/projects/${P}/links`;
eq((await json('GET', `/api/projects/${P}`, owner)).share, { mode: 'private', collaborators: [] }, 'a new project has no links');
await json('POST', `/api/projects/${P}/share`, owner, { collaborators: [ivy.email], previous: [] });
await json('POST', `/api/invitations/${(await json('GET', '/api/invitations', ivy)).find((i) => i.project.id === P).id}/accept`, ivy);

eq((await call('POST', links, ivy, { role: 'edit' })).statusCode, 403, 'a collaborator cannot create links');
eq((await call('POST', links, owner, { role: 'admin' })).statusCode, 400, 'a role is edit, review or view');
eq((await call('POST', links, owner, { role: 'view', expiresAt: '2020-01-01T00:00:00Z' })).statusCode, 400, 'an expiry in the past is refused');
eq((await call('POST', links, owner, { role: 'view', label: 'x'.repeat(81) })).statusCode, 400, 'a long name is refused');
const made = {};
for (const [role, label] of [['edit', 'Co-authors'], ['review', 'Reviewers'], ['view', undefined]]) {
  const r = await json('POST', links, owner, { role, ...(label ? { label } : {}) });
  made[role] = r.link;
  check(/^[A-Za-z0-9_-]{43}$/.test(r.link.token), `the ${role} link has a long random token`);
  eq([r.link.role, r.link.label, r.link.joined], [role, label, 0], `the ${role} link has its role and name`);
}
const ownerView = await json('GET', `/api/projects/${P}`, owner);
eq([ownerView.share.mode, ownerView.share.links.length], ['link', 3], 'the owner sees all three');
check(new Set(Object.values(made).map((l) => l.token)).size === 3, 'each link has its own token');
const ivyView = await json('GET', `/api/projects/${P}`, ivy);
eq(ivyView.share, { mode: 'link', collaborators: [] }, 'a collaborator sees no links and no tokens');

// ---- the address alone lets nobody in ----
eq((await call('GET', `/api/projects/${P}`, stan)).statusCode, 403, 'a stranger with the address but no token is refused');
const join = (who, token, project = P) => call('POST', '/api/share-links/join', who, { project, token });
eq((await join(null, made.edit.token)).statusCode, 401, 'joining needs an account');
eq((await join(stan, 'A'.repeat(43))).statusCode, 404, 'a wrong token lets nobody in');
eq((await join(stan, made.edit.token, L)).statusCode, 404, 'a token works for its own project only');
eq((await call('GET', `/api/projects/${P}`, stan)).statusCode, 403, 'and the stranger is still out');

// ---- each role ----
eq((await join(ed, made.edit.token)).json().role, 'edit', 'Ed joins as an editor');
eq((await join(rita, made.review.token)).json().role, 'review', 'Rita joins as a reviewer');
eq((await join(vic, made.view.token)).json().role, 'view', 'Vic joins as a viewer');
eq((await join(ed, made.edit.token)).statusCode, 200, 'joining twice is fine');
eq((await json('GET', `/api/projects/${P}`, owner)).share.links.find((l) => l.id === made.edit.id).joined, 1, 'the owner sees how many came in, once each');
check(!JSON.stringify(await json('GET', `/api/projects/${P}`, owner)).includes(ed.id), 'and not who');
eq((await json('GET', `/api/projects/${P}`, rita)).role, 'review', 'the project tells Rita her role');

const write = (who) => call('PUT', `/api/projects/${P}/file`, who, { path: `by-${who.name.toLowerCase()}.tex`, content: 'x' }).then((r) => r.statusCode);
const comment = (who) => call('POST', `/api/projects/${P}/comments`, who, { file: 'main.tex', anchor: { from: 0, to: 4, quote: '\\doc' }, body: `${who.name} says`, suggestion: 'better' }).then((r) => r.statusCode);
const socket = async (who) => {
  const connection = { readOnly: false };
  try {
    await collab.hocuspocus.configuration.onAuthenticate({ documentName: collab.docName(P, 'main', 'main.tex'), requestHeaders: { cookie: who.cookie }, connection });
  } catch (err) { return err.message; }
  return connection.readOnly ? 'read-only' : 'read-write';
};
eq([await write(ed), await comment(ed), await socket(ed)], [200, 200, 'read-write'], 'an editor writes, comments and edits live');
eq([await write(rita), await comment(rita), await socket(rita)], [403, 200, 'read-only'], 'a reviewer comments and suggests, and cannot change text');
eq([await write(vic), await comment(vic), await socket(vic)], [403, 403, 'read-only'], 'a viewer reads only');
for (const [route, method, body] of [['branches', 'POST', { name: 'fork', from: 'main' }], ['commit', 'POST', { branch: 'main', message: 'x' }], ['settings', 'PATCH', null]]) {
  if (route === 'settings') {
    eq((await call('PATCH', `/api/projects/${P}`, rita, { name: 'Mine' })).statusCode, 403, 'a reviewer cannot change the settings');
    continue;
  }
  eq((await call(method, `/api/projects/${P}/${route}`, rita, body)).statusCode, 403, `a reviewer cannot ${route}`);
}
eq((await call('GET', `/api/projects/${P}/file?path=main.tex`, vic)).statusCode, 200, 'a viewer reads a file');
eq((await call('POST', `${links}`, rita, { role: 'edit' })).statusCode, 403, 'a link visitor cannot make links');

// ---- the project list ----
await json('POST', `/api/projects/${P}/opened`, rita, { branch: 'main' });
eq((await json('GET', '/api/projects', rita)).find((p) => p.id === P)?.access, 'link', "the project is on Rita's list, through a link");

// ---- revoking ----
// A loaded document of the project, so dropping its sockets is observable.
const conn = await collab.hocuspocus.openDirectConnection(collab.docName(P, 'main', 'main.tex'), {});
let drops = 0;
const close = collab.hocuspocus.closeConnections.bind(collab.hocuspocus);
collab.hocuspocus.closeConnections = (name) => { if (name?.startsWith(`${P}::`)) drops++; return close(name); };
eq((await call('DELETE', `${links}/${made.review.id}`, ivy)).statusCode, 403, 'a collaborator cannot revoke');
let before = drops;
const after = await json('DELETE', `${links}/${made.review.id}`, owner);
check(drops > before, 'revoking drops the open sockets, so they re-authenticate');
eq(after.share.links.map((l) => l.id).sort(), [made.edit.id, made.view.id].sort(), 'the revoked link is gone from the list');
eq((await call('GET', `/api/projects/${P}`, rita)).statusCode, 403, 'Rita is out at once');
check(/access denied/i.test(await socket(rita)), 'and her socket is refused when it reconnects');
check(!(await json('GET', '/api/projects', rita)).some((p) => p.id === P), 'and the project is off her list');
const again = await join(rita, made.review.token);
eq([again.statusCode, again.json().code], [410, 'revoked'], 'the link says it was turned off');
eq((await call('DELETE', `${links}/${made.review.id}`, owner)).statusCode, 404, 'a link is revoked once');
eq([await write(ed), (await json('GET', `/api/projects/${P}`, ivy)).role], [200, 'edit'], 'the other links and the invited people are unaffected');

// An invited person who also came in through a link keeps their own access.
await join(ivy, made.view.token);
await json('DELETE', `${links}/${made.view.id}`, owner);
eq([(await call('GET', `/api/projects/${P}`, vic)).statusCode, (await json('GET', `/api/projects/${P}`, ivy)).role], [403, 'edit'], 'revoking the view link shuts out Vic, not Ivy, who was invited');

// ---- changing a link ----
before = drops;
const changed = await json('PATCH', `${links}/${made.edit.id}`, owner, { role: 'review', label: 'Readers', expiresAt: null });
eq([changed.share.links[0].role, changed.share.links[0].label], ['review', 'Readers'], 'a link can get a new role and name');
check(drops > before, 'a narrower role drops the open sockets');
eq((await json('GET', `/api/projects/${P}`, ed)).role, 'review', 'and applies to the people who came in through it');

// ---- expiry ----
const soon = await json('POST', links, owner, { role: 'edit', label: 'Week', expiresAt: new Date(Date.now() + 864e5).toISOString() });
await join(stan, soon.link.token);
eq((await json('GET', `/api/projects/${P}`, stan)).role, 'edit', 'a link with an expiry lets people in until then');
const metaNow = await store.readMeta(P);
check(Math.abs(linkAccessEnds(metaNow, stan.id) - Date.parse(soon.link.expiresAt)) < 1000, "Stan's socket learns when his access ends");
eq(linkAccessEnds(metaNow, ivy.id), null, 'an invited person has no end');
// The day passes.
await store.updateMeta(P, (m) => ({ ...m, share: { ...m.share, links: m.share.links.map((l) => (l.id === soon.link.id ? { ...l, expiresAt: new Date(Date.now() - 1000).toISOString() } : l)) } }));
eq(roleOf(await store.readMeta(P), (await auth.getUser(stan.id))), null, 'an expired link gives nothing');
eq((await call('GET', `/api/projects/${P}`, stan)).statusCode, 403, 'Stan is out once it expires');
const late = await join(stan, soon.link.token);
eq([late.statusCode, late.json().code], [410, 'expired'], 'the link says it expired');
const listedExpired = (await json('GET', `/api/projects/${P}`, owner)).share.links.find((l) => l.id === soon.link.id);
check(!!listedExpired, 'the owner still sees the expired link, to revoke or replace it');

// An open socket whose link expired is closed by the sweep.
const doc = collab.hocuspocus.documents.get(collab.docName(P, 'main', 'main.tex'));
let closed = 0;
const fake = { context: { userId: stan.id, accessUntil: Date.now() - 1 }, close: () => { closed++; } };
const live = { context: { userId: ivy.id }, close: () => { closed += 100; } };
const getConnections = doc.getConnections.bind(doc);
doc.getConnections = () => [...getConnections(), fake, live];
eq(collab.closeExpiredLinkSessions(), 1, 'the sweep closes the socket of the expired link');
eq(closed, 1, 'and not the invited person\'s');
doc.getConnections = getConnections;

// ---- joins race a revoke: the revoke wins ----
const race = await json('POST', links, owner, { role: 'edit' });
const people = await Promise.all(['r1', 'r2', 'r3'].map((n) => person(`${n}@example.org`, n)));
await Promise.all([...people.map((p) => join(p, race.link.token)), call('DELETE', `${links}/${race.link.id}`, owner)]);
for (const p of people) eq((await call('GET', `/api/projects/${P}`, p)).statusCode, 403, `${p.name} has no access once the link is revoked, however the race went`);

await conn.disconnect();
await app.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('share links: ok');
process.exit(0);
