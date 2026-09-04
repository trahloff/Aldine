/**
 * The templates:check gate — the reason it exists is that it fails. Each case
 * below is a template CI must refuse: no LICENSE file, no license or source
 * metadata, an unknown category, or a folder that is not a template at all.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { check } from './assert.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const script = path.join(repoRoot, 'scripts', 'check-templates.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-tplcheck-'));

const GOOD_META = {
  id: 'ok', name: 'Fine', description: 'A complete template.',
  license: 'MIT', licenseUrl: 'https://opensource.org/license/mit',
  source: { url: 'https://example.org/ok', version: '1.2.3' },
};

/** Writes one template folder and returns the dir holding it. */
function fixture(name, { meta = GOOD_META, license = 'MIT License\n', tex = '\\documentclass{article}\n' } = {}) {
  const dir = path.join(tmp, name);
  const base = path.join(dir, 'tpl');
  fs.mkdirSync(base, { recursive: true });
  if (meta !== null) fs.writeFileSync(path.join(base, 'template.json'), typeof meta === 'string' ? meta : JSON.stringify(meta));
  if (license !== null) fs.writeFileSync(path.join(base, 'LICENSE'), license);
  if (tex !== null) fs.writeFileSync(path.join(base, 'main.tex'), tex);
  return dir;
}

const run = (dir) => spawnSync(process.execPath, [script, dir], { encoding: 'utf8' });

const ok = run(fixture('good'));
check(ok.status === 0, `a complete template passes: ${ok.stderr}`);
check(ok.stdout.includes('1 template(s) checked'), 'the passing run says what it checked');

const cases = [
  ['no LICENSE file', fixture('no-license-file', { license: null }), 'no LICENSE file'],
  ['empty LICENSE file', fixture('empty-license', { license: '   \n' }), 'LICENSE file is empty'],
  ['no license field', fixture('no-license', { meta: { ...GOOD_META, license: undefined } }), 'needs a "license"'],
  ['no licenseUrl', fixture('no-license-url', { meta: { ...GOOD_META, licenseUrl: undefined } }), 'needs a "licenseUrl"'],
  ['licenseUrl is not a URL', fixture('bad-license-url', { meta: { ...GOOD_META, licenseUrl: 'see the file' } }), 'needs a "licenseUrl"'],
  ['no source', fixture('no-source', { meta: { ...GOOD_META, source: undefined } }), 'needs a "source"'],
  ['source without a version', fixture('no-version', { meta: { ...GOOD_META, source: { url: 'https://example.org/x' } } }), 'source.version'],
  ['source without a URL', fixture('no-source-url', { meta: { ...GOOD_META, source: { version: '1' } } }), 'source.url'],
  ['unknown category', fixture('bad-category', { meta: { ...GOOD_META, category: 'Posters' } }), 'is not one of'],
  ['no template.json', fixture('not-a-template', { meta: null }), 'no template.json'],
  ['broken template.json', fixture('broken-json', { meta: '{oops' }), 'not valid JSON'],
  ['no .tex file', fixture('no-tex', { tex: null }), 'nothing to start from'],
];

for (const [what, dir, message] of cases) {
  const res = run(dir);
  check(res.status === 1, `${what} fails the gate (exit ${res.status})`);
  check(res.stderr.includes(message), `${what} says why: expected "${message}", got "${res.stderr.trim()}"`);
}

const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-tplempty-'));
check(run(empty).status === 1, 'a templates directory with nothing in it fails');
check(run(path.join(tmp, 'does-not-exist')).status === 1, 'a missing templates directory fails');

// The repo's own templates must pass, or the gate is decoration.
const repoRun = run(path.join(repoRoot, 'templates'));
check(repoRun.status === 0, `the shipped templates pass the gate: ${repoRun.stderr}`);

fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(empty, { recursive: true, force: true });
console.log('templates:check: all checks passed');
