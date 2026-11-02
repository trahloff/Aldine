/**
 * The SQLite datastore, the default from 1.7 (#199): on its first start it
 * copies a JSON datastore beside it, every record of every file, and leaves
 * the JSON files exactly as they were. A JSON file that cannot be read stops
 * the copy before aldine.db exists. The file is private, a damaged or newer
 * one is refused naming it, ALDINE_DATASTORE picks the backend, Node's
 * ExperimentalWarning for node:sqlite is not printed, and dist/db/snapshot.js
 * copies a live database with the writes still in its WAL.
 *
 * Env is set before any src import: config reads the roots at module load.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { check, eq, throws } from './assert.mjs';

// Registered before anything loads node:sqlite: Node warns once per process.
const warnings = [];
process.on('warning', (w) => warnings.push(w));

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-sqlite-')));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
for (const k of ['AUTH_ENABLED', 'DATABASE_URL', 'REDIS_URL', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_DATASTORE']) delete process.env[k];

const { JsonStore } = await import('../src/db/json.ts');
const { SqliteStore, loadSqlite } = await import('../src/db/sqlite.ts');
const { datastoreKind, initDb, closeDb, SQLITE_FILE } = await import('../src/db/index.ts');

const at = (dir, ...p) => path.join(dir, ...p);
const mode = (file) => fs.statSync(file).mode & 0o777;
let n = 0;
const freshDir = () => { const d = at(tmp, `case-${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };

/** console output of one kind while `fn` runs. */
async function linesOf(kind, fn) {
  const lines = [];
  const orig = console[kind];
  console[kind] = (...a) => { lines.push(a.map(String).join(' ')); };
  try { await fn(); } finally { console[kind] = orig; }
  return lines;
}

/** Every file under `dir` but the SQLite ones, with its bytes and mtime. */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = at(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (!e.name.startsWith(SQLITE_FILE)) out[path.relative(dir, p)] = [fs.readFileSync(p).toString('base64'), fs.statSync(p).mtimeMs];
    }
  };
  walk(dir);
  return out;
}

// ---- a JSON datastore with something in every file ----
const ada = { id: 'ada', email: 'ada@example.com', name: 'Ada', salt: 's', hash: 'h', createdAt: '2026-10-01T00:00:00.000Z', lastSeenAt: '2026-10-30T10:00:00.000Z' };
const orc = { id: 'orc', email: null, name: 'Josiah', salt: 's', hash: '', createdAt: '2026-10-02T00:00:00.000Z', provider: 'orcid', subject: 'orcid:0000-0002-1825-0097' };
const wen = { id: 'wen', email: 'wen@example.com', name: 'Wen', salt: 's', hash: 'h', createdAt: '2026-10-03T00:00:00.000Z', disabledAt: '2026-10-03T00:00:00.000Z', emailPending: { hash: 'a'.repeat(64), expiresAt: '2027-01-01T00:00:00.000Z' } };
const later = Date.now() + 86_400_000;
const pat = { id: 'pat1', userId: 'ada', name: 'Agent', hash: 'digest1', projectIds: ['proj1'], createdAt: '2026-10-04T00:00:00.000Z', lastUsedAt: null, expiresAt: null, revokedAt: null, clientName: null, family: null };
const oat = { id: 'oat1', userId: 'ada', name: 'Claude', hash: 'digest2', projectIds: null, createdAt: '2026-10-05T00:00:00.000Z', lastUsedAt: '2026-10-06T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z', revokedAt: null, clientName: 'Claude', family: 'fam1' };
const client = { id: 'aldc_1', name: 'Claude', redirectUris: ['https://claude.ai/cb'], createdAt: '2026-10-05T00:00:00.000Z', lastUsedAt: '2026-10-06T00:00:00.000Z' };
const refresh = { id: 'rf1', hash: 'rhash1', tokenId: 'oat1', userId: 'ada', clientId: 'aldc_1', family: 'fam1', projectIds: null, clientName: 'Claude', expiresAt: '2027-01-01T00:00:00.000Z', usedAt: null, revokedAt: null };
const proj1 = { id: 'proj1', name: 'Thesis', rootFile: 'main.tex', engine: 'pdf', createdAt: '2026-10-01T00:00:00.000Z', ownerId: 'ada', share: { mode: 'private', collaborators: ['wen@example.com'] }, github: { fullName: 'ada/thesis', owner: 'ada', repo: 'thesis', remoteBranch: 'main', cloneUrl: 'https://github.com/ada/thesis.git' } };
const proj2 = { id: 'proj2', name: 'Talk', rootFile: 'talk.tex', engine: 'xelatex', createdAt: '2026-10-02T00:00:00.000Z', ownerId: 'orc' };
const comment = { id: 'c1', branch: 'main', file: 'main.tex', anchor: { from: 0, to: 3, quote: 'abc' }, author: 'Ada', authorId: 'ada', body: 'hi', resolved: false, createdAt: '2026-10-07T00:00:00.000Z', replies: [{ author: 'Wen', body: 'ok', createdAt: '2026-10-07T01:00:00.000Z' }] };
const visit = { userId: 'ada', projectId: 'proj1', branch: 'draft', head: 'b'.repeat(40), at: '2026-10-08T00:00:00.000Z', promptedHead: 'c'.repeat(40) };
const opened = { userId: 'ada', projectId: 'proj1', at: '2026-10-09T00:00:00.000Z', branch: 'draft', hidden: false };
const hidden = { userId: 'wen', projectId: 'proj1', at: null, branch: null, hidden: true };
const edit = { at: '2026-10-10T00:00:00.000Z', byId: 'ada', byName: 'Ada', branch: 'main' };
const mark = { status: 'error', errors: 2, at: '2026-10-10T01:00:00.000Z' };
const inv = { id: 'f'.repeat(32), projectId: 'proj2', to: 'ada@example.com', invitedBy: 'orc', createdAt: '2026-10-11T00:00:00.000Z', expiresAt: '2026-10-25T00:00:00.000Z', status: 'pending', respondedAt: null, emailedAt: '2026-10-11T00:00:01.000Z' };

