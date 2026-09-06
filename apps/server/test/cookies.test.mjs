/**
 * Cookie parsing must survive a Cookie header that is not valid
 * percent-encoding (#26): the browser sends every cookie on the host, so a
 * neighbouring app's `x=100%` used to throw URIError out of the onRequest
 * hook and turn every request into a 500 until the user cleared cookies.
 *
 * Env must be set before any src import — AUTH_ENABLED and the data/meta
 * roots are read at module load.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-cookies-'));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.ALDINE_PROTECTED_PROJECTS;

const { initDb } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;

// ---- parser ----
eq(auth.parseCookies(undefined), {}, 'no header parses to nothing');
eq(auth.parseCookies('a=1; b=hello%20world'), { a: '1', b: 'hello world' }, 'valid percent-encoding is decoded');
eq(auth.parseCookies('a=100%; b=2'), { a: '100%', b: '2' }, 'a bare % is kept raw and does not break its neighbours');
eq(auth.parseCookies('a=%E0%A4%A; aldine_session=sid'), { a: '%E0%A4%A', aldine_session: 'sid' }, 'a truncated escape is kept raw');
eq(auth.parseCookies('a=%zz'), { a: '%zz' }, 'non-hex escape is kept raw');
eq(auth.parseCookies('aldine_session=100%'), { aldine_session: '100%' }, 'the session cookie itself may be malformed');

// ---- end to end: the onRequest hook must not 500 ----
const app = Fastify();
await registerRoutes(app);

const user = await auth.register('ada@example.com', 'password123', 'Ada');
const sid = await auth.createSession(user.id);

const anon = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: 'foreign=100%' } });
eq(anon.statusCode, 200, 'a malformed foreign cookie does not 500');
eq(anon.json().user, null, 'and the request is treated as anonymous');

const withSession = await app.inject({
  method: 'GET',
  url: '/api/auth/me',
  headers: { cookie: `foreign=100%; aldine_session=${sid}; other=%E0%A4%A` },
});
eq(withSession.statusCode, 200, 'a valid session next to malformed cookies still works');
check(withSession.json().user?.id === user.id, 'and resolves to the signed-in user');

const badSid = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: 'aldine_session=100%' } });
eq(badSid.statusCode, 200, 'a malformed session cookie value does not 500');
eq(badSid.json().user, null, 'and simply fails session lookup');

await app.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('cookies: ok');
