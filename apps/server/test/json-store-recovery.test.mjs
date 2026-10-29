/**
 * The JSON datastore after a crash or a forced read-only remount (#199): a
 * file left empty, cut short or zero-filled is restored from the `.bak`
 * beside it, which every write refreshes with the version it replaces. With
 * no usable `.bak` the store refuses to start, naming the file and the way
 * back (a backup), and /api/health stops reporting ok; it never answers with
 * an empty default that a later write would save over the real data. A
 * missing file is still a fresh, empty store.
 *
 * Env is set before any src import: config reads the roots at module load.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq, throws } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-json-recovery-')));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
for (const k of ['AUTH_ENABLED', 'DATABASE_URL', 'REDIS_URL', 'ALDINE_PROTECTED_PROJECTS']) delete process.env[k];

const { JsonStore } = await import('../src/db/json.ts');

const at = (dir, ...p) => path.join(dir, ...p);
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const mode = (file) => fs.statSync(file).mode & 0o777;
const tmps = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
const user = (id, email) => ({ id, email, name: id, salt: 's', hash: 'h', createdAt: `2026-10-0${id.length}T00:00:00.000Z` });
const ada = user('ada', 'ada@example.com');
const bob = user('bobby', 'bob@example.com');
const meta = (id, name) => ({ id, name, rootFile: 'main.tex', createdAt: '2026-10-01T00:00:00.000Z' });

/** console.error lines while `fn` runs. */
async function errorsOf(fn) {
  const lines = [];
  const orig = console.error;
  console.error = (...a) => { lines.push(a.map(String).join(' ')); };
  try { await fn(); } finally { console.error = orig; }
  return lines;
}

