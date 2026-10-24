/**
 * envWithFallback: how a renamed setting keeps working within 1.x
 * (docs/STABILITY.md, "Deprecation"). The new name wins, the old one still
 * works, and each old name in use logs one warning per process naming both.
 *
 * Env must be set before the import — config.ts creates the data and meta
 * roots at module load.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-env-fallback-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');

const { envWithFallback } = await import('../src/config.ts');

const warnings = [];
console.warn = (...a) => warnings.push(a.join(' '));

eq(envWithFallback('ALDINE_NEW', ['PAPYR_OLD'], {}), undefined, 'neither name set');
eq(envWithFallback('ALDINE_NEW', ['PAPYR_OLD'], { ALDINE_NEW: 'a' }), 'a', 'the new name alone');
check(warnings.length === 0, `no warning while only the new name is used (got ${JSON.stringify(warnings)})`);

eq(envWithFallback('ALDINE_NEW', ['PAPYR_OLD'], { PAPYR_OLD: 'b' }), 'b', 'the old name alone still works');
check(warnings.length === 1 && /PAPYR_OLD is deprecated/.test(warnings[0]) && /rename it to ALDINE_NEW/.test(warnings[0]), `using the old name warns, naming both (got ${JSON.stringify(warnings)})`);
eq(envWithFallback('ALDINE_NEW', ['PAPYR_OLD'], { PAPYR_OLD: 'b' }), 'b', 'a second read');
check(warnings.length === 1, `one warning per old name per process (got ${warnings.length})`);

eq(envWithFallback('ALDINE_NEW', ['PAPYR_OLD'], { ALDINE_NEW: '', PAPYR_OLD: 'c' }), 'c', 'an empty new name (compose passes unset variables as empty) falls back');
eq(envWithFallback('ALDINE_NEW', ['PAPYR_OLD'], { ALDINE_NEW: 'a', PAPYR_OLD: '' }), 'a', 'an empty old name is unset');

warnings.length = 0;
eq(envWithFallback('ALDINE_OTHER', ['PAPYR_OTHER'], { ALDINE_OTHER: 'new', PAPYR_OTHER: 'old' }), 'new', 'with both set the new name wins');
check(warnings.length === 1 && /PAPYR_OTHER is set but ignored/.test(warnings[0]) && /ALDINE_OTHER replaces it/.test(warnings[0]), `and the old one is reported as ignored (got ${JSON.stringify(warnings)})`);

warnings.length = 0;
eq(envWithFallback('ALDINE_THIRD', ['OLDER_THIRD', 'OLDEST_THIRD'], { OLDEST_THIRD: 'z', OLDER_THIRD: 'y' }), 'y', 'of several old names the first set one wins');
check(warnings.length === 2, `each old name in use warns (got ${JSON.stringify(warnings)})`);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('envWithFallback: ALL PASSED');
