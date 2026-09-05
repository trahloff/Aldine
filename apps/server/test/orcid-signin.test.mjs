/**
 * ORCID sign-in: the provider exchange against a stub of orcid.org, and the
 * find-or-create rules for accounts that arrive with a subject but no email.
 *
 * Env must be set before any src import — AUTH_ENABLED and the data/meta
 * roots are read at module load.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { check, eq, throws } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-orcid-'));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

// A stub orcid.org: the token response carries the iD and name; the public
// API lists an email only for the researcher who made one public.
const PRIVATE = '0000-0002-1825-0097';
const PUBLIC = '0000-0001-5109-3700';
const stub = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (url.pathname === '/oauth/token') {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const form = new URLSearchParams(raw);
      if (form.get('client_id') !== 'cid' || form.get('client_secret') !== 'sec' || form.get('grant_type') !== 'authorization_code') return json(401, { error_description: 'bad client' });
      const code = form.get('code');
      if (code === 'private') return json(200, { access_token: 'tok', orcid: PRIVATE, name: 'Josiah Carberry', scope: '/authenticate' });
      if (code === 'public') return json(200, { access_token: 'tok', orcid: PUBLIC, name: 'Sofia Garcia', scope: '/authenticate' });
      if (code === 'noname') return json(200, { access_token: 'tok', orcid: PRIVATE, name: '' });
      return json(400, { error_description: 'invalid code' });
    });
    return;
  }
  if (url.pathname === `/v3.0/${PUBLIC}/email`) {
    return json(200, { email: [
      { email: 'old@example.org', verified: false, primary: false, visibility: 'public' },
      { email: 'Sofia.Garcia@example.org', verified: true, primary: true, visibility: 'public' },
    ] });
  }
  if (url.pathname.startsWith('/v3.0/')) return json(200, { email: [] });
  json(404, {});
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${stub.address().port}`;
process.env.ORCID_CLIENT_ID = 'cid';
process.env.ORCID_CLIENT_SECRET = 'sec';
process.env.ORCID_API_BASE = base;
process.env.ORCID_PUB_API_BASE = base;

const { initDb, db } = await import('../src/db/index.ts');
await initDb();
const oauth = await import('../src/oauth.ts');
const auth = await import('../src/auth.ts');

// ---- provider exchange ----
const orcid = oauth.getProvider('orcid');
check(orcid, 'orcid is a configured provider');
check(oauth.configuredProviders().some((p) => p.id === 'orcid'), 'orcid is listed for the sign-in page');
const authorize = new URL(orcid.authorizeUrl('st4te', 'https://app/cb'));
eq(authorize.origin + authorize.pathname, `${base}/oauth/authorize`, 'authorize URL follows ORCID_API_BASE');
eq(authorize.searchParams.get('scope'), '/authenticate', 'authenticate scope');
eq(authorize.searchParams.get('state'), 'st4te', 'state is passed through');

const priv = await orcid.exchange('private', 'https://app/cb');
eq(priv, { email: null, name: 'Josiah Carberry', subject: `orcid:${PRIVATE}` }, 'no public email → email null, subject set');
const pubProfile = await orcid.exchange('public', 'https://app/cb');
eq(pubProfile, { email: 'Sofia.Garcia@example.org', name: 'Sofia Garcia', subject: `orcid:${PUBLIC}` }, 'the verified primary public email is used');
eq((await orcid.exchange('noname', 'https://app/cb')).name, PRIVATE, 'a blank name falls back to the iD');
await throws(() => orcid.exchange('bogus', 'https://app/cb'), 'invalid code', 'token errors surface');

// ---- find-or-create ----
const first = await auth.findOrCreateOAuth(priv, 'orcid');
eq(first.email, null, 'email-less account created');
eq(first.orcid, PRIVATE, 'public user exposes the iD');
eq(first.name, 'Josiah Carberry', 'name from the token response');
const again = await auth.findOrCreateOAuth(priv, 'orcid');
eq(again.id, first.id, 'second sign-in finds the account by subject');
const other = await auth.findOrCreateOAuth({ email: null, name: 'Other', subject: 'orcid:0000-0003-0000-0001' }, 'orcid');
check(other.id !== first.id, 'a second email-less account does not collide');

// An email account created by the same provider before subjects existed is
// matched by email and bound to the subject.
const legacy = await auth.register('sofia.garcia@example.org', '', 'Sofia', 'orcid');
const merged = await auth.findOrCreateOAuth(pubProfile, 'orcid');
eq(merged.id, legacy.id, 'public email matches the existing orcid account');
eq((await db().getUser(legacy.id)).subject, `orcid:${PUBLIC}`, 'the subject is bound on that sign-in');
const bySubject = await auth.findOrCreateOAuth({ ...pubProfile, email: null }, 'orcid');
eq(bySubject.id, legacy.id, 'after binding, the account is found even if the email goes private');

// Never into a password account (pre-account hijack), and never across providers.
await auth.register('grace@example.org', 'password123', 'Grace');
await throws(
  () => auth.findOrCreateOAuth({ email: 'grace@example.org', name: 'G', subject: 'orcid:0000-0003-0000-0002' }, 'orcid'),
  'sign in with your password',
  'a password account with that email is not merged',
);
await throws(
  () => auth.findOrCreateOAuth({ email: 'sofia.garcia@example.org', name: 'S' }, 'github'),
  'sign in with orcid',
  'another provider with the same email is not merged',
);

// Email-only paths ignore email-less accounts.
await throws(() => auth.login('', 'x'), 'Incorrect email or password', 'login with an empty email fails closed');
check((await auth.requestReset('')) === null, 'reset with an empty email finds nothing');
await throws(() => auth.register(null, '', 'X'), 'Enter a valid email address', 'a null email needs a provider subject');

// Membership: an ORCID iD in the roster admits the email-less account.
const { isMember } = await import('../src/authz.ts');
const meta = { id: 'p', name: 'p', rootFile: 'main.tex', engine: 'pdf', createdAt: '', ownerId: 'owner', share: { mode: 'private', collaborators: [PRIVATE] } };
check(isMember(meta, first), 'ORCID iD in the roster grants membership');
check(!isMember(meta, other), 'a different iD does not');
check(!isMember({ ...meta, share: { mode: 'private', collaborators: [] } }, first), 'empty roster does not');

stub.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('ORCID sign-in: ALL PASSED');
