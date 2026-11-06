/**
 * "Can edit" and "Can view", per person and for the share link. The matrix:
 * the owner, an editor, a viewer, a link visitor while the link can edit,
 * one while it can only view, and a stranger. A viewer reads, typesets,
 * comments and replies, and changes nothing else: not over REST, not over
 * the collab socket (read-only, like a showcase), not through the Agent API.
 * A role is set when inviting, changed later per person, and kept by Invite
 * again; changing it drops the project's sockets so it applies at once.
 *
 * Real route table (Fastify inject) on a throwaway JSON datastore.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-view-only-')));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.RL_INVITE_BURST = '100';
for (const k of ['DATABASE_URL', 'REDIS_URL', 'SES_FROM', 'SMTP_HOST', 'ALDINE_PUBLIC_URL', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_BASE_PATH', 'ALDINE_TEST_HOOKS']) delete process.env[k];

const { initDb, db } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const store = await import('../src/store.ts');
const collab = await import('../src/collab.ts');
const { canAccess, canEdit } = await import('../src/authz.ts');
const { assertWritableProject } = await import('../src/mcp/guards.ts');
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
  return { id: user.id, name, email, user: await auth.getUser(user.id), cookie: `${auth.COOKIE}=${await auth.createSession(user.id)}` };
}
const owner = await person('owner@example.com', 'Olive Owner');
const editor = await person('ed@example.org', 'Ed Editor');
const viewer = await person('vi@example.org', 'Vi Viewer');
const stranger = await person('st@example.org', 'Stan Stranger');
const dave = await person('dave@example.org', 'Dave');

const P = (await json('POST', '/api/projects', owner, { name: 'Draft' })).id;
const meta = () => store.readMeta(P);
const accept = async (who) => {
  const inv = (await json('GET', '/api/invitations', who)).find((i) => i.project.id === P);
  await json('POST', `/api/invitations/${inv.id}/accept`, who);
};
const pub = (who) => json('GET', `/api/projects/${P}`, who);
const write = (who, code) => call('PUT', `/api/projects/${P}/file`, who, { path: `by-${who.name.split(' ')[0].toLowerCase()}.tex`, content: 'x' }).then((r) => {
  eq(r.statusCode, code, `${who.name} writes a file: ${r.statusCode} ${r.body.slice(0, 120)}`);
  return r;
});
const socket = async (who) => {
  const connection = { readOnly: false };
  await collab.hocuspocus.configuration.onAuthenticate({ documentName: collab.docName(P, 'main', 'main.tex'), requestHeaders: { cookie: who.cookie }, connection });
  return connection.readOnly ? 'read-only' : 'read-write';
};

// ---- roles are set when inviting, and hold once accepted ----
await json('POST', `/api/projects/${P}/share`, owner, { mode: 'private', collaborators: [editor.email], previous: [] });
await json('POST', `/api/projects/${P}/invitations`, owner, { to: viewer.email, role: 'view' });
await accept(editor);
await accept(viewer);
let m = await meta();
eq([...m.share.collaborators].sort(), [editor.email, viewer.email], 'both accepted');
eq(m.share.viewers, [viewer.email], 'the viewer is on the view-only list, the editor is not');
eq(m.share.linkRole, undefined, 'a share without a view-only link stores no link role');

// ---- the matrix, as authz decides it ----
const row = async (who) => [canAccess(await meta(), who.user), canEdit(await meta(), who.user)];
eq(await row(owner), [true, true], 'owner: opens and edits');
eq(await row(editor), [true, true], 'editor: opens and edits');
eq(await row(viewer), [true, false], 'viewer: opens, does not edit');
eq(await row(stranger), [false, false], 'stranger: nothing while the project is invite-only');

// ---- the project says what the caller may do ----
eq((await pub(owner)).canEdit, true, 'the owner is told they can edit');
eq((await pub(editor)).canEdit, true, 'the editor is told they can edit');
const seen = await pub(viewer);
eq([seen.canEdit, seen.readOnly], [false, false], 'the viewer is told they can view, and the project is no showcase');
eq(seen.share, { mode: 'private', collaborators: [] }, 'the viewer sees no roster and no roles');
eq((await json('GET', '/api/projects', viewer)).find((p) => p.id === P)?.canEdit, false, 'the project list says so too');

// ---- REST writes ----
await write(owner, 200);
await write(editor, 200);
let r = await write(viewer, 403);
check(/view this project, not change it/.test(r.json().error), `the refusal says why (got ${r.body})`);
eq((await call('PATCH', `/api/projects/${P}`, viewer, { name: 'Mine now' })).statusCode, 403, 'a viewer cannot rename');
eq((await call('POST', `/api/projects/${P}/branches`, viewer, { name: 'fork', from: 'main' })).statusCode, 403, 'a viewer cannot start a branch');
eq((await call('POST', `/api/projects/${P}/commit`, viewer, { branch: 'main', message: 'x' })).statusCode, 403, 'a viewer cannot commit');
eq((await call('POST', `/api/projects/${P}/revert`, viewer, { branch: 'main', commits: [] })).statusCode, 403, 'a viewer cannot revert');
eq((await call('POST', `/api/projects/${P}/replace`, viewer, { branch: 'main', query: 'x', replacement: 'y' })).statusCode, 403, 'a viewer cannot replace across files');
eq((await call('GET', `/api/projects/${P}/zotero/search?q=x`, viewer)).statusCode, 403, "a viewer cannot search the owner's Zotero library");
eq((await call('GET', `/api/projects/${P}/files`, viewer)).statusCode, 200, 'a viewer reads the file list');
eq((await call('GET', `/api/projects/${P}/file?path=main.tex`, viewer)).statusCode, 200, 'a viewer reads a file');
eq((await call('POST', `/api/projects/${P}/opened`, viewer, { branch: 'main' })).statusCode, 200, 'a viewer keeps their own project list');

// ---- comments stay open to viewers ----
const anchor = { from: 0, to: 4, quote: '\\doc' };
const ownersNote = await json('POST', `/api/projects/${P}/comments`, owner, { file: 'main.tex', anchor, body: 'owner note' });
const viewersNote = await json('POST', `/api/projects/${P}/comments`, viewer, { file: 'main.tex', anchor, body: 'viewer note', suggestion: 'better' });
await json('POST', `/api/projects/${P}/comments/${ownersNote.id}/reply`, viewer, { body: 'a reply' });
await json('POST', `/api/projects/${P}/comments/${viewersNote.id}/resolve`, viewer, { resolved: true });
eq((await call('POST', `/api/projects/${P}/comments/${viewersNote.id}/accept`, viewer, { branch: 'main' })).statusCode, 403, 'a viewer cannot apply a suggestion');
eq((await call('DELETE', `/api/projects/${P}/comments/${ownersNote.id}`, viewer)).statusCode, 403, "a viewer cannot delete someone else's thread");
eq((await call('DELETE', `/api/projects/${P}/comments/${viewersNote.id}`, viewer)).statusCode, 200, 'a viewer deletes their own');

// ---- the collab socket ----
eq(await socket(owner), 'read-write', 'the owner edits live');
eq(await socket(editor), 'read-write', 'the editor edits live');
eq(await socket(viewer), 'read-only', 'the viewer connects read-only');

// ---- the Agent API ----
const mcpWrite = async (who) => { try { assertWritableProject(await meta(), { user: who.user, tokenScope: null }); return 'writes'; } catch (err) { return err.message; } };
eq(await mcpWrite(editor), 'writes', "an editor's agent writes");
check(/can view this project, not change it/.test(await mcpWrite(viewer)), "a viewer's agent is told it can only read");

// ---- changing a role ----
eq((await call('PUT', `/api/projects/${P}/collaborators/${encodeURIComponent(viewer.email)}`, editor, { role: 'edit' })).statusCode, 403, 'only the owner changes roles');
eq((await call('PUT', `/api/projects/${P}/collaborators/${encodeURIComponent(viewer.email)}`, owner, { role: 'admin' })).statusCode, 400, 'a role is edit or view');
eq((await call('PUT', `/api/projects/${P}/collaborators/nobody%40example.org`, owner, { role: 'view' })).statusCode, 404, 'a role needs someone to have it');
r = await json('PUT', `/api/projects/${P}/collaborators/${encodeURIComponent('VI@example.org')}`, owner, { role: 'edit' });
eq(r.share.viewers, undefined, 'promoted: nobody is view-only now');
await write(viewer, 200);
eq(await socket(viewer), 'read-write', 'and the socket edits again');
await json('PUT', `/api/projects/${P}/collaborators/${encodeURIComponent(editor.email)}`, owner, { role: 'view' });
await write(editor, 403);
await json('PUT', `/api/projects/${P}/collaborators/${encodeURIComponent(editor.email)}`, owner, { role: 'edit' });
await json('PUT', `/api/projects/${P}/collaborators/${encodeURIComponent(viewer.email)}`, owner, { role: 'view' });

// ---- the share link ----
r = await json('POST', `/api/projects/${P}/share`, owner, { mode: 'link', linkRole: 'view' });
eq([r.share.mode, r.share.linkRole], ['link', 'view'], 'the link can be view-only');
eq(await row(stranger), [true, false], 'link-view: a link visitor opens and does not edit');
eq((await pub(stranger)).share, { mode: 'link', collaborators: [], linkRole: 'view' }, 'a visitor is told what the link allows');
await write(stranger, 403);
eq(await socket(stranger), 'read-only', 'a link visitor connects read-only');
await json('POST', `/api/projects/${P}/comments`, stranger, { file: 'main.tex', anchor, body: 'visitor note' });
eq((await json('POST', `/api/projects/${P}/share`, owner, { mode: 'link' })).share.linkRole, 'view', 'a save that names no link role keeps it');
r = await json('POST', `/api/projects/${P}/share`, owner, { mode: 'link', linkRole: 'edit' });
eq(r.share.linkRole, undefined, 'link-edit is the default and stores nothing');
eq(await row(stranger), [true, true], 'link-edit: a link visitor opens and edits');
await write(stranger, 200);
eq(await row(viewer), [true, true], 'a viewer with an editing link gets the wider of the two');
await json('POST', `/api/projects/${P}/share`, owner, { mode: 'private' });
eq(await row(stranger), [false, false], 'invite-only again: the visitor is out');
eq(await row(viewer), [true, false], 'and the viewer is back to viewing');

// ---- a role travels with its invitation ----
await json('POST', `/api/projects/${P}/invitations`, owner, { to: dave.email, role: 'view' });
const inv = (await json('GET', '/api/invitations', dave)).find((i) => i.project.id === P);
await json('POST', `/api/invitations/${inv.id}/decline`, dave);
await json('POST', `/api/projects/${P}/share`, owner, { mode: 'private', collaborators: [...(await meta()).share.collaborators, 'erin@example.org'], previous: (await meta()).share.collaborators, role: 'view' });
check((await meta()).share.viewers.includes('dave@example.org'), "a save keeps a declined invitation's role, for Invite again");
check((await meta()).share.viewers.includes('erin@example.org'), 'a save gives its new entries the role it names');
await json('POST', `/api/projects/${P}/invitations`, owner, { to: dave.email });
await accept(dave);
eq(await row(dave), [true, false], 'invited again without a role: the one he had');
r = await json('DELETE', `/api/projects/${P}/collaborators/${encodeURIComponent(dave.email)}`, owner);
check(!r.share.viewers.includes('dave@example.org'), 'removing a person removes their role');

await app.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('view-only access: ok');
process.exit(0);
