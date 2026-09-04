import { check } from './assert.mjs';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

/** A project must be named — the same rule on create as on rename. */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-name-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'secrets');
delete process.env.GITLAB_DEFAULT_GROUP;
delete process.env.GITLAB_TEMPLATE_GROUP;

const { initDb } = await import('../src/db/index.ts'); await initDb();
const Fastify = (await import('fastify')).default;
const { registerRoutes } = await import('../src/routes.ts');
const app = Fastify(); await registerRoutes(app);
const J = (r) => { try { return JSON.parse(r.body); } catch { return r.body; } };
const post = (payload) => app.inject({ method: 'POST', url: '/api/projects', payload });

// --- creation requires a name ---
for (const [label, payload] of [
  ['no body at all', {}],
  ['empty string', { name: '' }],
  ['only whitespace', { name: '   \n\t ' }],
  ['null', { name: null }],
]) {
  const r = await post(payload);
  check(r.statusCode === 400, `${label}: expected 400, got ${r.statusCode} ${r.body}`);
  check(/cannot be empty/.test(J(r).error || ''), `${label}: says a name is needed, got ${r.body}`);
}

const before = J(await app.inject({ url: '/api/projects' })).length;
await post({});
check(J(await app.inject({ url: '/api/projects' })).length === before, 'a rejected create leaves no project behind');

// --- a name that is too long is refused, at the same limit as rename ---
let r = await post({ name: 'x'.repeat(201) });
check(r.statusCode === 400 && /too long/.test(J(r).error || ''), 'over 200 characters is refused: ' + r.body);
r = await post({ name: 'x'.repeat(200) });
check(r.statusCode === 200, 'exactly 200 characters is allowed: ' + r.statusCode);

// --- a real name is trimmed, not stored with the user's stray spaces ---
r = await post({ name: '  Sensor Fusion  ' });
check(r.statusCode === 200, 'create: ' + r.body);
check(J(r).name === 'Sensor Fusion', 'the stored name is trimmed: ' + JSON.stringify(J(r).name));

// --- rename keeps the same rules ---
const id = J(r).id;
const patch = (payload) => app.inject({ method: 'PATCH', url: `/api/projects/${id}`, payload });
r = await patch({ name: '  ' });
check(r.statusCode === 400 && /cannot be empty/.test(J(r).error || ''), 'rename to blank is refused: ' + r.body);
r = await patch({ name: 'y'.repeat(201) });
check(r.statusCode === 400 && /too long/.test(J(r).error || ''), 'rename over the limit is refused: ' + r.body);
r = await patch({ name: '  Renamed  ' });
check(r.statusCode === 200 && J(r).name === 'Renamed', 'rename trims: ' + r.body);
// rootFile-only edits must not trip the name check
r = await patch({ rootFile: 'main.tex' });
check(r.statusCode === 200 && J(r).name === 'Renamed', 'an edit that omits name leaves it alone: ' + r.body);

// --- a ZIP import has no dialog to name it in, so it keeps its fallback ---
r = await app.inject({ method: 'POST', url: '/api/projects/import', payload: { zipBase64: '' } });
check(r.statusCode === 400 && /zipBase64/.test(J(r).error || ''), 'import still fails on its own missing field, not the name: ' + r.body);

await app.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('project-name: ALL PASSED');
