/**
 * A project dir that has lost its repo (deleted inside the autosave window)
 * must never let git find a checkout above the data dir. config.ts sets
 * GIT_CEILING_DIRECTORIES to the data dir; simple-git 4 strips ambient GIT_*
 * variables from its children unless they are allowed, and without it an
 * autosave committed a development worktree around .data-e2e (2026-11-26).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-git-ceiling-')));
const sh = (args, cwd) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
// an enclosing checkout, the way a development worktree holds .data-e2e
sh(['init', '-q', '-b', 'main'], tmp);
fs.writeFileSync(path.join(tmp, 'work.txt'), 'uncommitted work\n');
delete process.env.AUTH_ENABLED;
process.env.DATA_DIR = path.join(tmp, '.data');
process.env.META_DIR = path.join(tmp, '.meta');
process.env.CACHE_DIR = path.join(tmp, '.cache');
for (const k of ['DATABASE_URL', 'REDIS_URL']) delete process.env[k];

try {
  await import('../src/config.ts');
  const { git } = await import('../src/store.ts');
  const orphan = path.join(process.env.DATA_DIR, 'projects', 'lost');
  fs.mkdirSync(orphan, { recursive: true });
  fs.writeFileSync(path.join(orphan, 'main.tex'), 'x\n');

  let err = '';
  try { await git(orphan).raw(['add', '-A']); } catch (e) { err = String(e.message); }
  check(/not a git repository/i.test(err), `git in a dir without a repo stops at the data dir: ${err || 'it succeeded'}`);
  eq(sh(['status', '--porcelain'], tmp).includes('A '), false, 'and nothing was staged in the enclosing checkout');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('git-ceiling: ok');
process.exit(0);
