/**
 * Per-owner storage limit (ALDINE_STORAGE_QUOTA_MB, storage.ts):
 *  - off by default: nothing is refused and /api/usage reports no limit
 *  - what counts: working files and .git of every branch, trash until
 *    purged; typeset output does not
 *  - counts are cached and redone after a write, never on every read
 *  - over the limit: uploads, large writes, new projects, imports,
 *    duplicates and branches answer 402 with a sentence for the owner or
 *    naming the owner for a collaborator; small text edits keep working
 *  - /api/usage and /api/admin/users show usage
 *
 * The limit is read per call, so the test changes it between steps. Env
 * that is read at module load is set before any src import.
 */
import fs from 'node:fs';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { check, eq } from './assert.mjs';
import { buildZip } from './zip.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-storage-'));
process.env.AUTH_ENABLED = '1';
process.env.ALDINE_ADMIN_EMAILS = 'ann@example.org';
process.env.RL_REGISTER_BURST = '200';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.ALDINE_STORAGE_QUOTA_MB;

const { default: Fastify } = await import('fastify');
const { initDb, db } = await import('../src/db/index.ts');
const { registerRoutes } = await import('../src/routes.ts');
const storage = await import('../src/storage.ts');
const store = await import('../src/store.ts');

await initDb();
const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 });
await registerRoutes(app);
await app.ready();

const MB = 1024 * 1024;
const cookieOf = (res) => [].concat(res.headers['set-cookie']).map((c) => c.split(';')[0]).find((c) => c.startsWith('aldine_session='));
async function signUp(email, name) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'password123', name } });
  eq(res.statusCode, 200, `register ${email}`);
  await db().setEmailPending(res.json().user.id, null);
  return { cookie: cookieOf(res), id: res.json().user.id };
}
const call = (method, url, cookie, payload) => app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload } : {}) });
/** Bytes that neither git nor a filesystem can compress. */
const noise = (bytes) => randomBytes(bytes);
const upload = (cookie, id, file, bytes) => call('PUT', `/api/projects/${id}/file`, cookie, { branch: 'main', path: file, content: noise(bytes).toString('base64'), encoding: 'base64' });
const limit = (mb) => { if (mb === null) delete process.env.ALDINE_STORAGE_QUOTA_MB; else process.env.ALDINE_STORAGE_QUOTA_MB = String(mb); };

// ---- the sentences ----
eq(storage.formatMb(0), '0 MB', 'format: zero');
eq(storage.formatMb(7.54 * MB), '7.5 MB', 'format: one decimal under 10 MB');
eq(storage.formatMb(512.4 * MB), '512 MB', 'format: whole MB above');
eq(storage.storageMessage({ usedBytes: 512 * MB, limitBytes: 500 * MB, incomingBytes: 1, action: 'upload', self: false }),
  "This project's owner has used 512 MB of 500 MB. Delete files from this project, or ask the owner to delete projects or empty their trash, to upload again.",
  'message: collaborator, owner without a name');
eq(storage.storageMessage({ usedBytes: 512 * MB, limitBytes: 500 * MB, incomingBytes: 1, action: 'upload', self: true }),
  'You have used 512 MB of your 500 MB. Delete files or projects, or empty the trash, to upload again.',
  'message: the owner');
eq(storage.storageMessage({ usedBytes: 480 * MB, limitBytes: 500 * MB, incomingBytes: 40 * MB, action: 'import', self: false, ownerName: 'Ann Lee' }),
  "This import needs 40 MB, and this project's owner, Ann Lee, has 20 MB of 500 MB left. Delete files from this project, or ask the owner to delete projects or empty their trash, to make room.",
  'message: would not fit, owner named');

// ---- off by default ----
const ann = await signUp('ann@example.org', 'Ann Lee');
const bob = await signUp('bob@example.org', 'Bob');
const p1 = (await call('POST', '/api/projects', ann.cookie, { name: 'Thesis' })).json();
eq((await upload(ann.cookie, p1.id, 'big.bin', 700 * 1024)).statusCode, 200, 'no limit: a large upload goes through');
const usage0 = (await call('GET', '/api/usage', ann.cookie)).json();
eq(usage0.storage.limitBytes, 0, 'usage: no limit by default');
check(usage0.storage.usedBytes > 700 * 1024, `usage: counts the upload (${usage0.storage.usedBytes})`);
eq(await storage.storageRefusal(ann.id, ann.id, 10 * 1024 * MB, 'upload'), null, 'no limit: nothing is ever refused');

// ---- what counts, and the cache ----
const before = await storage.projectStorageBytes(p1.id);
fs.mkdirSync(path.join(store.repoDir(p1.id), '.aldine-out'), { recursive: true });
fs.writeFileSync(path.join(store.repoDir(p1.id), '.aldine-out', 'main.pdf'), noise(200 * 1024));
fs.writeFileSync(path.join(store.repoDir(p1.id), 'outside-the-store.bin'), noise(100 * 1024));
eq(await storage.projectStorageBytes(p1.id), before, 'cache: a read after a write the store did not see is the cached count');
storage.noteStorageChanged(p1.id);
eq(await storage.projectStorageBytes(p1.id), before + 100 * 1024, 'recount: typeset output is left out, the new file counts');
fs.rmSync(path.join(store.repoDir(p1.id), 'outside-the-store.bin'));
storage.noteStorageChanged(p1.id);
// a branch's worktree counts: its working files are a second copy
eq((await call('POST', `/api/projects/${p1.id}/branches`, ann.cookie, { name: 'draft' })).statusCode, 200, 'create a branch');
check(await storage.projectStorageBytes(p1.id) > before + 600 * 1024, 'the branch worktree counts');