async function freshDir(name) {
  const dir = at(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---- a missing file is a fresh, empty store ----
{
  const dir = await freshDir('fresh');
  const s = new JsonStore(dir);
  await s.init();
  check((await s.getUser('ada')) === null, 'a store without users.json has no users');
  eq(await s.listUsers(), [], 'and lists none');
  check(!fs.existsSync(at(dir, 'users.json')), 'starting writes no file');
}

// ---- every write keeps the version it replaces as .bak ----
const dir = await freshDir('store');
{
  const s = new JsonStore(dir);
  await s.init();
  await s.createUser(ada);
  check(fs.existsSync(at(dir, 'users.json')), 'the first write creates users.json');
  check(!fs.existsSync(at(dir, 'users.json.bak')), 'with nothing before it, there is no .bak yet');
  await s.createUser(bob);
  eq(Object.keys(json(at(dir, 'users.json'))).sort(), ['ada', 'bobby'], 'users.json holds both accounts');
  eq(Object.keys(json(at(dir, 'users.json.bak'))), ['ada'], 'users.json.bak holds the version before the last write');
  await s.updateUser({ ...ada, name: 'Ada L.' });
  eq(json(at(dir, 'users.json.bak')).ada.name, 'ada', '.bak moves on with each write');
  eq(json(at(dir, 'users.json')).ada.name, 'Ada L.', 'and the file has the new version');
  eq(mode(at(dir, 'users.json')), 0o600, 'users.json is private to the server');
  eq(mode(at(dir, 'users.json.bak')), 0o600, 'so is its .bak');
  eq(tmps(dir), [], 'no temp file is left behind');

  await s.writeMeta(meta('proj1', 'First'));
  await s.writeMeta(meta('proj1', 'Renamed'));
  eq(json(at(dir, 'meta', 'proj1.json.bak')).name, 'First', 'per-project metadata keeps a .bak too');
  await s.saveComments('proj1', [{ id: 'c1', body: 'one' }]);
  await s.saveComments('proj1', [{ id: 'c1', body: 'one' }, { id: 'c2', body: 'two' }]);
  eq(json(at(dir, 'comments', 'proj1.json.bak')).length, 1, 'and so do comments');
  eq((await s.listMeta()).map((m) => m.id), ['proj1'], 'a .bak beside the metadata is not listed as a project');
}

// ---- an empty users.json with a good .bak: restored, loudly ----
{
  fs.writeFileSync(at(dir, 'users.json'), ''); // what the reporter found after the remount
  const s = new JsonStore(dir);
  const logged = await errorsOf(() => s.init());
  check(logged.some((l) => l.includes(at(dir, 'users.json')) && l.includes(at(dir, 'users.json.bak'))), `the restore is logged naming both files (got ${JSON.stringify(logged)})`);
  eq((await s.getUser('ada')).name, 'ada', 'the accounts come back from the .bak');
  check((await s.getUser('bobby')) !== null, 'all of them');
  eq(Object.keys(json(at(dir, 'users.json'))).sort(), ['ada', 'bobby'], 'users.json is rewritten from the .bak');
  eq(Object.keys(json(at(dir, 'users.json.bak'))).sort(), ['ada', 'bobby'], 'and the .bak is kept');
  eq(mode(at(dir, 'users.json')), 0o600, 'the restored file is private too');
  await s.touchUser('ada', '2026-10-29T10:00:00.000Z');
  eq(json(at(dir, 'users.json')).ada.lastSeenAt, '2026-10-29T10:00:00.000Z', 'writes carry on after the restore');
}

// ---- cut short or zero-filled: the same ----
for (const [label, damage] of [['cut short', (b) => b.subarray(0, Math.floor(b.length / 2))], ['zero-filled', (b) => Buffer.alloc(b.length)]]) {
  const good = fs.readFileSync(at(dir, 'users.json'));
  fs.writeFileSync(at(dir, 'users.json.bak'), good);
  fs.writeFileSync(at(dir, 'users.json'), damage(good));
  const s = new JsonStore(dir);
  await errorsOf(() => s.init());
  eq((await s.getUser('ada')).lastSeenAt, '2026-10-29T10:00:00.000Z', `a ${label} users.json is restored from its .bak`);
}

// ---- no usable .bak: the store refuses to start and says what to do ----
{
  const bad = await freshDir('bad');
  fs.writeFileSync(at(bad, 'users.json'), '');
  fs.writeFileSync(at(bad, 'users.json.3fa1c2d4.tmp'), JSON.stringify({ ada }));
  await throws(() => new JsonStore(bad).init(), `${at(bad, 'users.json')} cannot be read (the file is empty), and its last-good copy ${at(bad, 'users.json.bak')} does not exist`, 'an empty file without a .bak fails startup, naming both files');
  await throws(() => new JsonStore(bad).init(), 'Restore it from a backup', 'the error points at the backup');
  await throws(() => new JsonStore(bad).init(), at(bad, 'users.json.3fa1c2d4.tmp'), 'and at a temp file an interrupted write left, which may hold a newer copy');
  fs.writeFileSync(at(bad, 'users.json.bak'), '{"ada": {"id": "ad');
  await throws(() => new JsonStore(bad).init(), 'cannot be read either', 'a damaged .bak is no way back either');
  eq(fs.readFileSync(at(bad, 'users.json'), 'utf8'), '', 'the damaged file is left as it is');
  fs.writeFileSync(at(bad, 'sessions.json'), '{');
  fs.rmSync(at(bad, 'users.json'));
  await throws(() => new JsonStore(bad).init(), 'sessions.json cannot be read', 'every flat file is checked at startup');
}

// ---- per-project files ----
{
  fs.writeFileSync(at(dir, 'meta', 'proj1.json'), '');
  const s = new JsonStore(dir);
  await s.init();
  const logged = await errorsOf(async () => {
    eq((await s.readMeta('proj1')).name, 'First', 'damaged metadata reads from its .bak');
  });
  check(logged.some((l) => l.includes('proj1.json.bak')), 'and says so');
  eq(json(at(dir, 'meta', 'proj1.json')).name, 'First', 'the metadata file is rewritten from it');

  fs.writeFileSync(at(dir, 'meta', 'proj1.json'), '{"id":"pro');
  await errorsOf(async () => eq((await s.listMeta()).map((m) => m.name), ['First'], 'the project list restores it too'));

  // written without a read first: the damaged file must not become the .bak
  fs.writeFileSync(at(dir, 'meta', 'proj1.json'), '');
  await s.writeMeta(meta('proj1', 'Third'));
  eq(json(at(dir, 'meta', 'proj1.json.bak')).name, 'First', 'a damaged file never replaces a good .bak');

  fs.writeFileSync(at(dir, 'meta', 'proj1.json'), '');
  fs.rmSync(at(dir, 'meta', 'proj1.json.bak'));
  await throws(() => s.readMeta('proj1'), 'proj1.json cannot be read', 'damaged metadata without a .bak is an error naming the file');
  const skipped = await errorsOf(async () => eq(await s.listMeta(), [], 'the project list skips it'));
  check(skipped.some((l) => l.includes('proj1.json')), 'and logs which file it skipped');
  check((await s.readMeta('../evil')) === null, 'a malformed id still reads as absent');
  await s.deleteMeta('proj1');
  check(!fs.existsSync(at(dir, 'meta', 'proj1.json.bak')), 'deleting a project removes its .bak');

  fs.writeFileSync(at(dir, 'comments', 'proj1.json'), '[{"id":"c1"');
  await errorsOf(async () => eq((await s.loadComments('proj1')).length, 1, 'damaged comments read from their .bak'));
  fs.writeFileSync(at(dir, 'comments', 'proj1.json'), '');
  fs.rmSync(at(dir, 'comments', 'proj1.json.bak'));
  await throws(() => s.loadComments('proj1'), 'proj1.json cannot be read', 'damaged comments without a .bak are an error, not an empty list the next comment saves over them');
  eq(await s.loadComments('proj2'), [], 'a project without comments still has an empty list');
}

// ---- a failed write, then /api/health ----
const { initDb, db } = await import('../src/db/index.ts');
await initDb();
const Fastify = (await import('fastify')).default;
const { registerRoutes } = await import('../src/routes.ts');
const app = Fastify();
await registerRoutes(app);
const health = () => app.inject({ method: 'GET', url: '/api/health' });

let res = await health();
eq(res.statusCode, 200, 'a readable store is healthy');
eq(res.json(), { ok: true, name: 'aldine' }, 'with the documented body');

const metaDir = process.env.META_DIR;
const usersFile = at(metaDir, 'users.json');
await db().createUser(ada);
await db().createUser(bob);
/** A write while the volume is read-only: it fails, and the store drops its
 *  cached copy, so the next read goes to the disk. */
async function failedWrite(label) {
  fs.chmodSync(metaDir, 0o500);
  try {
    await throws(() => db().updateUser({ ...ada, name: 'Lost' }), 'EACCES', label);
  } finally {
    fs.chmodSync(metaDir, 0o700);
  }
}
if (process.getuid?.() !== 0) {
  await failedWrite('a write to a read-only META_DIR fails');
  eq(Object.keys(json(usersFile)).sort(), ['ada', 'bobby'], 'users.json keeps its last good version');
  eq(Object.keys(json(`${usersFile}.bak`)), ['ada'], 'and so does its .bak');
  eq(tmps(metaDir), [], 'no temp file is left behind');

  fs.writeFileSync(usersFile, '');
  await errorsOf(async () => eq((await db().getUser('ada')).name, 'ada', 'a running server restores a damaged file from its .bak on the next read'));

  await failedWrite('setup: another failed write');
  fs.writeFileSync(usersFile, '');
  fs.rmSync(`${usersFile}.bak`);
  res = await health();
  eq(res.statusCode, 503, 'a store that cannot be read is not healthy');
  eq(res.json().ok, false, 'and says so');
  check(!res.body.includes(metaDir), 'without telling the probe where META_DIR is');
  await throws(() => db().getUser('ada'), `${usersFile} cannot be read`, 'a request reading it gets the error naming the file');
} else {
  console.log('- read-only META_DIR: skipped (running as root)');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('✓ json store recovery: all passed');
process.exit(0);