async function seed(dir) {
  const s = new JsonStore(dir);
  await s.init();
  for (const u of [ada, orc, wen]) await s.createUser(u);
  await s.createSession('sid1', 'ada', later);
  await s.createReset('reset1', 'wen', later);
  await s.createToken(pat);
  await s.createToken(oat);
  await s.createOAuthClient(client);
  await s.createRefresh(refresh);
  await s.writeMeta(proj1);
  await s.writeMeta(proj2);
  await s.saveComments('proj1', [comment]);
  await s.addUsageSeconds('ada', '2026-10', 12.5);
  await s.setConnection('ada', 'github', { token: 'gho_secret', login: 'ada' });
  await s.setProjectVisit(visit);
  await s.setProjectOpen(opened);
  await s.setProjectOpen(hidden);
  await s.setLastEdit('proj1', edit);
  await s.setCompileMark('proj1', 'feature/x', mark);
  await s.setCompileMark('proj2', 'main', mark);
  await s.setInvitation(inv);
  // Shapes from before later fields: usage.json before July 2026, a token before OAuth.
  const usage = JSON.parse(fs.readFileSync(at(dir, 'usage.json'), 'utf8'));
  usage.orc = { month: '2026-06', seconds: 30 };
  fs.writeFileSync(at(dir, 'usage.json'), JSON.stringify(usage));
  const tokens = JSON.parse(fs.readFileSync(at(dir, 'tokens.json'), 'utf8'));
  const { clientName: _c, family: _f, ...old } = { ...pat, id: 'pat0', hash: 'digest0' };
  tokens.pat0 = old;
  fs.writeFileSync(at(dir, 'tokens.json'), JSON.stringify(tokens));
  await s.close();
}

/** Everything both stores answer about the seeded records. A token from
 *  before OAuth has no clientName or family in JSON, which reads as null. */
async function readAll(s) {
  const tok = (t) => t && { ...t, clientName: t.clientName ?? null, family: t.family ?? null };
  const out = {
    users: await s.listUsers(),
    bySubject: await s.findUserBySubject(orc.subject),
    session: await s.getSession('sid1'),
    reset: await s.getReset('reset1'),
    tokens: (await s.listTokensForUser('ada')).map(tok),
    byHash: tok(await s.getTokenByHash('digest0')),
    client: await s.getOAuthClient('aldc_1'),
    clients: await s.countOAuthClients(),
    refresh: await s.getRefreshByHash('rhash1'),
    meta: await s.listMeta(),
    comments: [await s.loadComments('proj1'), await s.loadComments('proj2')],
    usage: [await s.getUsageSeconds('ada', '2026-10'), await s.getUsageSeconds('orc', '2026-06'), await s.totalUsageSeconds('2026-10')],
    connection: await s.getConnection('ada', 'github'),
    visit: await s.getProjectVisit('ada', 'proj1', 'draft'),
    opens: [await s.listProjectOpens('ada'), await s.listProjectOpens('wen')],
    activity: (await s.listProjectActivity()).sort((a, b) => a.projectId.localeCompare(b.projectId)),
    invitations: [await s.listProjectInvitations('proj2'), await s.listInvitationsTo(['ada@example.com'])],
  };
  return out;
}

