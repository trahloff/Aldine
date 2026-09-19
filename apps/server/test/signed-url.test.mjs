/**
 * Signed /output links, the parts output-signing.test.mjs cannot cover from
 * one process: ALDINE_SIGNING_SECRET takes precedence and writes no file; a
 * generated secret survives a restart (a second process with the same
 * META_DIR verifies the first one's link) and never lands under DATA_DIR; a
 * different META_DIR is a different signer. Plus the SECURITY.md risk #5
 * generalization guard on the live routes: `exp`/`sig` mean nothing anywhere
 * but GET /output, and `/output` itself never serves outside `.aldine-out`,
 * signature or not.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './assert.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-signed-url-'));
const DATA_DIR = path.join(tmp, 'data');
const META_DIR = path.join(tmp, 'meta');
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = DATA_DIR;
process.env.META_DIR = META_DIR;
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.ALDINE_SIGNING_SECRET = 'unit-test-signing-secret-do-not-reuse';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.ALDINE_PUBLIC_URL;

const signingTs = path.join(here, '..', 'src', 'output-signing.ts');
const { signOutputUrl, verifyOutputSignature } = await import(signingTs);
const q = (url) => Object.fromEntries(new URL(url, 'http://x').searchParams);

// ---- env secret: used, and no file is generated ----
const now = Date.UTC(2026, 8, 3, 12, 0, 0);
const envUrl = signOutputUrl({ projectId: 'p1', branch: 'main', path: '.aldine-out/main.pdf', now });
const envQ = q(envUrl);
check(verifyOutputSignature('p1', 'main', '.aldine-out/main.pdf', envQ.exp, envQ.sig, now) === 'ok', 'a link signed with the env secret verifies');
check(!fs.existsSync(path.join(META_DIR, 'output-signing-secret')), 'with ALDINE_SIGNING_SECRET set no secret file is generated');

// ---- generated secret: persisted in META_DIR, shared across restarts ----
// Each child is a fresh process (a "restart") with the env secret unset.
const tsxBin = path.join(here, '..', '..', '..', 'node_modules', '.bin', 'tsx');
const runChild = (script, env) => {
  const file = path.join(tmp, `child-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(file, script);
  const out = execFileSync(tsxBin, [file], {
    env: { ...process.env, ...env, ALDINE_SIGNING_SECRET: '' },
    encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').pop());
};
const importLine = `import { signOutputUrl, verifyOutputSignature } from ${JSON.stringify(signingTs)};`;
const signScript = `${importLine}
delete process.env.ALDINE_SIGNING_SECRET;
console.log(JSON.stringify({ url: signOutputUrl({ projectId: 'p1', branch: 'main', path: '.aldine-out/main.pdf', now: ${now} }) }));`;
const first = runChild(signScript, { META_DIR, DATA_DIR });
const genQ = q(first.url);
const secretFile = path.join(META_DIR, 'output-signing-secret');
check(fs.existsSync(secretFile), 'with no env secret a restart-safe secret is generated into META_DIR');
check((fs.statSync(secretFile).mode & 0o777) === 0o600, 'the generated secret file is 0600');
const walk = (d) => fs.existsSync(d)
  ? fs.readdirSync(d, { withFileTypes: true }).flatMap((f) => (f.isDirectory() ? walk(path.join(d, f.name)) : [path.join(d, f.name)]))
  : [];
check(walk(DATA_DIR).every((f) => !/signing/.test(f)), 'nothing signing-related is written under DATA_DIR (the compiler mounts it)');
check(fs.readdirSync(META_DIR).filter((f) => f.startsWith('output-signing-secret')).length === 1, 'the atomic publish leaves no temp file beside the secret');

// A short env secret is refused (a captured link would brute-force it offline).
const shortScript = `${importLine}
process.env.ALDINE_SIGNING_SECRET = 'aldine';
let error = null;
try { signOutputUrl({ projectId: 'p1', branch: 'main', path: '.aldine-out/main.pdf' }); } catch (err) { error = err.message; }
console.log(JSON.stringify({ error }));`;
const short = runChild(shortScript, { META_DIR: path.join(tmp, 'meta-short'), DATA_DIR });
check(short.error && /at least 32/.test(short.error), `a short ALDINE_SIGNING_SECRET throws instead of signing (got ${short.error})`);

// The stdio transport boots its own process: the same short secret must fail
// there at start, with the same message — not inside the first compile.
const stdioTs = path.join(here, '..', 'src', 'mcp', 'stdio.ts');
let stdioExit = null;
let stdioErr = '';
try {
  execFileSync(tsxBin, [stdioTs], {
    env: { ...process.env, META_DIR: path.join(tmp, 'meta-stdio'), DATA_DIR, ALDINE_SIGNING_SECRET: 'aldine', ALDINE_MCP_TOKEN: '' },
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000,
  });
  stdioExit = 0;
} catch (err) {
  stdioExit = err.status;
  stdioErr = String(err.stderr || '');
}
check(stdioExit === 1 && /at least 32/.test(stdioErr) && /aldine-mcp/.test(stdioErr), `the stdio MCP process refuses a short ALDINE_SIGNING_SECRET at boot (exit ${stdioExit}: ${stdioErr.trim().split('\n').pop()})`);

// A META_DIR whose filesystem has no hard links (SMB, some FUSE/9p mounts,
// vfat): publishing falls back to an exclusive create, which still cannot
// clobber a secret another node published first.
const noLink = `import fs from 'node:fs';
fs.linkSync = () => { throw Object.assign(new Error('EPERM: link not supported'), { code: 'EPERM' }); };
${importLine}
delete process.env.ALDINE_SIGNING_SECRET;
console.log(JSON.stringify({ url: signOutputUrl({ projectId: 'p1', branch: 'main', path: '.aldine-out/main.pdf', now: ${now} }) }));`;
const META_NOLINK = path.join(tmp, 'meta-nolink');
const nl1 = runChild(noLink, { META_DIR: META_NOLINK, DATA_DIR });
const nlFile = path.join(META_NOLINK, 'output-signing-secret');
check(fs.existsSync(nlFile) && (fs.statSync(nlFile).mode & 0o777) === 0o600, 'without link() the secret is still generated into META_DIR, 0600');
check(fs.readdirSync(META_NOLINK).filter((f) => f.startsWith('output-signing-secret')).length === 1, 'the fallback leaves no temp file either');
const nl2 = runChild(noLink, { META_DIR: META_NOLINK, DATA_DIR });
check(q(nl2.url).sig === q(nl1.url).sig, 'a second process without link() reads the published secret instead of replacing it');

const verifyScript = (metaDir) => `${importLine}
delete process.env.ALDINE_SIGNING_SECRET;
console.log(JSON.stringify({ status: verifyOutputSignature('p1', 'main', '.aldine-out/main.pdf', ${JSON.stringify(genQ.exp)}, ${JSON.stringify(genQ.sig)}, ${now}) }));`;
check(runChild(verifyScript(META_DIR), { META_DIR, DATA_DIR }).status === 'ok', 'a second process with the same META_DIR verifies the first one\'s link (the secret persisted)');
check(fs.readFileSync(secretFile, 'utf8').length > 40, 'the restart reused the file instead of rewriting it');
const otherMeta = path.join(tmp, 'meta-other');
check(runChild(verifyScript(otherMeta), { META_DIR: otherMeta, DATA_DIR }).status === 'invalid', 'a different META_DIR is a different signer');
check(verifyOutputSignature('p1', 'main', '.aldine-out/main.pdf', genQ.exp, genQ.sig, now) === 'invalid', 'the env-secret process rejects the generated-secret link');
check(genQ.sig !== envQ.sig && genQ.exp === envQ.exp, 'same inputs, different secret → different signature');

// ---- routes: the signature is honored on GET /output and nowhere else ----
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
const branch = store.branchDir(proj.id, 'main');
fs.mkdirSync(path.join(branch, '.aldine-out'), { recursive: true });
fs.writeFileSync(path.join(branch, '.aldine-out', 'main.pdf'), '%PDF-1.7\n%%EOF\n');
fs.writeFileSync(path.join(branch, 'main.tex'), '\\documentclass{article}\\begin{document}secret source\\end{document}\n');

const signed = signOutputUrl({ projectId: proj.id, branch: 'main', path: '.aldine-out/main.pdf' });
const sq = q(signed);
let res = await app.inject({ method: 'GET', url: signed });
check(res.statusCode === 200, `signed GET /output serves without a session (got ${res.statusCode})`);

// The same exp/sig pasted onto other routes: never an authorization.
const carry = `exp=${sq.exp}&sig=${sq.sig}`;
res = await app.inject({ method: 'GET', url: `/api/projects/${proj.id}/file?branch=main&path=main.tex&${carry}` });
check(res.statusCode === 401 && !/secret source/.test(res.body), `exp/sig on /file is not honored (got ${res.statusCode})`);
res = await app.inject({ method: 'GET', url: `/api/projects/${proj.id}?${carry}` });
check(res.statusCode === 401, `exp/sig on the project route is not honored (got ${res.statusCode})`);
res = await app.inject({ method: 'GET', url: `/api/projects/${proj.id}/files?branch=main&${carry}` });
check(res.statusCode === 401, `exp/sig on the file list is not honored (got ${res.statusCode})`);
res = await app.inject({ method: 'POST', url: `/api/projects/${proj.id}/compile?${carry}`, payload: { branch: 'main' } });
check(res.statusCode === 401, `exp/sig on compile is not honored (got ${res.statusCode})`);
res = await app.inject({ method: 'DELETE', url: `/api/projects/${proj.id}?${carry}` });
check(res.statusCode === 401 && (await store.readMeta(proj.id)).deletedAt == null, `exp/sig on delete is not honored and deletes nothing (got ${res.statusCode})`);

// /output with a genuinely signed non-output path is impossible to mint (the
// signer refuses), and a hand-built one is 403 before any file is read.
let threw = false;
try { signOutputUrl({ projectId: proj.id, branch: 'main', path: 'main.tex' }); } catch { threw = true; }
check(threw, 'the signer refuses to mint a link for a source file');
res = await app.inject({ method: 'GET', url: `/api/projects/${proj.id}/output?branch=main&path=main.tex&${carry}` });
check(res.statusCode === 403 && !/secret source/.test(res.body), `/output with a signed query for main.tex → 403, bytes never served (got ${res.statusCode})`);
res = await app.inject({ method: 'GET', url: `/api/projects/${proj.id}/output?branch=main&path=${encodeURIComponent('.aldine-out/../main.tex')}&${carry}` });
check(res.statusCode === 403 || res.statusCode === 400, `/output with a traversal path → refused (got ${res.statusCode})`);
res = await app.inject({ method: 'GET', url: `/api/projects/${proj.id}/output?branch=main&path=${encodeURIComponent('.aldine-out/main.pdf')}&exp=${sq.exp}&sig=` });
check(res.statusCode === 401 || res.statusCode === 403, `an empty sig does not fall through to anonymous access (got ${res.statusCode})`);

await app.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('signed URL: ALL PASSED');
process.exit(0);
