/**
 * Display names are bounded where accounts are created: the sign-up form and
 * a first single sign-on alike keep at most NAME_MAX characters, without
 * control characters, and a name that is not text falls back to the email's
 * local part instead of failing the request.
 *
 * Runs against the real route table (Fastify inject) on a throwaway JSON
 * datastore; env is set before any src import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-name-'));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.RL_REGISTER_BURST = '50';
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

const signUp = (email, name) => app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'password123', name } });
const storedName = async (email) => (await db().findUserByEmail(email)).name;

eq(auth.NAME_MAX, 100, 'names keep at most 100 characters');

let res = await signUp('long@example.com', 'x'.repeat(900_000));
eq(res.statusCode, 200, 'an overlong name still signs up');
eq((await storedName('long@example.com')).length, auth.NAME_MAX, 'the stored name is cut to NAME_MAX');
eq(res.json().user.name.length, auth.NAME_MAX, 'the response carries the stored name');
const usersJson = fs.statSync(path.join(process.env.META_DIR, 'users.json')).size;
check(usersJson < 10_000, `users.json stays small (${usersJson} bytes)`);

res = await signUp('ctrl@example.com', '  A\u0000da\u0007 L\u007fovelace\n');
eq(await storedName('ctrl@example.com'), 'Ada Lovelace', 'control characters are dropped and the name trimmed');

res = await signUp('emoji@example.com', `${'a'.repeat(auth.NAME_MAX - 1)}\u{1F600}`);
eq(await storedName('emoji@example.com'), 'a'.repeat(auth.NAME_MAX - 1), 'a cut never leaves half a surrogate pair');

for (const [i, name] of [{ first: 'Ada' }, ['Ada'], 42, '   ', '\u0000\u0001'].entries()) {
  const email = `odd${i}@example.com`;
  res = await signUp(email, name);
  eq(res.statusCode, 200, `name ${JSON.stringify(name)} signs up`);
  eq(await storedName(email), `odd${i}`, `name ${JSON.stringify(name)} falls back to the email's local part`);
}

res = await signUp('plain@example.com', 'Grace Hopper');
eq(await storedName('plain@example.com'), 'Grace Hopper', 'an ordinary name is kept as typed');

// A first sign-in by single sign-on creates the account through the same path.
const sso = await auth.findOrCreateOAuth({ email: 'sso@example.com', name: `Linus\u001b ${'T'.repeat(5000)}`, subject: 'github:4242' }, 'github');
eq(sso.name.length, auth.NAME_MAX, "a provider profile's name is cut to NAME_MAX");
check(!sso.name.includes('\u001b'), "a provider profile's control characters are dropped");
const orcid = await auth.findOrCreateOAuth({ email: null, name: '', subject: 'orcid:0000-0002-1825-0097' }, 'orcid');
eq(orcid.name, 'orcid:0000-0002-1825-0097', 'an account without email or name is named by its subject');

console.log('register-name: all assertions passed');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
