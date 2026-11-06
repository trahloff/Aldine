/**
 * Sign-in sessions extend with use (sessions.ts), through the real route
 * table on a fake clock:
 *  - a request more than a day after the last renewal gives the session 30
 *    days from then, the stored row and the cookie's Max-Age alike
 *  - at most one renewal a day, and only API requests renew
 *  - never past 90 days from the sign-in; after that the person signs in again
 *  - signing out, a password change and an administrator's disable still end
 *    a renewed session at once, and no later request brings it back
 *
 * The datastore conformance suite runs the same rule against every backend.
 * Env must be set before any src import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-session-renewal-'));
process.env.AUTH_ENABLED = '1';
process.env.ALDINE_ADMIN_EMAILS = 'root@example.org';
process.env.RL_REGISTER_BURST = '200';
process.env.RL_LOGIN_BURST = '200';
process.env.RL_ADMIN_BURST = '200';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
for (const k of ['DATABASE_URL', 'REDIS_URL', 'ALDINE_DATASTORE', 'SMTP_HOST', 'SES_FROM', 'ALDINE_PUBLIC_URL', 'ALDINE_SSO_ONLY', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_BASE_PATH']) delete process.env[k];

// Stopped, so a row's times can be compared with the clock exactly.
const realNow = Date.now;
const start = realNow();
let offset = 0;
Date.now = () => start + offset;
const DAY = 864e5;
const later = (ms) => { offset += ms; };

const { initDb, db } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;
const app = Fastify({ logger: false });
await registerRoutes(app);
await app.ready();

const call = (method, url, cookie, payload) => app.inject({ method, url, headers: cookie ? { cookie } : {}, ...(payload !== undefined ? { payload } : {}) });
/** The session cookies a response sets, in order: [value, Max-Age]. */
const setCookies = (res) => [].concat(res.headers['set-cookie'] || [])
  .filter((c) => c.startsWith(`${auth.COOKIE}=`))
  .map((c) => [c.split(';')[0].slice(auth.COOKIE.length + 1), Number(/Max-Age=(-?\d+)/.exec(c)?.[1])]);
const me = async (cookie) => (await call('GET', '/api/auth/me', cookie)).json().user;
async function signUp(email) {
  const res = await call('POST', '/api/auth/register', null, { email, password: 'password123', name: email.split('@')[0] });
  eq(res.statusCode, 200, `register ${email}`);
  await db().setEmailPending(res.json().user.id, null);
  const [[sid, maxAge]] = setCookies(res);
  return { id: res.json().user.id, sid, cookie: `${auth.COOKIE}=${sid}`, maxAge };
}