// ---- over the limit ----
limit(0.5);
const used = (await call('GET', '/api/usage', ann.cookie)).json().storage;
eq(used.limitBytes, 0.5 * MB, 'usage: the limit in bytes');
check(used.usedBytes > used.limitBytes, 'Ann is over the limit');

const up = await upload(ann.cookie, p1.id, 'fig.png', 10 * 1024);
eq(up.statusCode, 402, 'over: an upload answers 402, like the typeset budget');
eq(up.json().storageExceeded, true, 'over: flagged for clients');
check(/^You have used [\d.]+ MB of your 0\.5 MB\. Delete files or projects, or empty the trash, to upload again\.$/.test(up.json().error), `over: the owner's sentence (${up.json().error})`);
check(!store.fileExists(p1.id, 'main', 'fig.png'), 'over: the refused upload wrote nothing');

eq((await call('PUT', `/api/projects/${p1.id}/file`, ann.cookie, { branch: 'main', path: 'main.tex', content: '\\documentclass{article}\\begin{document}Still writing.\\end{document}\n' })).statusCode, 200,
  'over: saving text keeps working');
eq((await call('PUT', `/api/projects/${p1.id}/file`, ann.cookie, { branch: 'main', path: 'notes.tex', content: 'A new small file.\n' })).statusCode, 200,
  'over: a small new text file is typing, not storage');
const bulk = await call('PUT', `/api/projects/${p1.id}/file`, ann.cookie, { branch: 'main', path: 'data.tex', content: 'x'.repeat(200 * 1024) });
eq(bulk.statusCode, 402, 'over: a text write that adds more than typing does is refused');
check(bulk.json().error.endsWith('to save large changes again.'), 'over: its sentence names the action');

const created = await call('POST', '/api/projects', ann.cookie, { name: 'Another' });
eq(created.statusCode, 402, 'over: a new project is refused');
check(created.json().error.endsWith('to create projects again.'), 'over: the new-project sentence');
eq((await call('POST', `/api/projects/${p1.id}/copy`, ann.cookie, {})).statusCode, 402, 'over: Duplicate is refused');
eq((await call('POST', `/api/projects/${p1.id}/branches`, ann.cookie, { name: 'second' })).statusCode, 402, 'over: a new branch is refused');
const zip = buildZip({ 'main.tex': '\\documentclass{article}\\begin{document}x\\end{document}\n' });
const imported = await call('POST', '/api/projects/import', ann.cookie, { name: 'Zip', zipBase64: zip.toString('base64') });
eq(imported.statusCode, 402, 'over: an import is refused');
eq((await db().listMeta()).filter((m) => m.ownerId === ann.id).length, 1, 'over: no refused operation left a project behind');

// a collaborator is told whose storage it is
await store.updateMeta(p1.id, (m) => ({ ...m, share: { ...(m.share ?? {}), collaborators: ['bob@example.org'] } }));
const bobUp = await upload(bob.cookie, p1.id, 'bob.png', 10 * 1024);
eq(bobUp.statusCode, 402, 'collaborator: the owner\'s limit applies');
check(/^This project's owner, Ann Lee, has used [\d.]+ MB of 0\.5 MB\. Delete files from this project, or ask the owner to delete projects or empty their trash, to upload again\.$/.test(bobUp.json().error),
  `collaborator: names the owner (${bobUp.json().error})`);
const bobOwn = await call('POST', '/api/projects', bob.cookie, { name: 'Bob\'s own' });
eq(bobOwn.statusCode, 200, 'collaborator: their own storage is their own');
eq((await upload(bob.cookie, bobOwn.json().id, 'small.png', 10 * 1024)).statusCode, 200, 'collaborator: uploads into their own project');
const fits = await upload(bob.cookie, bobOwn.json().id, 'large.png', 600 * 1024);
eq(fits.statusCode, 402, 'an upload that would not fit is refused before the limit is reached');
check(/^This upload needs 0\.6 MB, and you have [\d.]+ MB of your 0\.5 MB left\./.test(fits.json().error), `would not fit: says what is left (${fits.json().error})`);

// ---- admin ----
const rows = (await call('GET', '/api/admin/users', ann.cookie)).json();
const annRow = rows.find((r) => r.id === ann.id);
check(annRow.storageBytes > 0.5 * MB, 'admin: the account\'s storage');
eq(annRow.storageLimitBytes, 0.5 * MB, 'admin: the account\'s limit');
const stats = (await call('GET', '/api/admin/stats', ann.cookie)).json();
eq(stats.storage.quotaBytes, 0.5 * MB, 'admin stats: the per-owner limit');
check(stats.storage.bytes >= annRow.storageBytes, 'admin stats: storage of every owner');

// ---- trash counts until it is emptied ----
const trashedUsage = (await call('GET', '/api/usage', ann.cookie)).json().storage.usedBytes;
eq((await call('DELETE', `/api/projects/${p1.id}`, ann.cookie)).statusCode, 200, 'trash the project');
eq((await call('GET', '/api/usage', ann.cookie)).json().storage.usedBytes, trashedUsage, 'trash: still counted');
eq((await call('POST', '/api/projects', ann.cookie, { name: 'Still full' })).statusCode, 402, 'trash: still refused');
eq((await call('DELETE', `/api/projects/${p1.id}?permanent=1`, ann.cookie)).statusCode, 200, 'empty it from the trash');
eq((await call('GET', '/api/usage', ann.cookie)).json().storage.usedBytes, 0, 'emptied: nothing left');
eq((await call('POST', '/api/projects', ann.cookie, { name: 'Fresh start' })).statusCode, 200, 'emptied: a new project fits again');

limit(null);
await app.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('storage-quota: ok');