// ---- the first start copies every record and leaves the JSON files alone ----
{
  const dir = freshDir();
  await seed(dir);
  const expected = await readAll(await (async () => { const s = new JsonStore(dir); await s.init(); return s; })());
  const before = snapshot(dir);
  const file = at(dir, SQLITE_FILE);
  const s = new SqliteStore(file, dir);
  const logged = await linesOf('log', () => s.init());
  check(logged.some((l) => l.includes(`copied 3 account(s) and 2 project(s) from the JSON files in ${dir} into ${file}`)), `the copy is logged with what it moved (got ${JSON.stringify(logged)})`);
  eq(await readAll(s), expected, 'every record reads back the same from SQLite, older shapes included');
  eq((await s.readMeta('proj1')).github, proj1.github, 'project metadata is kept whole, a field the code no longer writes included');
  eq(snapshot(dir), before, 'the JSON files are byte for byte and time for time as they were');
  eq(fs.readdirSync(dir).filter((f) => f.includes('.tmp')), [], 'no temp file is left behind');
  eq(mode(file), 0o600, 'aldine.db is private to the server');
  await s.createUser({ ...ada, id: 'eve', email: 'eve@example.com' });
  eq(mode(`${file}-wal`), 0o600, 'so is its write-ahead log');
  await s.check();
  await s.close();

  // A second start uses the file: the JSON files are not read again.
  const j = new JsonStore(dir);
  await j.init();
  await j.createUser({ ...ada, id: 'late', email: 'late@example.com' });
  await j.close();
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(at(dir, 'users.json'), future, future);
  const again = new SqliteStore(file, dir);
  const warned = await linesOf('warn', () => again.init());
  check((await again.getUser('late')) === null, 'a later start does not copy the JSON files again');
  check((await again.getUser('eve')) !== null, 'and keeps what was written to SQLite');
  check(warned.some((l) => l.includes(`the JSON files in ${dir} changed after they were copied into ${file}`)), `a JSON change after the copy is pointed out (got ${JSON.stringify(warned)})`);
  await again.close();
}

// ---- a fresh install starts an empty database ----
{
  const dir = freshDir();
  const file = at(dir, SQLITE_FILE);
  const s = new SqliteStore(file, dir);
  const logged = await linesOf('log', () => s.init());
  check(!logged.some((l) => l.includes('copied')), 'nothing to copy on a fresh install');
  eq(await s.listUsers(), [], 'and no accounts');
  eq(mode(file), 0o600, 'the new file is private too');
  await s.close();

  // An empty aldine.db beside JSON data is not a database yet: the copy runs.
  const other = freshDir();
  await seed(other);
  fs.writeFileSync(at(other, SQLITE_FILE), '');
  const t = new SqliteStore(at(other, SQLITE_FILE), other);
  await linesOf('log', () => t.init());
  eq((await t.listUsers()).length, 3, 'a zero-length aldine.db does not hide the JSON datastore');
  await t.close();
}

// ---- a JSON file that cannot be read stops the copy ----
{
  const dir = freshDir();
  await seed(dir);
  fs.writeFileSync(at(dir, 'users.json'), '');
  fs.rmSync(at(dir, 'users.json.bak'));
  const file = at(dir, SQLITE_FILE);
  await throws(() => new SqliteStore(file, dir).init(), `Copying the JSON datastore in ${dir} into ${file} failed: Datastore file ${at(dir, 'users.json')} cannot be read`, 'the error names the file');
  await throws(() => new SqliteStore(file, dir).init(), 'set ALDINE_DATASTORE=json', 'and the way to keep running meanwhile');
  check(!fs.existsSync(file), 'aldine.db is not created, so the next start tries again');
  eq(fs.readdirSync(dir).filter((f) => f.includes('.tmp')), [], 'and no temp file is left behind');
  eq(fs.readFileSync(at(dir, 'users.json'), 'utf8'), '', 'the damaged file is left as it is');

  const metaDir = freshDir();
  await seed(metaDir);
  fs.writeFileSync(at(metaDir, 'meta', 'proj2.json'), '{"id":');
  fs.rmSync(at(metaDir, 'meta', 'proj2.json.bak'), { force: true });
  await throws(() => new SqliteStore(at(metaDir, SQLITE_FILE), metaDir).init(), 'proj2.json cannot be read', 'a damaged project file stops it too, rather than leaving that project out');

  // A hand edit the JSON store never checked: two accounts with one address.
  const dup = freshDir();
  await seed(dup);
  const users = JSON.parse(fs.readFileSync(at(dup, 'users.json'), 'utf8'));
  users.twin = { ...users.ada, id: 'twin' };
  fs.writeFileSync(at(dup, 'users.json'), JSON.stringify(users));
  await throws(() => new SqliteStore(at(dup, SQLITE_FILE), dup).init(), 'users.json: An account with that email already exists', 'a record SQLite refuses is reported with its file');
  check(!fs.existsSync(at(dup, SQLITE_FILE)), 'and nothing is put in place');
}

