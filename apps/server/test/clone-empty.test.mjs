/**
 * Importing a repository without commits fails with a reason a person can
 * act on, not git's "ambiguous argument 'HEAD'".
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { check } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-clone-empty-')));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
for (const k of ['AUTH_ENABLED', 'DATABASE_URL', 'REDIS_URL']) delete process.env[k];
const store = await import('../src/store.ts');
const gitops = await import('../src/gitops.ts');

const bare = path.join(tmp, 'empty.git');
execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bare]);
let err = null;
try { await gitops.cloneRepo('empty01', `file://${bare}`); } catch (e) { err = e; }
check(err instanceof gitops.EmptyRepositoryError, `an empty repository is refused as such (got ${err?.message})`);
fs.rmSync(store.repoDir('empty01'), { recursive: true, force: true });
fs.rmSync(tmp, { recursive: true, force: true });
console.log('clone-empty: ok');
