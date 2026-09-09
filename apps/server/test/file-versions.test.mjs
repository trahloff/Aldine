/**
 * Per-file conflict detection primitives in collab.ts: the branch
 * contentVersion stays the caller's base, but a write is refused only when
 * its own path changed after that base (or the base is newer than the branch
 * knows). Pins the invariants I1–I5 stated above the change log.
 *
 * Env must be set before the collab import: it reads the data/meta roots at
 * module load.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-file-versions-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

const { contentVersion, fileVersion, markPathsChanged, markTreeChanged, versionConflict } = await import('../src/collab.ts');

const P = 'proj-versions';
const B = 'main';

// fresh branch
check(contentVersion(P, B) === 0, 'fresh branch: contentVersion 0');
check(fileVersion(P, B, 'main.tex') === 0, 'fresh branch: fileVersion 0');
check(versionConflict(P, B, 'main.tex', 0) === null, 'fresh branch: no conflict at base 0');

// markPathsChanged bumps once for N paths
const v1 = markPathsChanged(P, B, ['a.tex', 'b.tex', 'c.tex']);
check(v1 === 1 && contentVersion(P, B) === 1, 'markPathsChanged bumps the branch version once for N paths');
check(fileVersion(P, B, 'a.tex') === 1 && fileVersion(P, B, 'b.tex') === 1 && fileVersion(P, B, 'c.tex') === 1, 'each listed path is stamped with the new version');

// untouched path = tree watermark
check(fileVersion(P, B, 'untouched.tex') === 0, 'fileVersion of an untouched path is the tree watermark (0 before any tree change)');

// base equal to contentVersion is accepted for a path changed earlier
markPathsChanged(P, B, ['b.tex']); // v2
check(contentVersion(P, B) === 2, 'second mark → version 2');
check(versionConflict(P, B, 'a.tex', 2) === null, 'a base equal to contentVersion is accepted for a path changed earlier');
check(versionConflict(P, B, 'a.tex', 1) === null, 'a base equal to the path\'s own version is accepted');

// path changed after the base conflicts
eq(versionConflict(P, B, 'b.tex', 1), { error: 'version_conflict', currentVersion: 2, fileVersion: 2 }, 'a path changed after the base conflicts with {currentVersion, fileVersion}');

// another path's change does not conflict
check(versionConflict(P, B, 'a.tex', 1) === null, 'a change to another path does not conflict');
check(versionConflict(P, B, 'untouched.tex', 0) === null, 'an untouched path never conflicts before a tree change');

// tree-wide mark
const vt = markTreeChanged(P, B);
check(vt === 3 && contentVersion(P, B) === 3, 'markTreeChanged bumps the branch version');
check(fileVersion(P, B, 'a.tex') === 3 && fileVersion(P, B, 'never-seen.tex') === 3, 'after a tree change every path, listed or not, reports the watermark');
eq(versionConflict(P, B, 'a.tex', 2), { error: 'version_conflict', currentVersion: 3, fileVersion: 3 }, 'markTreeChanged: a listed path conflicts with a base below it');
eq(versionConflict(P, B, 'never-seen.tex', 2), { error: 'version_conflict', currentVersion: 3, fileVersion: 3 }, 'markTreeChanged: an unlisted path conflicts with a base below it');
check(versionConflict(P, B, 'never-seen.tex', 3) === null, 'a base at the watermark is accepted');
// the paths map was cleared: a later path mark is the only entry above the watermark
markPathsChanged(P, B, ['d.tex']); // v4
check(fileVersion(P, B, 'a.tex') === 3 && fileVersion(P, B, 'd.tex') === 4, 'paths map cleared by the tree change: old entries fall back to the watermark, new ones are stamped');
check(versionConflict(P, B, 'a.tex', 3) === null && versionConflict(P, B, 'd.tex', 3) !== null, 'after the tree change only the newly marked path conflicts with the watermark base');

// base newer than the branch → conflict (restart / other node)
eq(versionConflict(P, B, 'a.tex', 5), { error: 'version_conflict', currentVersion: 4, fileVersion: 3 }, 'a base newer than the branch conflicts (restart / other node)');
eq(versionConflict(P, B, 'brand-new.tex', 999), { error: 'version_conflict', currentVersion: 4, fileVersion: 3 }, 'a base newer than the branch conflicts even for a never-seen path');

// path normalisation
markPathsChanged(P, B, ['./main.tex']); // v5
check(fileVersion(P, B, 'main.tex') === 5 && fileVersion(P, B, './main.tex') === 5, "'./main.tex' and 'main.tex' share one version");
markPathsChanged(P, B, ['sub//deep.tex']); // v6
check(fileVersion(P, B, 'sub/deep.tex') === 6, 'duplicate slashes fold onto one key');

// branches are independent
check(contentVersion(P, 'feature') === 0 && fileVersion(P, 'feature', 'main.tex') === 0, 'another branch has its own counters');

// I2: fileVersion never exceeds contentVersion
for (const p of ['a.tex', 'b.tex', 'd.tex', 'main.tex', 'sub/deep.tex', 'nope.tex']) {
  check(fileVersion(P, B, p) <= contentVersion(P, B), `I2: fileVersion(${p}) <= contentVersion`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('file versions: ALL PASSED');
process.exit(0);