// ---- a damaged or newer aldine.db is refused, naming it ----
{
  const dir = freshDir();
  const file = at(dir, SQLITE_FILE);
  fs.writeFileSync(file, 'not a database, just text that happens to be here '.repeat(100));
  await throws(() => new SqliteStore(file).init(), `Datastore file ${file} cannot be read`, 'a file that is not a database fails startup naming it');
  await throws(() => new SqliteStore(file).init(), 'deploy/restore.sh', 'and the way back');

  const newer = at(freshDir(), SQLITE_FILE);
  const first = new SqliteStore(newer);
  await first.init();
  await first.close();
  const { DatabaseSync } = await loadSqlite();
  const raw = new DatabaseSync(newer);
  raw.exec('PRAGMA user_version=99');
  raw.close();
  await throws(() => new SqliteStore(newer).init(), 'was written by a newer Aldine (schema 99', 'a file from a newer release is not touched');
}

// ---- ALDINE_DATASTORE ----
eq(datastoreKind({}), 'sqlite', 'SQLite by default');
eq(datastoreKind({ ALDINE_DATASTORE: '' }), 'sqlite', 'an empty value (compose ${ALDINE_DATASTORE:-}) is the default');
eq(datastoreKind({ ALDINE_DATASTORE: 'json' }), 'json', 'json keeps the JSON files');
eq(datastoreKind({ ALDINE_DATASTORE: ' SQLite ' }), 'sqlite', 'case and spaces do not matter');
eq(datastoreKind({ DATABASE_URL: 'postgres://x' }), 'postgres', 'DATABASE_URL selects Postgres');
check((() => { try { datastoreKind({ ALDINE_DATASTORE: 'mysql' }); return false; } catch (err) { return err.message.includes('ALDINE_DATASTORE must be sqlite or json'); } })(), 'an unknown value is refused');
check((() => { try { datastoreKind({ ALDINE_DATASTORE: 'json', DATABASE_URL: 'postgres://x' }); return false; } catch (err) { return err.message.includes('both set'); } })(), 'so is a value beside DATABASE_URL');

// Going back to JSON after SQLite says what is not in the JSON files.
{
  const metaRoot = process.env.META_DIR;
  fs.mkdirSync(metaRoot, { recursive: true });
  const s = new SqliteStore(at(metaRoot, SQLITE_FILE));
  await s.init();
  await s.close();
  process.env.ALDINE_DATASTORE = 'json';
  const warned = await linesOf('warn', () => linesOf('log', () => initDb()));
  check(warned.some((l) => l.includes(`ALDINE_DATASTORE=json, so ${at(metaRoot, SQLITE_FILE)} is not used`)), `a JSON start beside aldine.db warns (got ${JSON.stringify(warned)})`);
  await closeDb();
  delete process.env.ALDINE_DATASTORE;
}

// ---- dist/db/snapshot.js: a live database, writes in the WAL included ----
{
  const root = freshDir();
  const live = new SqliteStore(at(root, SQLITE_FILE));
  await live.init();
  await live.createUser(ada);
  check(fs.statSync(at(root, `${SQLITE_FILE}-wal`)).size > 0, 'setup: the account is still in the write-ahead log');
  const out = at(freshDir(), 'copy.db');
  const tsx = fileURLToPath(import.meta.resolve('tsx/cli'));
  const r = spawnSync(process.execPath, [tsx, fileURLToPath(new URL('../src/db/snapshot.ts', import.meta.url)), out], {
    env: { ...process.env, META_DIR: root, DATA_DIR: at(root, 'data'), CACHE_DIR: at(root, 'cache') },
    encoding: 'utf8',
  });
  eq(r.status, 0, `snapshot exits 0 (stderr: ${r.stderr})`);
  check(!r.stderr.includes('ExperimentalWarning'), `and prints no ExperimentalWarning (stderr: ${r.stderr})`);
  eq(mode(out), 0o600, 'the copy is private');
  const copy = new SqliteStore(out);
  await copy.init();
  eq((await copy.getUser('ada')).email, ada.email, 'the copy holds the write that was only in the log');
  await copy.close();
  await live.close();
}

check(!warnings.some((w) => String(w.message).includes('SQLite')), `no warning about SQLite was emitted (got ${warnings.map((w) => w.message).join('; ')})`);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('✓ sqlite datastore: all passed');
