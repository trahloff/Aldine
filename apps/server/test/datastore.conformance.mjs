/**
 * DataStore conformance suite: the SAME assertions run against JsonStore and
 * PgStore, so the two backends can't silently diverge (id validation,
 * duplicate-email message, aliasing, ordering, usage math).
 *
 * JsonStore runs always (mkdtemp). PgStore runs only when TEST_DATABASE_URL
 * is set (CI provides a postgres service); otherwise that leg is skipped with
 * a log line, not a failure — local `npm run test:db` stays dependency-free.
 *
 * Data uses unique suffixes and relative assertions, so re-running against a
 * non-empty database is safe (no schema/truncate gymnastics needed).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { check, eq, throws } from './assert.mjs';

const uniq = () => crypto.randomBytes(6).toString('hex');

async function runSuite(store, label) {
  await store.init();
  const t = uniq();

  // ---- users ----
  const user = { id: `u1-${t}`, email: `a-${t}@example.com`, name: 'Ada', salt: 's', hash: 'h', createdAt: new Date().toISOString() };
  await store.createUser(user);
  eq(await store.getUser(user.id), user, `${label}: getUser roundtrip`);
  eq(await store.findUserByEmail(user.email), user, `${label}: findUserByEmail`);
  check((await store.getUser(`missing-${t}`)) === null, `${label}: getUser missing → null`);

  await throws(
    () => store.createUser({ ...user, id: `u2-${t}` }),
    'An account with that email already exists',
    `${label}: duplicate email message`,
  );

  // Mutating a returned row must not change the store (no aliasing).
  const alias = await store.getUser(user.id);
  alias.hash = 'TAMPERED';
  eq((await store.getUser(user.id)).hash, 'h', `${label}: getUser result is a copy`);

  // Mutating the object we passed in must not change the store either.
  user.name = 'TAMPERED';
  eq((await store.getUser(user.id)).name, 'Ada', `${label}: createUser stored a copy`);
  user.name = 'Ada';

  await store.updateUser({ ...user, name: 'Ada L.' });
  eq((await store.getUser(user.id)).name, 'Ada L.', `${label}: updateUser`);

  // ---- sessions ----
  const sid = `sid-${t}`;
  const exp = Date.now() + 60_000;
  await store.createSession(sid, user.id, exp);
  eq(await store.getSession(sid), { userId: user.id, exp }, `${label}: getSession`);
  await store.createSession(`sid2-${t}`, user.id, exp);
  await store.deleteSessionsForUser(user.id);
  check((await store.getSession(sid)) === null, `${label}: deleteSessionsForUser`);
  await store.createSession(sid, user.id, exp);
  await store.deleteSession(sid);
  check((await store.getSession(sid)) === null, `${label}: deleteSession`);

  // ---- resets ----
  const token = `tok-${t}`;
  await store.createReset(token, user.id, exp);
  eq(await store.getReset(token), { userId: user.id, exp }, `${label}: getReset`);
  await store.deleteReset(token);
  check((await store.getReset(token)) === null, `${label}: deleteReset`);

  // ---- personal access tokens ----
  const tok = { id: `pat1-${t}`, userId: user.id, name: 'Agent', hash: `digest-${t}`, projectIds: null, createdAt: '2026-01-01T00:00:00.000Z', lastUsedAt: null, expiresAt: null, revokedAt: null };
  const tok2 = { id: `pat2-${t}`, userId: user.id, name: 'Scoped', hash: `digest2-${t}`, projectIds: [`p1${t}`], createdAt: '2026-06-01T00:00:00.000Z', lastUsedAt: null, expiresAt: '2027-01-01T00:00:00.000Z', revokedAt: null };
  await store.createToken(tok);
  await store.createToken(tok2);
  eq(await store.getToken(tok.id), tok, `${label}: getToken roundtrip`);
  check((await store.getToken(`missing-${t}`)) === null, `${label}: getToken missing → null`);
  eq(await store.getTokenByHash(tok.hash), tok, `${label}: getTokenByHash`);
  eq(await store.getTokenByHash(tok2.hash), tok2, `${label}: getTokenByHash keeps projectIds/expiresAt`);
  check((await store.getTokenByHash(`missing-${t}`)) === null, `${label}: getTokenByHash missing → null`);

  const mine = (await store.listTokensForUser(user.id)).filter((x) => [tok.id, tok2.id].includes(x.id));
  eq(mine.map((x) => x.id), [tok2.id, tok.id], `${label}: listTokensForUser newest-first`);
  eq(await store.listTokensForUser(`nobody-${t}`), [], `${label}: listTokensForUser unknown user → []`);

  const tAlias = await store.getToken(tok.id);
  tAlias.hash = 'TAMPERED';
  eq((await store.getToken(tok.id)).hash, tok.hash, `${label}: getToken result is a copy`);

  await store.updateToken({ ...tok, lastUsedAt: '2026-07-01T00:00:00.000Z', revokedAt: '2026-07-02T00:00:00.000Z' });
  const revoked = await store.getToken(tok.id);
  eq(revoked.lastUsedAt, '2026-07-01T00:00:00.000Z', `${label}: updateToken lastUsedAt`);
  eq(revoked.revokedAt, '2026-07-02T00:00:00.000Z', `${label}: updateToken revokedAt`);

  await store.touchToken(tok.id, '2026-07-03T00:00:00.000Z');
  const touched = await store.getToken(tok.id);
  eq(touched.lastUsedAt, '2026-07-03T00:00:00.000Z', `${label}: touchToken sets lastUsedAt`);
  eq(touched.revokedAt, '2026-07-02T00:00:00.000Z', `${label}: touchToken leaves revokedAt intact`);
  await store.touchToken(`missing-${t}`, '2026-07-03T00:00:00.000Z');
  check((await store.getToken(`missing-${t}`)) === null, `${label}: touchToken on a missing id is a no-op`);

  // ---- project meta ----
  const older = { id: `p1${t}`, name: 'Older', rootFile: 'main.tex', engine: 'pdf', createdAt: '2026-01-01T00:00:00.000Z' };
  const newer = { id: `p2${t}`, name: 'Newer', rootFile: 'main.tex', engine: 'pdf', createdAt: '2026-06-01T00:00:00.000Z' };
  await store.writeMeta(older);
  await store.writeMeta(newer);
  eq(await store.readMeta(older.id), older, `${label}: readMeta roundtrip`);
  const list = await store.listMeta();
  const iNew = list.findIndex((m) => m.id === newer.id);
  const iOld = list.findIndex((m) => m.id === older.id);
  check(iNew !== -1 && iOld !== -1 && iNew < iOld, `${label}: listMeta newest-first`);

  // upsert
  await store.writeMeta({ ...older, name: 'Renamed' });
  eq((await store.readMeta(older.id)).name, 'Renamed', `${label}: writeMeta upserts`);

  // id discipline: reads treat malformed ids as absent, writes refuse them
  check((await store.readMeta('../evil')) === null, `${label}: readMeta bad id → null`);
  await throws(() => store.writeMeta({ ...older, id: '../evil' }), 'bad project id', `${label}: writeMeta bad id throws`);
  await throws(() => store.deleteMeta('../evil'), 'bad project id', `${label}: deleteMeta bad id throws`);

  await store.deleteMeta(older.id);
  check((await store.readMeta(older.id)) === null, `${label}: deleteMeta`);

  // ---- comments ----
  eq(await store.loadComments(newer.id), [], `${label}: loadComments default []`);
  eq(await store.loadComments('../evil'), [], `${label}: loadComments bad id → []`);
  const comments = [{ id: `c-${t}`, branch: 'main', file: 'main.tex', anchor: { from: 0, to: 3, quote: 'abc' }, author: 'Ada', body: 'hi', resolved: false, createdAt: new Date().toISOString(), replies: [] }];
  await store.saveComments(newer.id, comments);
  eq(await store.loadComments(newer.id), comments, `${label}: comments roundtrip`);
  await throws(() => store.saveComments('../evil', []), 'bad project id', `${label}: saveComments bad id throws`);

  // ---- usage ----
  const month = '2026-08';
  eq(await store.getUsageSeconds(user.id, month), 0, `${label}: usage default 0`);
  await store.addUsageSeconds(user.id, month, 12.5);
  await store.addUsageSeconds(user.id, month, 7.5);
  eq(await store.getUsageSeconds(user.id, month), 20, `${label}: usage accumulates`);
  eq(await store.getUsageSeconds(user.id, '2026-09'), 0, `${label}: usage months isolated`);

  // ---- connections ----
  check((await store.getConnection(user.id, 'github')) === null, `${label}: connection default null`);
  const conn = { token: 'secret', login: 'ada' };
  await store.setConnection(user.id, 'github', conn);
  eq(await store.getConnection(user.id, 'github'), conn, `${label}: connection roundtrip`);
  const cAlias = await store.getConnection(user.id, 'github');
  cAlias.token = 'TAMPERED';
  eq((await store.getConnection(user.id, 'github')).token, 'secret', `${label}: getConnection result is a copy`);
  await store.deleteConnection(user.id, 'github');
  check((await store.getConnection(user.id, 'github')) === null, `${label}: deleteConnection`);

  await store.close();
  console.log(`✓ ${label}: conformance suite passed`);
}

// ---- JSON leg (always) ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-db-'));
const { JsonStore } = await import('../src/db/json.ts');
await runSuite(new JsonStore(tmp), 'JsonStore');
fs.rmSync(tmp, { recursive: true, force: true });

// ---- Postgres leg (only with TEST_DATABASE_URL) ----
if (process.env.TEST_DATABASE_URL) {
  const { PgStore } = await import('../src/db/pg.ts');
  await runSuite(new PgStore(process.env.TEST_DATABASE_URL), 'PgStore');
} else {
  console.log('- PgStore: skipped (set TEST_DATABASE_URL to run the postgres leg)');
}

console.log('Datastore conformance: ALL PASSED');