try {
  // ---- renewal ----
  const ada = await signUp('ada@example.org');
  const t0 = Date.now();
  eq(ada.maxAge, 30 * 86400, 'a sign-in lasts 30 days');
  eq((await db().getSession(ada.sid)).createdAt, t0, 'the session row keeps the sign-in time');

  later(DAY / 2);
  const early = await call('GET', '/api/auth/me', ada.cookie);
  eq(early.json().user?.id, ada.id, 'used on its first day, the session works');
  eq(setCookies(early), [], 'and is not renewed');
  eq((await db().getSession(ada.sid)).exp, t0 + 30 * DAY, 'the row keeps its expiry');

  later(DAY / 2 + 60_000);
  const t1 = Date.now();
  const renewed = await call('GET', '/api/auth/me', ada.cookie);
  eq(renewed.json().user?.id, ada.id, 'used more than a day after the sign-in, it works');
  eq(setCookies(renewed), [[ada.sid, 30 * 86400]], 'the response renews the same cookie for 30 days');
  eq((await db().getSession(ada.sid)).exp, t1 + 30 * DAY, 'and the row for 30 days from now');

  later(60_000);
  const writes = [];
  const renewSession = db().renewSession;
  db().renewSession = (...a) => { writes.push(a); return renewSession.apply(db(), a); };
  for (let i = 0; i < 20; i++) {
    later(30 * 60_000);
    eq(setCookies(await call('GET', '/api/projects', ada.cookie)), [], `request ${i + 1} later that day sets no cookie`);
  }
  eq(writes.length, 0, 'and writes no session row: one renewal a day');
  db().renewSession = renewSession;

  later(DAY);
  const page = await call('GET', '/some/app/page', ada.cookie);
  eq(setCookies(page), [], 'a request outside the API is not renewed');
  eq((await db().getSession(ada.sid)).exp, t1 + 30 * DAY, 'nor is the row');
  const t2 = Date.now();
  eq(setCookies(await call('GET', '/api/auth/me', ada.cookie)), [[ada.sid, 30 * 86400]], 'the next API request renews it');
  eq((await db().getSession(ada.sid)).exp, t2 + 30 * DAY, 'the row too');

  // ---- the 90-day cap ----
  let last = [];
  let lastAt = 0;
  while (Date.now() < t0 + 89 * DAY) {
    later(DAY + 60_000);
    const res = await call('GET', '/api/auth/me', ada.cookie);
    check(res.json().user?.id === ada.id, `used daily, the session still works on day ${Math.floor((Date.now() - t0) / DAY)}`);
    const set = setCookies(res);
    if (set.length) { last = set; lastAt = Date.now(); }
  }
  eq((await db().getSession(ada.sid)).exp, t0 + 90 * DAY, 'renewals stop at 90 days from the sign-in');
  eq(last, [[ada.sid, Math.floor((t0 + 90 * DAY - lastAt) / 1000)]], 'the last renewal sets the cookie to end there');
  check(last[0][1] < 30 * 86400, 'sooner than 30 days after it');
  later(t0 + 90 * DAY - Date.now() + 1000);
  eq(await me(ada.cookie), null, 'past 90 days from the sign-in, the person is signed out');
  eq(setCookies(await call('GET', '/api/auth/me', ada.cookie)), [], 'with no cookie to renew');

  // ---- signing out ----
  const bob = await signUp('bob@example.org');
  later(2 * DAY);
  eq(setCookies(await call('GET', '/api/auth/me', bob.cookie)).length, 1, 'setup: Bob\'s session was renewed');
  later(2 * DAY);
  const out = await call('POST', '/api/auth/logout', bob.cookie);
  const cookies = setCookies(out);
  eq(cookies.at(-1), ['', 0], 'signing out, due for renewal, ends with the cleared cookie');
  eq(await db().getSession(bob.sid), null, 'and removes the row');
  later(2 * DAY);
  eq(await me(bob.cookie), null, 'the old cookie is refused');
  eq(await db().getSession(bob.sid), null, 'and no later request brings the session back');

  // ---- a password change ----
  const cy = await signUp('cy@example.org');
  const cyOther = await auth.createSession(cy.id);
  later(2 * DAY);
  eq(setCookies(await call('GET', '/api/auth/me', cy.cookie)).length, 1, 'setup: Cy\'s first session was renewed');
  const changed = await call('POST', '/api/auth/password', `${auth.COOKIE}=${cyOther}`, { currentPassword: 'password123', newPassword: 'another-password' });
  eq(changed.statusCode, 200, 'Cy changes the password in another browser');
  eq(await me(cy.cookie), null, 'the renewed session ends at once');
  later(2 * DAY);
  eq(await me(cy.cookie), null, 'and stays ended');
  eq(await db().getSession(cy.sid), null, 'with no row');

  // ---- an administrator's disable ----
  const root = await signUp('root@example.org');
  const dee = await signUp('dee@example.org');
  later(2 * DAY);
  eq(setCookies(await call('GET', '/api/auth/me', dee.cookie)).length, 1, 'setup: Dee\'s session was renewed');
  later(2 * DAY);
  eq((await call('POST', `/api/admin/users/${dee.id}/disable`, root.cookie, {})).statusCode, 200, 'the administrator disables Dee');
  eq(await me(dee.cookie), null, 'Dee\'s renewed session ends at once');
  eq((await call('POST', `/api/admin/users/${dee.id}/enable`, root.cookie, {})).statusCode, 200, 'and enables her again');
  later(2 * DAY);
  eq(await me(dee.cookie), null, 'the session does not come back with the account');
  eq(await db().getSession(dee.sid), null, 'nor its row');
} finally {
  Date.now = realNow;
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('session renewal: ok');
