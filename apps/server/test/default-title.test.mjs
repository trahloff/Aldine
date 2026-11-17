/**
 * The starter main.tex (no template, no files) carries the project name in
 * \title; LaTeX specials in the name are escaped so the first typeset works
 * (issue #131).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-title-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
for (const k of ['DATABASE_URL', 'REDIS_URL']) delete process.env[k];

const { initDb } = await import('../src/db/index.ts');
await initDb();
const store = await import('../src/store.ts');

const cases = [
  ['Results_v2', 'Results\\_v2'],
  ['R&D notes', 'R\\&D notes'],
  ['50% draft', '50\\% draft'],
  ['{x}\\y #1 $5 ~a^b', '\\{x\\}\\textbackslash{}y \\#1 \\$5 \\textasciitilde{}a\\textasciicircum{}b'],
];
for (const [name, want] of cases) {
  const p = await store.createProject(name);
  const tex = store.readFile(p.id, 'main', 'main.tex').toString('utf8');
  const m = tex.match(/\\title\{(.*)\}\n/);
  check(!!m, `starter title for ${JSON.stringify(name)}`);
  eq(m?.[1], want, `escaped title for ${JSON.stringify(name)}`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('default-title: ok');
process.exit(0);
