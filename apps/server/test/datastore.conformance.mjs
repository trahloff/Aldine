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

  // touchUser writes only lastSeenAt: a concurrent password change must survive.
  check((await store.getUser(user.id)).lastSeenAt === undefined, `${label}: lastSeenAt absent by default`);
  await store.updateUser({ ...user, name: 'Ada L.', hash: 'h2' });
  await store.touchUser(user.id, '2026-09-10T10:00:00.000Z');
  const touched = await store.getUser(user.id);
  eq(touched.lastSeenAt, '2026-09-10T10:00:00.000Z', `${label}: touchUser sets lastSeenAt`);
  eq(touched.hash, 'h2', `${label}: touchUser leaves the rest of the row alone`);
  await store.touchUser(`missing-${t}`, '2026-09-10T10:00:00.000Z'); // no throw, no row
  check((await store.getUser(`missing-${t}`)) === null, `${label}: touchUser of a missing user creates nothing`);
  const listed = (await store.listUsers()).filter((u) => u.id === user.id);
  eq(listed, [touched], `${label}: listUsers includes lastSeenAt`);

  // ---- emailPending: a password sign-up's unconfirmed address ----
  check(touched.emailPending === undefined, `${label}: a user without the marker reads back without it (confirmed)`);
  const pending = { hash: 'a'.repeat(64), expiresAt: '2026-11-01T00:00:00.000Z' };
  const signup = { id: `u6-${t}`, email: `p-${t}@example.com`, name: 'Pat', salt: 's', hash: 'h', createdAt: new Date().toISOString(), emailPending: pending };
  await store.createUser(signup);
  eq(await store.getUser(signup.id), signup, `${label}: emailPending roundtrips through createUser/getUser`);
  eq((await store.findUserByEmail(signup.email)).emailPending, pending, `${label}: findUserByEmail carries emailPending`);
  eq((await store.listUsers()).find((u) => u.id === signup.id).emailPending, pending, `${label}: listUsers carries emailPending`);
  const next = { hash: 'b'.repeat(64), expiresAt: '2026-11-08T00:00:00.000Z' };
  await store.updateUser({ ...signup, hash: 'h2' });
  await store.setEmailPending(signup.id, next);
  const replaced = await store.getUser(signup.id);
  eq(replaced.emailPending, next, `${label}: setEmailPending replaces the link`);
  eq(replaced.hash, 'h2', `${label}: setEmailPending leaves the rest of the row alone`);
  await store.setEmailPending(signup.id, null);
  check((await store.getUser(signup.id)).emailPending === undefined, `${label}: setEmailPending(null) clears the marker`);
  await store.updateUser({ ...signup, emailPending: pending });
  eq((await store.getUser(signup.id)).emailPending, pending, `${label}: updateUser writes the marker`);
  const { emailPending: _drop, ...confirmed } = signup;
  await store.updateUser(confirmed);
  check((await store.getUser(signup.id)).emailPending === undefined, `${label}: updateUser without it clears the marker`);
  await store.setEmailPending(`missing-${t}`, pending); // no throw, no row
  check((await store.getUser(`missing-${t}`)) === null, `${label}: setEmailPending of a missing user creates nothing`);

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
  const touchedTok = await store.getToken(tok.id);
  eq(touchedTok.lastUsedAt, '2026-07-03T00:00:00.000Z', `${label}: touchToken sets lastUsedAt`);
  eq(touchedTok.revokedAt, '2026-07-02T00:00:00.000Z', `${label}: touchToken leaves revokedAt intact`);
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

  // ---- every credential of one user (password reset/change) ----
  const owner = `owner-${t}`, bystander = `bystander-${t}`;
  const uPat = { ...tok, id: `upat-${t}`, hash: `digest-upat-${t}`, userId: owner };
  const uOa = { ...oa1, id: `uoa-${t}`, hash: `digest-uoa-${t}`, userId: owner, family: `ufam-${t}` };
  const uDone = { ...tok, id: `udone-${t}`, hash: `digest-udone-${t}`, userId: owner, revokedAt: '2026-06-03T00:00:00.000Z' };
  const bPat = { ...tok, id: `bpat-${t}`, hash: `digest-bpat-${t}`, userId: bystander };
  for (const r of [uPat, uOa, uDone, bPat]) await store.createToken(r);
  const uRf = rf(20, { userId: owner, family: `ufam-${t}` });
  const uRfOrphan = rf(21, { userId: owner, family: `ufam2-${t}`, usedAt: '2026-07-05T00:00:00.000Z' });
  const bRf = rf(22, { userId: bystander, family: `bfam-${t}` });
  for (const r of [uRf, uRfOrphan, bRf]) await store.createRefresh(r);
  await store.revokeCredentialsForUser(owner, '2026-07-07T00:00:00.000Z');
  eq((await store.getToken(uPat.id)).revokedAt, '2026-07-07T00:00:00.000Z', `${label}: revokeCredentialsForUser revokes a hand-made token`);
  eq((await store.getToken(uOa.id)).revokedAt, '2026-07-07T00:00:00.000Z', `${label}: revokeCredentialsForUser revokes an OAuth token`);
  eq((await store.getToken(uDone.id)).revokedAt, '2026-06-03T00:00:00.000Z', `${label}: revokeCredentialsForUser keeps an earlier revokedAt`);
  eq((await store.getRefreshByHash(uRf.hash)).revokedAt, '2026-07-07T00:00:00.000Z', `${label}: revokeCredentialsForUser revokes a refresh token`);
  eq((await store.getRefreshByHash(uRfOrphan.hash)).revokedAt, '2026-07-07T00:00:00.000Z', `${label}: revokeCredentialsForUser revokes a refresh token with no listed access token`);
  eq((await store.getToken(bPat.id)).revokedAt, null, `${label}: revokeCredentialsForUser leaves another user's tokens alone`);
  eq((await store.getRefreshByHash(bRf.hash)).revokedAt, null, `${label}: revokeCredentialsForUser leaves another user's refresh tokens alone`);
  await store.revokeCredentialsForUser(`nobody-${t}`, '2026-07-07T00:00:00.000Z');
  check(true, `${label}: revokeCredentialsForUser for a user with no credentials is a no-op`);

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

  // ---- project visits (agent-review marks) ----
  const pv1 = `v1${t}`;
  const pv2 = `v2${t}`;
  const other = `u9-${t}`;
  check((await store.getProjectVisit(user.id, pv1, 'main')) === null, `${label}: unknown visit → null`);

  const visit = { userId: user.id, projectId: pv1, branch: 'main', head: 'a'.repeat(40), at: '2026-09-01T00:00:00.000Z', promptedHead: null };
  await store.setProjectVisit(visit);
  eq(await store.getProjectVisit(user.id, pv1, 'main'), visit, `${label}: visit roundtrip (promptedHead null)`);

  const prompted = { ...visit, head: 'b'.repeat(40), at: '2026-09-02T00:00:00.000Z', promptedHead: 'c'.repeat(40) };
  await store.setProjectVisit(prompted);
  eq(await store.getProjectVisit(user.id, pv1, 'main'), prompted, `${label}: setProjectVisit upserts in place`);

  // isolation: another user, another project, another branch each stand alone
  await store.setProjectVisit({ ...visit, userId: other });
  await store.setProjectVisit({ ...visit, projectId: pv2 });
  await store.setProjectVisit({ ...visit, branch: 'draft' });
  eq((await store.getProjectVisit(user.id, pv1, 'main')).head, prompted.head, `${label}: visit unaffected by neighbours`);
  eq((await store.getProjectVisit(other, pv1, 'main')).head, visit.head, `${label}: visit is per user`);
  eq((await store.getProjectVisit(user.id, pv2, 'main')).head, visit.head, `${label}: visit is per project`);
  eq((await store.getProjectVisit(user.id, pv1, 'draft')).head, visit.head, `${label}: visit is per branch`);

  const vAlias = await store.getProjectVisit(user.id, pv1, 'main');
  vAlias.head = 'TAMPERED';
  eq((await store.getProjectVisit(user.id, pv1, 'main')).head, prompted.head, `${label}: getProjectVisit result is a copy`);

  // id discipline: reads treat malformed ids as absent, writes refuse them
  check((await store.getProjectVisit(user.id, '../evil', 'main')) === null, `${label}: getProjectVisit bad id → null`);
  await throws(() => store.setProjectVisit({ ...visit, projectId: '../evil' }), 'bad project id', `${label}: setProjectVisit bad id throws`);
  await throws(() => store.deleteProjectVisits('../evil'), 'bad project id', `${label}: deleteProjectVisits bad id throws`);

  // purging a project takes every branch row of every user with it
  await store.deleteProjectVisits(pv1);
  check((await store.getProjectVisit(user.id, pv1, 'main')) === null, `${label}: deleteProjectVisits clears the owner's row`);
  check((await store.getProjectVisit(user.id, pv1, 'draft')) === null, `${label}: deleteProjectVisits clears every branch`);
  check((await store.getProjectVisit(other, pv1, 'main')) === null, `${label}: deleteProjectVisits clears every user`);
  check((await store.getProjectVisit(user.id, pv2, 'main')) !== null, `${label}: deleteProjectVisits leaves another project standing`);

  // ---- project list: opens ----
  const po1 = `o1${t}`;
  const po2 = `o2${t}`;
  eq(await store.listProjectOpens(user.id), [], `${label}: no opens → []`);
  check((await store.getProjectOpen(user.id, po1)) === null, `${label}: unknown open → null`);
  const opened = { userId: user.id, projectId: po1, at: '2026-10-01T00:00:00.000Z', branch: 'draft', hidden: false };
  await store.setProjectOpen(opened);
  eq(await store.getProjectOpen(user.id, po1), opened, `${label}: open roundtrip`);
  const hiddenOnly = { userId: user.id, projectId: po2, at: null, branch: null, hidden: true };
  await store.setProjectOpen(hiddenOnly);
  eq(await store.getProjectOpen(user.id, po2), hiddenOnly, `${label}: a removal without an open keeps at and branch null`);
  eq((await store.listProjectOpens(user.id)).sort((a, b) => a.projectId.localeCompare(b.projectId)), [opened, hiddenOnly], `${label}: listProjectOpens returns the user's rows`);
  await store.setProjectOpen({ ...opened, at: '2026-10-02T00:00:00.000Z', branch: 'main' });
  eq(await store.getProjectOpen(user.id, po1), { ...opened, at: '2026-10-02T00:00:00.000Z', branch: 'main' }, `${label}: setProjectOpen upserts in place`);
  await store.setProjectOpen(opened);

  await store.setProjectOpen({ ...opened, userId: other });
  eq(await store.listProjectOpens(other), [{ ...opened, userId: other }], `${label}: opens are per user`);
  const oAlias = await store.getProjectOpen(user.id, po1);
  oAlias.branch = 'TAMPERED';
  eq((await store.getProjectOpen(user.id, po1)).branch, 'draft', `${label}: getProjectOpen result is a copy`);

  await store.resetProjectOpenBranch(po1, 'draft');
  eq((await store.getProjectOpen(user.id, po1)).branch, 'main', `${label}: resetProjectOpenBranch moves an open of the deleted branch to main`);
  eq((await store.getProjectOpen(other, po1)).branch, 'main', `${label}: for every user`);
  eq((await store.getProjectOpen(user.id, po1)).at, opened.at, `${label}: and keeps when it was opened`);
  await store.setProjectOpen({ ...opened, branch: 'keep' });
  await store.resetProjectOpenBranch(po1, 'draft');
  eq((await store.getProjectOpen(user.id, po1)).branch, 'keep', `${label}: resetProjectOpenBranch leaves other branches alone`);

  check((await store.getProjectOpen(user.id, '../evil')) === null, `${label}: getProjectOpen bad id → null`);
  await throws(() => store.setProjectOpen({ ...opened, projectId: '../evil' }), 'bad project id', `${label}: setProjectOpen bad id throws`);
  await throws(() => store.deleteProjectOpens('../evil'), 'bad project id', `${label}: deleteProjectOpens bad id throws`);

  await store.deleteProjectOpen(user.id, po2);
  check((await store.getProjectOpen(user.id, po2)) === null, `${label}: deleteProjectOpen`);
  await store.deleteProjectOpen(user.id, po2); // no throw on a missing row
  await store.deleteProjectOpens(po1);
  check((await store.getProjectOpen(user.id, po1)) === null && (await store.getProjectOpen(other, po1)) === null, `${label}: deleteProjectOpens clears every user's row`);
  eq(await store.listProjectOpens(user.id), [], `${label}: nothing left for the user`);

  // ---- project list: activity ----
  const pa = `a1${t}`;
  const pb = `a2${t}`;
  const ours = (rows) => rows.filter((r) => r.projectId === pa || r.projectId === pb).sort((a, b) => a.projectId.localeCompare(b.projectId));
  eq(ours(await store.listProjectActivity()), [], `${label}: no activity yet`);
  const edit = { at: '2026-10-03T10:00:00.000Z', byId: user.id, byName: 'Ada', branch: 'main' };
  await store.setLastEdit(pa, edit);
  eq(ours(await store.listProjectActivity()), [{ projectId: pa, lastEdit: edit, compile: {} }], `${label}: setLastEdit creates the row`);
  await store.setLastEdit(pa, { ...edit, at: '2026-10-03T09:00:00.000Z', byName: 'Older' });
  eq(ours(await store.listProjectActivity())[0].lastEdit, edit, `${label}: an older last edit never replaces a newer one`);
  const newerEdit = { at: '2026-10-03T11:00:00.000Z', byId: null, byName: 'Claude', branch: 'draft' };
  await store.setLastEdit(pa, newerEdit);
  eq(ours(await store.listProjectActivity())[0].lastEdit, newerEdit, `${label}: a newer last edit replaces it, null id included`);

  const okMark = { status: 'ok', errors: 0, at: '2026-10-03T12:00:00.000Z' };
  const errMark = { status: 'error', errors: 3, at: '2026-10-03T12:05:00.000Z' };
  await store.setCompileMark(pa, 'main', okMark);
  await store.setCompileMark(pa, 'feature/x', errMark);
  eq(ours(await store.listProjectActivity())[0], { projectId: pa, lastEdit: newerEdit, compile: { main: okMark, 'feature/x': errMark } }, `${label}: compile marks per branch, beside the last edit`);
  await store.setCompileMark(pa, 'main', errMark);
  eq(ours(await store.listProjectActivity())[0].compile.main, errMark, `${label}: setCompileMark replaces the branch's mark`);
  await store.setCompileMark(pa, 'feature/x', null);
  eq(ours(await store.listProjectActivity())[0].compile, { main: errMark }, `${label}: null forgets one branch's mark`);
  await store.setCompileMark(pb, 'main', okMark);
  eq(ours(await store.listProjectActivity())[1], { projectId: pb, lastEdit: null, compile: { main: okMark } }, `${label}: a mark alone creates the row with no last edit`);
  await store.setCompileMark(`a3${t}`, 'main', null); // forgetting on a project with no row is a no-op
  check(!(await store.listProjectActivity()).some((r) => r.projectId === `a3${t}`), `${label}: forgetting creates no row`);
  const aAlias = ours(await store.listProjectActivity())[0];
  aAlias.compile.main.errors = 99;
  eq(ours(await store.listProjectActivity())[0].compile.main.errors, 3, `${label}: listProjectActivity result is a copy`);

  // Many at once, same rule per row: pa keeps its newer edit, pb gains one.
  const histEdit = { at: '2026-10-01T08:00:00.000Z', byId: null, byName: null, branch: 'main' };
  await store.setLastEdits([{ projectId: pa, lastEdit: histEdit }, { projectId: pb, lastEdit: histEdit }]);
  eq(ours(await store.listProjectActivity()).map((r) => r.lastEdit), [newerEdit, histEdit], `${label}: setLastEdits keeps the newer edit of each row`);
  eq(ours(await store.listProjectActivity())[1].compile, { main: okMark }, `${label}: setLastEdits leaves compile marks alone`);
  await throws(() => store.setLastEdits([{ projectId: pa, lastEdit: newerEdit }, { projectId: '../evil', lastEdit: edit }]), 'bad project id', `${label}: setLastEdits bad id throws`);
  await throws(() => store.setLastEdit('../evil', edit), 'bad project id', `${label}: setLastEdit bad id throws`);
  await throws(() => store.setCompileMark('../evil', 'main', okMark), 'bad project id', `${label}: setCompileMark bad id throws`);
  await throws(() => store.deleteProjectActivity('../evil'), 'bad project id', `${label}: deleteProjectActivity bad id throws`);
  await store.deleteProjectActivity(pa);
  eq(ours(await store.listProjectActivity()).map((r) => r.projectId), [pb], `${label}: deleteProjectActivity removes one project's row`);
  await store.deleteProjectActivity(pb);

  // ---- usage ----
  const month = '2026-08';
  eq(await store.getUsageSeconds(user.id, month), 0, `${label}: usage default 0`);
  await store.addUsageSeconds(user.id, month, 12.5);
  await store.addUsageSeconds(user.id, month, 7.5);
  eq(await store.getUsageSeconds(user.id, month), 20, `${label}: usage accumulates`);
  eq(await store.getUsageSeconds(user.id, '2026-09'), 0, `${label}: usage months isolated`);
  const before = await store.totalUsageSeconds(month);
  await store.addUsageSeconds(orcidUser.id, month, 5);
  eq((await store.totalUsageSeconds(month)) - before, 5, `${label}: totalUsageSeconds sums across users`);

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
