/**
 * POST /api/projects/:id/format: whoever may edit the project formats the
 * editor's text on the compile service; a viewer, a stranger and an access
 * token may not. Only the text, the indent and the extension reach the
 * compiler, and each refusal it reports comes back with a message that
 * names the cause.
 *
 * Real route table (Fastify inject) on a throwaway datastore, against
 * a stand-in compiler.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-format-route-')));
const seen = [];
let answer = (body) => ({ ok: true, text: body.text.replace(/^\\item/gm, '  \\item') });
const compiler = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    if (req.url !== '/format') { res.writeHead(404); res.end('{}'); return; }
    const body = JSON.parse(raw);
    seen.push(body);
    const out = JSON.stringify(answer(body));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(out);
  });
});
await new Promise((r) => compiler.listen(0, '127.0.0.1', r));

process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.COMPILER_URL = `http://127.0.0.1:${compiler.address().port}`;
process.env.RL_INVITE_BURST = '100';
for (const k of ['DATABASE_URL', 'REDIS_URL', 'SES_FROM', 'SMTP_HOST', 'ALDINE_PUBLIC_URL', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_BASE_PATH', 'ALDINE_TEST_HOOKS']) delete process.env[k];

const { initDb, db } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;
const app = Fastify();
await registerRoutes(app);
await app.ready();

const call = (url, who, payload, headers = {}) => app.inject({ method: 'POST', url, headers: { ...(who ? { cookie: who.cookie } : {}), ...headers }, payload });
async function person(email, name) {
  const user = await auth.register(email, 'password123', name);
  await db().setEmailPending(user.id, null);
  return { id: user.id, name, email, cookie: `${auth.COOKIE}=${await auth.createSession(user.id)}` };
}

try {
  const owner = await person('owner@example.com', 'Olive Owner');
  const editor = await person('ed@example.org', 'Ed Editor');
  const viewer = await person('vi@example.org', 'Vi Viewer');
  const stranger = await person('st@example.org', 'Stan Stranger');
  const P = (await call('/api/projects', owner, { name: 'Draft' })).json().id;
  await call(`/api/projects/${P}/share`, owner, { mode: 'private', collaborators: [editor.email], previous: [] });
  await call(`/api/projects/${P}/invitations`, owner, { to: viewer.email, role: 'view' });
  for (const who of [editor, viewer]) {
    const inv = (await app.inject({ method: 'GET', url: '/api/invitations', headers: { cookie: who.cookie } })).json().find((i) => i.project.id === P);
    await call(`/api/invitations/${inv.id}/accept`, who, {});
  }

  const url = `/api/projects/${P}/format`;
  const body = { branch: 'main', path: 'chapters/intro.tex', text: '\\begin{itemize}\n\\item a\n\\end{itemize}\n', indent: '  ' };

  let r = await call(url, owner, body);
  eq([r.statusCode, r.json()], [200, { ok: true, text: '\\begin{itemize}\n  \\item a\n\\end{itemize}\n' }], 'the owner formats');
  eq(seen.at(-1), { text: body.text, indent: '  ', ext: 'tex' }, 'the compiler gets the text, the indent and the extension, and no path');
  eq((await call(url, editor, { ...body, path: 'style/mine.STY' })).statusCode, 200, 'an editor formats a .sty');
  eq(seen.at(-1).ext, 'sty', 'the extension, lower case');

  const before = seen.length;
  r = await call(url, viewer, body);
  eq(r.statusCode, 403, 'a viewer cannot format');
  check(/view this project, not change it/.test(r.json().error), `the refusal says why (got ${r.body})`);
  eq((await call(url, stranger, body)).statusCode, 403, 'a stranger cannot format');
  eq((await call(url, null, body)).statusCode, 401, 'nobody signed in cannot format');
  const { token } = await auth.createAccessToken(owner.id, 'agent', [P], null);
  eq((await call(url, null, body, { authorization: `Bearer ${token}` })).statusCode, 403, 'an access token cannot format');
  eq(seen.length, before, 'none of them reached the compiler');

  eq((await call(url, owner, { ...body, path: 'refs.bib' })).json().error, 'Format document works on .tex, .sty and .cls files', 'a .bib is refused with the reason');
  eq((await call(url, owner, { ...body, indent: '\t\t' })).statusCode, 400, 'an indent that is no tab or 1–8 spaces is refused');
  eq(seen.length, before, 'none of those reached the compiler either');

  for (const [reason, status, message] of [
    ['unavailable', 503, /^latexindent isn’t available on this server/],
    ['too-large', 413, /^This file is too large to format \(boom\)\.$/],
    ['timeout', 422, /^Formatting took too long/],
    ['busy', 429, /busy/],
    ['failed', 422, /^latexindent couldn’t format this file: boom$/],
    ['changed-text', 422, /changed more than indentation/],
  ]) {
    answer = () => ({ ok: false, reason, error: 'boom' });
    r = await call(url, owner, body);
    eq([r.statusCode, r.json().reason], [status, reason], `${reason}: status and reason`);
    check(message.test(r.json().error), `${reason}: the message names the cause (got ${r.json().error})`);
  }
  answer = () => ({ ok: false, error: 'not found' });
  r = await call(url, owner, body);
  eq([r.statusCode, r.json().reason], [503, 'unavailable'], 'a compiler without /format counts as no latexindent');

  await new Promise((res) => compiler.close(res));
  r = await call(url, owner, body);
  eq(r.statusCode, 503, 'no compiler: unavailable');
  check(/typesetting service isn’t answering/.test(r.json().error), `the message says the service is down (got ${r.json().error})`);
  console.log('format-route: ok');
} finally {
  compiler.close();
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
