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

  // ---- accounts keyed by provider subject, with no email (ORCID) ----
  const orcidUser = { id: `u3-${t}`, email: null, name: 'Josiah', salt: 's', hash: '', createdAt: new Date().toISOString(), provider: 'orcid', subject: `orcid:${t}` };
  await store.createUser(orcidUser);
  eq(await store.getUser(orcidUser.id), orcidUser, `${label}: null-email user roundtrip`);
  eq(await store.findUserBySubject(orcidUser.subject), orcidUser, `${label}: findUserBySubject`);
  check((await store.findUserBySubject(`orcid:missing-${t}`)) === null, `${label}: findUserBySubject missing → null`);
  // Two email-less accounts must not collide on the (nullable) unique email.
  await store.createUser({ ...orcidUser, id: `u4-${t}`, subject: `orcid:other-${t}` });
  await throws(
    () => store.createUser({ ...orcidUser, id: `u5-${t}` }),
    'An account for that identity already exists',
    `${label}: duplicate subject message`,
  );
  // Binding a subject to an existing email account (first sign-in after the
  // provider started reporting one) is an update, not a new row.
  await store.updateUser({ ...user, name: 'Ada L.', subject: `github:${t}` });
  eq((await store.findUserBySubject(`github:${t}`)).id, user.id, `${label}: updateUser binds a subject`);

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
  const tok = { id: `pat1-${t}`, userId: user.id, name: 'Agent', hash: `digest-${t}`, projectIds: null, createdAt: '2026-01-01T00:00:00.000Z', lastUsedAt: null, expiresAt: null, revokedAt: null, clientName: null, family: null };
  const tok2 = { id: `pat2-${t}`, userId: user.id, name: 'Scoped', hash: `digest2-${t}`, projectIds: [`p1${t}`], createdAt: '2026-06-01T00:00:00.000Z', lastUsedAt: null, expiresAt: '2027-01-01T00:00:00.000Z', revokedAt: null, clientName: null, family: null };
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

  // ---- OAuth-minted tokens: clientName/family roundtrip + family revocation ----
  const fam = `fam-${t}`;
  const oa1 = { ...tok, id: `oa1-${t}`, name: 'Claude', hash: `digest-oa1-${t}`, clientName: 'Claude', family: fam, expiresAt: '2027-01-01T00:00:00.000Z', revokedAt: null };
  const oa2 = { ...oa1, id: `oa2-${t}`, hash: `digest-oa2-${t}`, createdAt: '2026-06-02T00:00:00.000Z' };
  const oa3 = { ...oa1, id: `oa3-${t}`, hash: `digest-oa3-${t}`, family: `other-${t}` };
  const oaDone = { ...oa1, id: `oa4-${t}`, hash: `digest-oa4-${t}`, revokedAt: '2026-06-03T00:00:00.000Z' };
  for (const r of [oa1, oa2, oa3, oaDone]) await store.createToken(r);
  eq(await store.getToken(oa1.id), oa1, `${label}: getToken keeps clientName and family`);
  eq((await store.getTokenByHash(oa1.hash)).family, fam, `${label}: getTokenByHash keeps family`);
  await store.revokeTokensInFamily(fam, '2026-07-04T00:00:00.000Z');
  eq((await store.getToken(oa1.id)).revokedAt, '2026-07-04T00:00:00.000Z', `${label}: revokeTokensInFamily revokes the first member`);
  eq((await store.getToken(oa2.id)).revokedAt, '2026-07-04T00:00:00.000Z', `${label}: revokeTokensInFamily revokes every member`);
  eq((await store.getToken(oa3.id)).revokedAt, null, `${label}: revokeTokensInFamily leaves other families alone`);
  eq((await store.getToken(tok2.id)).revokedAt, null, `${label}: revokeTokensInFamily leaves hand-made tokens alone`);
  eq((await store.getToken(oaDone.id)).revokedAt, '2026-06-03T00:00:00.000Z', `${label}: revokeTokensInFamily keeps an earlier revokedAt`);
  await store.revokeTokensInFamily(`missing-${t}`, '2026-07-04T00:00:00.000Z');
  check(true, `${label}: revokeTokensInFamily on an unknown family is a no-op`);
  // createToken prunes OAuth-minted records revoked for over a week (every
  // rotation leaves one behind); hand-made tokens keep their audit trail, and
  // an expired-but-unrevoked OAuth record stays: its refresh token may be
  // live and the record is the user's only revoke handle.
  const oaOldRevoked = { ...oa1, id: `oa5-${t}`, hash: `digest-oa5-${t}`, revokedAt: '2020-01-02T00:00:00.000Z' };
  const oaOldExpired = { ...oa1, id: `oa6-${t}`, hash: `digest-oa6-${t}`, expiresAt: '2020-01-01T00:00:00.000Z', revokedAt: null };
  const patOldRevoked = { ...tok, id: `pat3-${t}`, hash: `digest3-${t}`, revokedAt: '2020-01-02T00:00:00.000Z' };
  for (const r of [oaOldRevoked, oaOldExpired, patOldRevoked]) await store.createToken(r);
  await store.createToken({ ...oa1, id: `oa7-${t}`, hash: `digest-oa7-${t}` });
  check((await store.getToken(oaOldRevoked.id)) === null, `${label}: createToken prunes OAuth tokens revoked for over a week`);
  eq((await store.getToken(oaOldExpired.id)).revokedAt, null, `${label}: createToken keeps expired-but-unrevoked OAuth tokens`);
  check((await store.listTokensForUser(oaOldExpired.userId)).some((r) => r.id === oaOldExpired.id), `${label}: an expired-but-unrevoked OAuth token stays listed for the user`);
  eq((await store.getToken(patOldRevoked.id)).revokedAt, '2020-01-02T00:00:00.000Z', `${label}: createToken keeps revoked hand-made tokens`);
  check((await store.getToken(oa3.id)) !== null, `${label}: createToken keeps live OAuth tokens`);

  // ---- OAuth clients (dynamic registration) ----
  const baseline = await store.countOAuthClients();
  const cl = (n, lastUsedAt) => ({ id: `aldc_${n}-${t}`, name: `Client ${n}`, redirectUris: [`https://c${n}.example/cb`, 'http://127.0.0.1/cb'], createdAt: '2026-01-01T00:00:00.000Z', lastUsedAt });
  const c1 = cl(1, '2026-01-03T00:00:00.000Z');
  const c2 = cl(2, '2026-01-01T00:00:00.000Z');
  const c3 = cl(3, '2026-01-02T00:00:00.000Z');
  for (const c of [c1, c2, c3]) await store.createOAuthClient(c);
  eq(await store.getOAuthClient(c1.id), c1, `${label}: getOAuthClient roundtrip`);
  check((await store.getOAuthClient(`aldc_missing-${t}`)) === null, `${label}: getOAuthClient missing → null`);
  eq(await store.countOAuthClients(), baseline + 3, `${label}: countOAuthClients`);
  const clAlias = await store.getOAuthClient(c1.id);
  clAlias.redirectUris.push('https://evil.example/cb');
  eq((await store.getOAuthClient(c1.id)).redirectUris, c1.redirectUris, `${label}: getOAuthClient result is a copy`);
  c1.name = 'TAMPERED';
  eq((await store.getOAuthClient(c1.id)).name, 'Client 1', `${label}: createOAuthClient stored a copy`);
  c1.name = 'Client 1';
  await store.touchOAuthClient(c2.id, '2026-01-04T00:00:00.000Z');
  eq((await store.getOAuthClient(c2.id)).lastUsedAt, '2026-01-04T00:00:00.000Z', `${label}: touchOAuthClient sets lastUsedAt`);
  eq((await store.getOAuthClient(c2.id)).redirectUris, c2.redirectUris, `${label}: touchOAuthClient leaves the rest intact`);
  await store.touchOAuthClient(`aldc_missing-${t}`, '2026-01-04T00:00:00.000Z');
  check((await store.getOAuthClient(`aldc_missing-${t}`)) === null, `${label}: touchOAuthClient on a missing id is a no-op`);
  // Eviction order is lastUsedAt ascending: c3 (01-02) then c1 (01-03); c2 was just touched (01-04).
  // Clients left by earlier runs are older still, so evict them first and only then assert on ours.
  const stale = await store.countOAuthClients() - 3;
  if (stale > 0) eq(await store.evictOldestOAuthClients(stale), stale, `${label}: evictOldestOAuthClients reports the removed count`);
  eq(await store.evictOldestOAuthClients(0), 0, `${label}: evictOldestOAuthClients(0) is a no-op`);
  eq(await store.evictOldestOAuthClients(1), 1, `${label}: evictOldestOAuthClients(1) removes one`);
  check((await store.getOAuthClient(c3.id)) === null, `${label}: the least recently used client went first`);
  check((await store.getOAuthClient(c1.id)) !== null && (await store.getOAuthClient(c2.id)) !== null, `${label}: newer clients survive`);
  eq(await store.evictOldestOAuthClients(5), 2, `${label}: evictOldestOAuthClients caps at what exists`);
  eq(await store.countOAuthClients(), 0, `${label}: the client table is empty after eviction`);

  // ---- OAuth refresh tokens ----
  const rf = (n, over = {}) => ({ id: `rf${n}-${t}`, hash: `rhash${n}-${t}`, tokenId: `oa${n}-${t}`, userId: user.id, clientId: `aldc_1-${t}`, family: fam, projectIds: null, clientName: 'Claude', expiresAt: '2027-01-01T00:00:00.000Z', usedAt: null, revokedAt: null, ...over });
  const r1 = rf(1, { projectIds: [`p1${t}`] });
  const r2 = rf(2);
  const r3 = rf(3, { family: `other-${t}` });
  const rDone = rf(4, { revokedAt: '2026-06-03T00:00:00.000Z' });
  for (const r of [r1, r2, r3, rDone]) await store.createRefresh(r);
  eq(await store.getRefreshByHash(r1.hash), r1, `${label}: getRefreshByHash roundtrip (projectIds kept)`);
  eq(await store.getRefreshByHash(r2.hash), r2, `${label}: getRefreshByHash roundtrip (projectIds null)`);
  check((await store.getRefreshByHash(`missing-${t}`)) === null, `${label}: getRefreshByHash missing → null`);
  const rAlias = await store.getRefreshByHash(r1.hash);
  rAlias.projectIds.push('TAMPERED');
  eq((await store.getRefreshByHash(r1.hash)).projectIds, [`p1${t}`], `${label}: getRefreshByHash result is a copy`);
  eq(await store.markRefreshUsed(r1.id, '2026-07-05T00:00:00.000Z'), true, `${label}: markRefreshUsed wins on an unused record`);
  eq((await store.getRefreshByHash(r1.hash)).usedAt, '2026-07-05T00:00:00.000Z', `${label}: markRefreshUsed sets usedAt`);
  eq((await store.getRefreshByHash(r1.hash)).revokedAt, null, `${label}: markRefreshUsed leaves revokedAt alone`);
  // Compare-and-set: the second mark of one record loses and leaves the first timestamp.
  eq(await store.markRefreshUsed(r1.id, '2026-07-05T00:00:01.000Z'), false, `${label}: markRefreshUsed on a used record reports the loss`);
  eq((await store.getRefreshByHash(r1.hash)).usedAt, '2026-07-05T00:00:00.000Z', `${label}: a losing markRefreshUsed leaves usedAt alone`);
  eq(await store.markRefreshUsed(rDone.id, '2026-07-05T00:00:00.000Z'), false, `${label}: markRefreshUsed on a revoked record loses`);
  eq((await store.getRefreshByHash(rDone.hash)).usedAt, null, `${label}: a revoked record stays unused`);
  eq(await store.markRefreshUsed(`missing-${t}`, '2026-07-05T00:00:00.000Z'), false, `${label}: markRefreshUsed on a missing id loses`);
  await store.revokeRefreshFamily(fam, '2026-07-06T00:00:00.000Z');
  eq((await store.getRefreshByHash(r1.hash)).revokedAt, '2026-07-06T00:00:00.000Z', `${label}: revokeRefreshFamily revokes a used member`);
  eq((await store.getRefreshByHash(r2.hash)).revokedAt, '2026-07-06T00:00:00.000Z', `${label}: revokeRefreshFamily revokes an unused member`);
  eq((await store.getRefreshByHash(r3.hash)).revokedAt, null, `${label}: revokeRefreshFamily leaves other families alone`);
  eq((await store.getRefreshByHash(rDone.hash)).revokedAt, '2026-06-03T00:00:00.000Z', `${label}: revokeRefreshFamily keeps an earlier revokedAt`);
  // Long-expired refresh records are pruned opportunistically on create (7 days past expiry).
  const ancient = rf(9, { expiresAt: '2020-01-01T00:00:00.000Z' });
  await store.createRefresh(ancient);
  await store.createRefresh(rf(10, { family: `other-${t}` }));
  check((await store.getRefreshByHash(ancient.hash)) === null, `${label}: createRefresh prunes records expired for over a week`);
  check((await store.getRefreshByHash(r3.hash)) !== null, `${label}: createRefresh keeps unexpired records`);

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
