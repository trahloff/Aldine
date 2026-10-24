/**
 * Password hashing runs off the event loop, and the change-password route is
 * rate limited per account like sign-in: every attempt costs a scrypt call.
 *
 * Runs against the real route table (Fastify inject) on a throwaway JSON
 * datastore; env (the login burst included) is set before any src import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-pwhash-'));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.RL_LOGIN_BURST = '3';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.ALDINE_PROTECTED_PROJECTS;

const { initDb, db } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;

const app = Fastify();
await registerRoutes(app);

const ada = await auth.register('ada@example.com', 'password123', 'Ada');
const bob = await auth.register('bob@example.com', 'password123', 'Bob');

// ---- hashing yields to the event loop ----
// The datastore here is synchronous underneath, so a synchronous hash would
// finish all of these calls without a single timer callback running.
let ticks = 0;
const timer = setInterval(() => { ticks++; }, 1);
await auth.login('ada@example.com', 'password123');
await auth.login('ada@example.com', 'wrong-password').catch(() => {});
await auth.register('carol@example.com', 'password123', 'Carol');
clearInterval(timer);
check(ticks > 0, `timers run while passwords are hashed (got ${ticks} ticks)`);

// ---- existing hashes still verify ----
// A record hashed before the change (scrypt, N=16384, r=8, p=1, 64 bytes) signs in unchanged.
const crypto = await import('node:crypto');
const salt = crypto.randomBytes(16).toString('hex');
await db().createUser({ id: 'legacy1', email: 'legacy@example.com', name: 'Legacy', salt, hash: crypto.scryptSync('legacy-pass', salt, 64).toString('hex'), createdAt: new Date().toISOString() });
eq((await auth.login('legacy@example.com', 'legacy-pass')).id, 'legacy1', 'a password hashed synchronously before still signs in');

// ---- change-password limiter ----
const adaCookie = { cookie: `aldine_session=${await auth.createSession(ada.id)}` };
const bobCookie = { cookie: `aldine_session=${await auth.createSession(bob.id)}` };
const change = (headers, currentPassword) => app.inject({ method: 'POST', url: '/api/auth/password', headers, payload: { currentPassword, newPassword: 'another-pass-1' } });
for (let i = 0; i < 3; i++) eq((await change(adaCookie, 'wrong-password')).statusCode, 400, `wrong current password ${i + 1} is refused`);
let res = await change(adaCookie, 'wrong-password');
eq(res.statusCode, 429, 'attempts past the burst are rate limited');
res = await change(adaCookie, 'password123');
eq(res.statusCode, 429, 'the limit holds for a correct password too');
check((await auth.login('ada@example.com', 'password123')).id === ada.id, 'a rate-limited change leaves the password as it was');
res = await change(bobCookie, 'password123');
eq(res.statusCode, 200, "another account's change is not limited by this one's attempts");

console.log('password-hashing: all assertions passed');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
