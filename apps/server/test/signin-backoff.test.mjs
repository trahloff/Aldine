/**
 * Password sign-in backs off per account across every address: five failed
 * tries go ahead, then each further one waits 1, 2, 4 … seconds (at most 60)
 * and a throttled try answers 429 with Retry-After. A correct sign-in resets
 * the count. An email with no account behaves the same, so the answers never
 * say which exists. A browser that signed in to the account before carries a
 * signed device cookie, bound to the account's current password: it skips
 * the account's backoff (its own tries count on its own entry), stays under
 * the per-address limit, and a forged, borrowed or pre-reset entry counts for
 * nothing. Signing up issues no entry.
 *
 * The limiter alone with a fake clock, then the real route table (Fastify
 * inject); env is set before any src import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-backoff-'));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.RL_LOGIN_BURST = '3';
process.env.RL_REGISTER_BURST = '200';
for (const k of ['DATABASE_URL', 'REDIS_URL', 'SMTP_HOST', 'SES_FROM', 'ALDINE_SSO_ONLY', 'ALDINE_PUBLIC_URL', 'ALDINE_SIGNING_SECRET', 'ALDINE_PROTECTED_PROJECTS']) delete process.env[k];

const { BackoffLimiter } = await import('../src/ratelimit.ts');
const { initDb } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;

// ---- the limiter ----
const b = new BackoffLimiter('unit', 5, 60);
const free = [];
for (let i = 0; i < 5; i++) free.push(await b.attempt('k', 0));
eq(free, [0, 0, 0, 0, 0], 'five tries go ahead at once');
eq(await b.attempt('k', 0), 1000, 'the sixth waits a second after the fifth');
eq(await b.attempt('k', 400), 600, 'a throttled try is not counted and does not move the wait');
eq(await b.attempt('k', 1000), 0, 'after the wait it goes ahead');
eq(await b.attempt('k', 1000), 2000, 'then the wait doubles');
let t = 3000;
eq(await b.attempt('k', t), 0, 'after two seconds it goes ahead');
const waits = [];
for (let i = 0; i < 8; i++) {
  const w = await b.attempt('k', t);
  waits.push(w);
  t += w;
  eq(await b.attempt('k', t), 0, `the try after a ${w} ms wait goes ahead`);
}
eq(waits, [4000, 8000, 16000, 32000, 60000, 60000, 60000, 60000], 'the wait doubles up to 60 s');
eq(await b.attempt('other', t), 0, 'another key has its own count');
await b.clear('k');
eq(await b.attempt('k', t), 0, 'clear() resets the count');
const ttl = new BackoffLimiter('ttl', 1, 60, 10_000);
eq([await ttl.attempt('k', 0), await ttl.attempt('k', 0)], [0, 1000], 'one free try');
eq(await ttl.attempt('k', 10_001), 0, 'the count is forgotten after the TTL');
const race = new BackoffLimiter('race', 5, 60);
const parallel = await Promise.all(Array.from({ length: 12 }, () => race.attempt('k', 0)));
eq(parallel.filter((w) => w === 0).length, 5, 'parallel tries cannot share a free one');

// ---- through the sign-in route ----
const app = Fastify();
await registerRoutes(app);
await app.ready();

const cookies = (res) => [].concat(res.headers['set-cookie'] || []);
const deviceOf = (res) => cookies(res).map((c) => c.split(';')[0]).find((c) => c.startsWith(`${auth.DEVICE_COOKIE}=`));
let addr = 0;
const nextAddress = () => `198.51.100.${++addr}`;
const login = (email, password, { cookie, ip } = {}) => app.inject({
  method: 'POST', url: '/api/auth/login', remoteAddress: ip || nextAddress(),
  headers: cookie ? { cookie } : {}, payload: { email, password },
});
const register = (email) => app.inject({ method: 'POST', url: '/api/auth/register', remoteAddress: nextAddress(), payload: { email, password: 'right-password', name: 'x' } });
const statuses = async (n, email, password, opts) => { const out = []; for (let i = 0; i < n; i++) out.push((await login(email, password, opts)).statusCode); return out; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const adaReg = await register('ada@example.com');
eq(adaReg.statusCode, 200, 'sign-up');
eq(deviceOf(adaReg), undefined, 'a sign-up sets no device cookie');
const adaFirst = await login('ada@example.com', 'right-password');
const adaDevice = deviceOf(adaFirst);
check(adaDevice, 'a correct sign-in sets the device cookie');
const raw = cookies(adaFirst).find((c) => c.startsWith(`${auth.DEVICE_COOKIE}=`));
check(/HttpOnly/.test(raw) && /SameSite=Lax/.test(raw) && /Max-Age=31536000/.test(raw) && /Path=\//.test(raw), 'the device cookie is HttpOnly, Lax and lasts a year');

// someone who knows the address, from a new address each try
eq(await statuses(5, 'ada@example.com', 'guess'), [401, 401, 401, 401, 401], 'five wrong passwords from five addresses are answered');
const throttled = await login('ada@example.com', 'guess');
eq(throttled.statusCode, 429, 'the sixth is throttled, whatever its address');
eq(throttled.headers['retry-after'], '1', 'with Retry-After');
eq(throttled.json().error, 'Too many failed sign-ins to this account. Try again in 1 second.', 'and a sentence that says how long');
eq((await login('ada@example.com', 'right-password')).statusCode, 429, 'the right password from another browser waits too');

// an email without an account answers exactly the same
const ghost = await statuses(5, 'nobody@example.com', 'guess');
const ghostThrottled = await login('nobody@example.com', 'guess');
eq(ghost, [401, 401, 401, 401, 401], 'an unknown email gets the same five answers');
eq([ghostThrottled.statusCode, ghostThrottled.headers['retry-after'], ghostThrottled.json()], [429, '1', throttled.json()], 'and the same throttled answer');
eq((await login('nobody@example.com', 'guess')).json().error, throttled.json().error, 'word for word');

// the owner's browser is not slowed down, and its sign-in resets the count
const own = await login('ada@example.com', 'right-password', { cookie: adaDevice });
eq(own.statusCode, 200, 'the browser that signed in before goes straight in');
const adaDevice2 = deviceOf(own);
check(adaDevice2 && adaDevice2 !== adaDevice, 'and gets a fresh entry');
eq((await login('ada@example.com', 'guess')).statusCode, 401, 'its correct sign-in reset the account count');

// a forged, borrowed or garbled entry counts for nothing
await statuses(5, 'ada@example.com', 'guess');
const [name, value] = adaDevice2.split('=');
const forged = `${name}=${value.slice(0, -2)}${value.endsWith('AA') ? 'BB' : 'AA'}`;
eq((await login('ada@example.com', 'right-password', { cookie: forged })).statusCode, 429, 'an entry with a forged signature is no device');
await register('bea@example.com');
const beaDevice = deviceOf(await login('bea@example.com', 'right-password'));
eq((await login('ada@example.com', 'right-password', { cookie: beaDevice })).statusCode, 429, "another account's entry is no device for this one");
eq((await login('ada@example.com', 'right-password', { cookie: `${auth.DEVICE_COOKIE}=%E0%A4%A~..~x.y.z` })).statusCode, 429, 'a garbled cookie is ignored');

// one browser, two accounts: both entries kept
const both = await login('bea@example.com', 'right-password', { cookie: adaDevice2 });
eq(both.statusCode, 200, 'the same browser signs in to a second account');
const twoEntries = deviceOf(both);
eq(twoEntries.split('=')[1].split('~').length, 2, 'the cookie keeps an entry per account');
eq((await login('ada@example.com', 'right-password', { cookie: twoEntries })).statusCode, 200, 'the first account still knows the browser');

// the device's own tries back off on its own entry, and the per-address limit still holds
const deviceNow = deviceOf(await login('bea@example.com', 'right-password', { cookie: twoEntries }));
eq(await statuses(6, 'bea@example.com', 'mistyped', { cookie: deviceNow }), [401, 401, 401, 401, 401, 429], 'a known browser that keeps mistyping backs off too');
eq((await login('bea@example.com', 'right-password')).statusCode, 200, 'without touching the account count');
const ip = '203.0.113.50';
eq(await statuses(4, 'ada@example.com', 'right-password', { cookie: twoEntries, ip }), [200, 200, 200, 429], 'one address still gets RL_LOGIN_BURST tries');

// a password reset or change ends every entry issued before it
await register('dora@example.com');
const stockpile = deviceOf(await login('dora@example.com', 'right-password'));
const reset = await auth.requestReset('dora@example.com');
await auth.resetPassword(reset.token, 'reset-password');
await statuses(5, 'dora@example.com', 'guess');
eq((await login('dora@example.com', 'reset-password', { cookie: stockpile })).statusCode, 429, 'an entry minted before a reset no longer exempts the browser');
await sleep(1100);
const doraDevice = deviceOf(await login('dora@example.com', 'reset-password'));
const changer = await login('dora@example.com', 'reset-password', { cookie: doraDevice });
const session = cookies(changer).map((c) => c.split(';')[0]).find((c) => c.startsWith(`${auth.COOKIE}=`));
const change = await app.inject({
  method: 'POST', url: '/api/auth/password', remoteAddress: nextAddress(),
  headers: { cookie: `${session}; ${deviceOf(changer)}` }, payload: { currentPassword: 'reset-password', newPassword: 'changed-password' },
});
eq(change.statusCode, 200, 'password change');
const kept = deviceOf(change);
check(kept, 'the browser that changes the password gets a new entry');
await statuses(5, 'dora@example.com', 'guess');
eq((await login('dora@example.com', 'changed-password', { cookie: doraDevice })).statusCode, 429, 'an entry minted before a password change no longer exempts the browser');
eq((await login('dora@example.com', 'changed-password', { cookie: kept })).statusCode, 200, 'the entry from the change does');

// the wait passes; a correct sign-in then resets
await statuses(5, 'carl@example.com', 'guess');
await register('carl@example.com').then((r) => eq(r.statusCode, 200, 'an address tried before can still sign up'));
eq((await login('carl@example.com', 'right-password')).statusCode, 429, 'the address keeps the count it had without an account');
await sleep(1100);
eq((await login('carl@example.com', 'right-password')).statusCode, 200, 'after the wait the right password goes in');
eq(await statuses(5, 'carl@example.com', 'guess'), [401, 401, 401, 401, 401], 'and the count starts over');

await app.close();
console.log('signin-backoff: all assertions passed');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
