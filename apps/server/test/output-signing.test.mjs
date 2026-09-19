/**
 * Signed /output links (Phase 3 §3.1, SECURITY.md risk #5): the pure
 * sign/verify pair (valid, expired, tampered, wrong branch/project, path
 * outside .aldine-out), the generated secret's home (META_DIR, 0600, never
 * DATA_DIR), and the route with auth on — a signed link serves the PDF with
 * no cookie and answers CORS, an unsigned one still needs the session, and a
 * bad signature is refused instead of falling through to cookie auth.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-output-signing-'));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.ALDINE_SIGNING_SECRET;
delete process.env.ALDINE_PUBLIC_URL;

const { signOutputUrl, verifyOutputSignature, isOutputPath, OUTPUT_URL_TTL_S } = await import('../src/output-signing.ts');

// ---- pure sign/verify ----
const q = (url) => Object.fromEntries(new URL(url, 'http://x').searchParams);
const now = Date.UTC(2026, 8, 3, 12, 0, 0);
const url = signOutputUrl({ projectId: 'abcd1234', branch: 'main', path: '.aldine-out/main.pdf', t: 42, now });
check(url.startsWith('/api/projects/abcd1234/output?'), `signed URL targets /output only (got ${url})`);
let p = q(url);
check(p.branch === 'main' && p.path === '.aldine-out/main.pdf' && p.t === '42', 'signed URL keeps branch, path and the cache-buster');
check(Number(p.exp) === Math.floor(now / 1000) + OUTPUT_URL_TTL_S && OUTPUT_URL_TTL_S === 900, 'exp = now + 15 min');
check(/^[A-Za-z0-9_-]{43}$/.test(p.sig), 'sig is a base64url HMAC-SHA256');
check(verifyOutputSignature('abcd1234', 'main', '.aldine-out/main.pdf', p.exp, p.sig, now) === 'ok', 'valid link verifies');
check(verifyOutputSignature('abcd1234', 'main', '.aldine-out/main.pdf', p.exp, p.sig, now + (OUTPUT_URL_TTL_S + 1) * 1000) === 'expired', 'past exp → expired');
check(verifyOutputSignature('abcd1234', 'main', '.aldine-out/main.pdf', p.exp, p.sig, now + OUTPUT_URL_TTL_S * 1000) === 'ok', 'the exp second itself is still valid');
const flipped = (p.sig[0] === 'A' ? 'B' : 'A') + p.sig.slice(1);
check(verifyOutputSignature('abcd1234', 'main', '.aldine-out/main.pdf', p.exp, flipped, now) === 'invalid', 'tampered sig → invalid');
check(verifyOutputSignature('abcd1234', 'main', '.aldine-out/main.pdf', String(Number(p.exp) + 3600), p.sig, now) === 'invalid', 'extended exp → invalid (exp is signed)');
check(verifyOutputSignature('abcd1234', 'other', '.aldine-out/main.pdf', p.exp, p.sig, now) === 'invalid', 'wrong branch → invalid');
check(verifyOutputSignature('zzzz9999', 'main', '.aldine-out/main.pdf', p.exp, p.sig, now) === 'invalid', 'wrong project → invalid');
check(verifyOutputSignature('abcd1234', 'main', '.aldine-out/main.synctex.gz', p.exp, p.sig, now) === 'invalid', 'wrong artifact → invalid');
check(verifyOutputSignature('abcd1234', 'main', '.aldine-out/main.pdf', p.exp, p.sig.slice(0, 20), now) === 'invalid', 'short sig → invalid (no throw)');
check(verifyOutputSignature('abcd1234', 'main', '.aldine-out/main.pdf', 'soon', p.sig, now) === 'invalid', 'non-numeric exp → invalid');
check(verifyOutputSignature('abcd1234', 'main', '.aldine-out/main.pdf', undefined, undefined, now) === 'invalid', 'missing exp/sig → invalid');
check(verifyOutputSignature('abcd1234', 'main', 'main.tex', p.exp, p.sig, now) === 'invalid', 'a path outside .aldine-out never verifies');
let threw = false;
try { signOutputUrl({ projectId: 'abcd1234', branch: 'main', path: 'main.tex' }); } catch { threw = true; }
check(threw, 'the signer refuses to sign a path outside .aldine-out');
threw = false;
try { signOutputUrl({ projectId: 'abcd1234', branch: 'main', path: '.aldine-out/../main.tex' }); } catch { threw = true; }
check(threw, 'the signer refuses a .. path');
check(isOutputPath('paper/.aldine-out/main.pdf') && !isOutputPath('.aldine-out/sub/x.pdf') && !isOutputPath('.aldine-out'), 'isOutputPath is the route\'s .aldine-out rule');
check(signOutputUrl({ projectId: 'abcd1234', branch: 'main', path: '.aldine-out/main.pdf', base: 'https://aldine.example.com/' }).startsWith('https://aldine.example.com/api/projects/'), 'base makes the link absolute (trailing slash trimmed)');

// ---- secret lives in META_DIR, 0600, never under DATA_DIR ----
const secretFile = path.join(process.env.META_DIR, 'output-signing-secret');
check(fs.existsSync(secretFile), 'the generated secret is persisted in META_DIR');
check((fs.statSync(secretFile).mode & 0o777) === 0o600, 'secret file is 0600');
check(Buffer.from(fs.readFileSync(secretFile, 'utf8').trim(), 'base64url').length === 32, 'secret is 32 random bytes');
const underData = [];
const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const fp = path.join(d, f.name); if (f.isDirectory()) walk(fp); else if (f.name.includes('signing')) underData.push(fp); } };
if (fs.existsSync(process.env.DATA_DIR)) walk(process.env.DATA_DIR);
check(underData.length === 0, 'nothing signing-related under DATA_DIR');

// ---- route: auth on, signed link serves without a cookie ----
const { initDb } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const store = await import('../src/store.ts');
const gitops = await import('../src/gitops.ts');
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;
const app = Fastify();
await registerRoutes(app);

const user = await auth.register('ada@example.com', 'password123', 'Ada');
const proj = await store.createProject('Signed paper', {}, user.id);
await gitops.ensureWorktree(proj.id, 'main');
const outDir = path.join(store.branchDir(proj.id, 'main'), '.aldine-out');
fs.mkdirSync(outDir, { recursive: true });
const PDF = Buffer.from('%PDF-1.7\n% fake pdf for the signed route\n%%EOF\n');
fs.writeFileSync(path.join(outDir, 'main.pdf'), PDF);
fs.writeFileSync(path.join(store.branchDir(proj.id, 'main'), 'main.tex'), '\\documentclass{article}\\begin{document}x\\end{document}\n');

const signed = signOutputUrl({ projectId: proj.id, branch: 'main', path: '.aldine-out/main.pdf', t: 7 });
let res = await app.inject({ method: 'GET', url: signed });
check(res.statusCode === 200, `signed link → 200 with no cookie (got ${res.statusCode} ${res.body})`);
check(res.headers['content-type'].startsWith('application/pdf'), 'served as application/pdf');
check(res.headers['cache-control'] === 'no-store', 'no-store stays on signed responses');
check(res.headers['access-control-allow-origin'] === '*', 'signed responses answer CORS for the sandboxed viewer');
check(Buffer.compare(res.rawPayload, PDF) === 0, 'the PDF bytes are served');

const unsigned = `/api/projects/${proj.id}/output?branch=main&path=${encodeURIComponent('.aldine-out/main.pdf')}`;
res = await app.inject({ method: 'GET', url: unsigned });
check(res.statusCode === 401, `unsigned link without a session → 401 (got ${res.statusCode})`);
check(res.headers['access-control-allow-origin'] === undefined, 'no CORS header on the cookie path');

const sp = q(signed);
const withSig = (over) => `/api/projects/${over.project ?? proj.id}/output?${new URLSearchParams({ branch: over.branch ?? 'main', path: over.path ?? '.aldine-out/main.pdf', exp: over.exp ?? sp.exp, sig: over.sig ?? sp.sig })}`;
res = await app.inject({ method: 'GET', url: withSig({ sig: (sp.sig[0] === 'A' ? 'B' : 'A') + sp.sig.slice(1) }) });
check(res.statusCode === 403 && /invalid signature/.test(res.body), `tampered sig → 403 (got ${res.statusCode} ${res.body})`);
res = await app.inject({ method: 'GET', url: withSig({ exp: String(Math.floor(Date.now() / 1000) - 1) }) });
check(res.statusCode === 403, `re-dated exp → 403 (got ${res.statusCode})`);
const stale = signOutputUrl({ projectId: proj.id, branch: 'main', path: '.aldine-out/main.pdf', now: Date.now() - (OUTPUT_URL_TTL_S + 60) * 1000 });
res = await app.inject({ method: 'GET', url: stale });
check(res.statusCode === 403 && /expired/.test(res.body), `expired link → 403 naming expiry (got ${res.statusCode} ${res.body})`);
res = await app.inject({ method: 'GET', url: withSig({ branch: 'other' }) });
check(res.statusCode === 403, `signature for main used on another branch → 403 (got ${res.statusCode})`);
res = await app.inject({ method: 'GET', url: withSig({ path: 'main.tex' }) });
check(res.statusCode === 403, `signed query for a path outside .aldine-out → 403, never served (got ${res.statusCode})`);
res = await app.inject({ method: 'GET', url: withSig({ path: '.aldine-out/main.synctex.gz' }) });
check(res.statusCode === 403, `signature covers exactly one artifact (got ${res.statusCode})`);
res = await app.inject({ method: 'GET', url: withSig({ path: '.aldine-out/missing.pdf', sig: q(signOutputUrl({ projectId: proj.id, branch: 'main', path: '.aldine-out/missing.pdf' })).sig, exp: q(signOutputUrl({ projectId: proj.id, branch: 'main', path: '.aldine-out/missing.pdf' })).exp }) });
check(res.statusCode === 404, `a valid signature for a missing artifact → 404 (got ${res.statusCode})`);

// A signed-in browser with a tampered link is refused too — the bad
// signature must not fall through to the cookie.
const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'ada@example.com', password: 'password123' } });
const cookie = (login.headers['set-cookie'] || '').toString().split(';')[0];
check(login.statusCode === 200 && cookie, `login for the cookie path (got ${login.statusCode})`);
res = await app.inject({ method: 'GET', url: unsigned, headers: { cookie } });
check(res.statusCode === 200, `cookie path still serves the unsigned link (got ${res.statusCode})`);
res = await app.inject({ method: 'GET', url: withSig({ sig: (sp.sig[0] === 'A' ? 'B' : 'A') + sp.sig.slice(1) }), headers: { cookie } });
check(res.statusCode === 403, `a bad signature is refused even with a valid cookie (got ${res.statusCode})`);

// CORS preflight (pdf.js sends Range → not a simple request)
res = await app.inject({ method: 'OPTIONS', url: signed, headers: { origin: 'https://x.claudemcpcontent.com', 'access-control-request-method': 'GET', 'access-control-request-headers': 'range' } });
check(res.statusCode === 204 && res.headers['access-control-allow-origin'] === '*' && /range/i.test(res.headers['access-control-allow-headers']), `signed preflight → 204 with CORS headers (got ${res.statusCode})`);
res = await app.inject({ method: 'OPTIONS', url: unsigned });
check(res.statusCode === 401, `unsigned preflight is stopped by the session guard (got ${res.statusCode})`);

await app.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('output signing: ALL PASSED');
process.exit(0);
